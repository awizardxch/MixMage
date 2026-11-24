'use strict';
const N = 16;
const KEYS = '1234qwerasdfzxcv';
const $ = (id) => document.getElementById(id);

let state = { sources: [], pads: Array(N).fill(null), midiMap: {}, midiActions: {} };
// Pads live in pages of N. A pad's index is global (page * N + slot); keys and MIDI notes address
// the slot on the page currently shown, and pads on other pages keep playing when you switch.
let page = 0;
let selected = 0;
let armed = false;
let learning = false;
let markIn = null;
let markOut = null;
let currentSource = null;
let recording = null; // { pad, start }
let previewStop = null;
let allPads = false; // when on, mode / volume / loop controls apply to every pad that has a clip
const FADE_IN = 0.004; // the shortest ramps, just enough to stop clicks
const FADE_OUT = 0.012;
// Blend: how long one clip takes to hand over to the next, like a playlist crossfade. The outgoing
// clip fades out over this time (sound and picture) while the incoming one fades in. 0 = hard cuts.
let blend = 0.25;
let lastStopAt = -10; // when a clip last began fading out, to know a tail is still sounding

const ctx = new AudioContext({ latencyHint: 'interactive' });
const master = ctx.createGain();
master.connect(ctx.destination);
// Per-pad runtime: decoded audio, its muted <video>, and the voice currently sounding.
const rt = [];
const syncRt = () => { while (rt.length < state.pads.length) rt.push({ buffer: null, video: null, voice: null, startedAt: 0 }); };
const liveOrder = []; // pads currently playing, most recent last
const busy = new Set(); // pads with a cut in progress
const heldNotes = new Map(); // MIDI note -> pad it triggered, so a release finds its pad after a page switch
const heldKeys = new Map(); // same for computer keys

const srcVideo = $('srcVideo');
const padEls = []; // the N on-screen pads, showing the current page
const pageCount = () => state.pads.length / N;
const pageOf = (i) => Math.floor(i / N);
const padEl = (i) => (pageOf(i) === page ? padEls[i % N] : null);
const pageSlots = (p) => Array.from({ length: N }, (_, s) => p * N + s);

// ---------- helpers ----------
const fmt = (t) => {
  if (t == null || !isFinite(t)) return '–';
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
};
const noteName = (n) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1);

let toastTimer;
function toast(msg) {
  const el = $('toast');
  console.info(`toast: ${msg}`);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.save(state), 200);
}

// ---------- MIDI mapping ----------
// Default: notes 36-51 (the usual pad range), lowest note at the bottom-left like an MPC.
function defaultPadForNote(n) {
  if (n < 36 || n >= 36 + N) return null;
  const k = n - 36;
  return (3 - Math.floor(k / 4)) * 4 + (k % 4);
}
function padForNote(n) {
  return n in state.midiMap ? state.midiMap[n] : defaultPadForNote(n);
}
function noteForPad(i) {
  const learned = Object.keys(state.midiMap).find((k) => state.midiMap[k] === i);
  if (learned != null) return Number(learned);
  for (let n = 36; n < 36 + N; n++) if (!(n in state.midiMap) && defaultPadForNote(n) === i) return n;
  return null;
}

// ---------- loop analysis ----------
// Finds a clean loop inside a clip: start on the first hit, run a whole number of beats (1, 2, 4, 8…)
// at the detected tempo, land the end on a hit when one is close, and put both ends on zero crossings
// so the wrap does not click. Falls back to the whole clip when no steady tempo is found.
function monoReader(buffer) {
  const a = buffer.getChannelData(0);
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
  return (k) => (a[k] + b[k]) / 2;
}

// Moves a time to the nearest rising zero crossing within 2 ms.
function zeroSnapper(buffer) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const mono = monoReader(buffer);
  return (t) => {
    const c = Math.min(n - 2, Math.max(1, Math.round(t * sr)));
    const reach = Math.round(0.002 * sr);
    for (let d = 0; d <= reach; d++) {
      for (const k of [c + d, c - d]) if (k >= 1 && k < n && mono(k - 1) <= 0 && mono(k) > 0) return k / sr;
    }
    return c / sr;
  };
}

// The tempo of a clip's source video, measured once over a minute of it and remembered. Two seconds of
// audio is too little to read a tempo from reliably, so clip loops use this instead of guessing.
const tempoJobs = new Map();
function sourceTempo(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return Promise.resolve(null);
  if (s.bpm) return Promise.resolve(s.bpm);
  if (s.bpmChecked) return Promise.resolve(null);
  if (!tempoJobs.has(id)) {
    tempoJobs.set(id, window.api.bpm({ file: s.file, duration: s.duration })
      .then((bpm) => { s.bpm = bpm || null; s.bpmChecked = true; save(); return s.bpm; })
      .catch(() => null));
  }
  return tempoJobs.get(id);
}

// Loop for a clip, stamped v2 (v1 loops guessed the tempo from the clip alone and are redone on load).
const loopFor = (buffer, hintBpm) => ({ ...analyzeLoop(buffer, hintBpm), v: 2 });

function analyzeLoop(buffer, hintBpm) {
  const sr = buffer.sampleRate;
  const n = buffer.length;
  const dur = buffer.duration;
  const mono = monoReader(buffer);
  const zsnap = zeroSnapper(buffer);
  const full = { start: 0, end: dur, bpm: null, beats: null, beatLen: null };

  const hop = 512;
  const fps = sr / hop;
  const frames = Math.floor(n / hop);
  if (frames < 40) return full;
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let k = f * hop, e = k + hop; k < e; k++) { const s = mono(k); sum += s * s; }
    env[f] = Math.log1p(100 * Math.sqrt(sum / hop));
  }
  const nov = new Float32Array(frames);
  for (let f = 0; f < frames; f++) nov[f] = Math.max(0, env[f] - (f ? env[f - 1] : 0));

  // Hits: local maxima of the onset curve above an adaptive threshold.
  const hits = [];
  for (let f = 0; f < frames; f++) {
    if (!nov[f]) continue;
    let mean = 0;
    let cnt = 0;
    let isMax = true;
    for (let k = Math.max(0, f - 40); k < Math.min(frames, f + 41); k++) {
      mean += nov[k];
      cnt++;
      if (Math.abs(k - f) <= 8 && (nov[k] > nov[f] || (nov[k] === nov[f] && k < f))) isMax = false;
    }
    if (isMax && nov[f] > 1.5 * (mean / cnt) + 0.02) hits.push(Math.max(0, (f * hop) / sr - 0.005));
  }

  // With the source video's tempo known, the beat length is fixed: start on the first hit if it is
  // close to the clip start, and run the largest power-of-two number of beats that fits.
  if (hintBpm) {
    const beatLen = 60 / hintBpm;
    const start = hits.length && hits[0] < beatLen * 0.5 ? hits[0] : 0;
    const fit = Math.floor((dur - start) / beatLen + 0.08);
    if (fit < 1) return { ...full, bpm: hintBpm, beatLen, fixed: true };
    return fitLoop(buffer, { start, beatLen, hits, fixed: true }, 2 ** Math.floor(Math.log2(fit)));
  }

  // No source tempo: strongest repeat period of the onset curve between 70 and 180 BPM, leaning toward 120.
  const ac = (lag) => {
    let s = 0;
    for (let f = lag; f < frames; f++) s += nov[f] * nov[f - lag];
    return s / (frames - lag);
  };
  const minLag = Math.round((fps * 60) / 180);
  const maxLag = Math.min(Math.round((fps * 60) / 70), Math.floor(frames / 2));
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const score = ac(lag) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.6) ** 2);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (!bestLag || ac(bestLag) < 0.1 * ac(0)) return { ...full, start: zsnap(0), end: zsnap(dur) };
  const y0 = ac(bestLag - 1);
  const y1 = ac(bestLag);
  const y2 = ac(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const lag = bestLag + (denom ? (0.5 * (y0 - y2)) / denom : 0); // sub-frame peak
  const beatLen = lag / fps;

  const start = hits.length && hits[0] < beatLen ? hits[0] : 0;
  const fit = Math.floor((dur - start) / beatLen + 0.05);
  if (fit < 1) return { ...full, bpm: 60 / beatLen, beatLen };
  const beats = 2 ** Math.floor(Math.log2(fit));
  return fitLoop(buffer, { start, beatLen, hits }, beats);
}

// Builds a loop of `beats` beats from a start point, tempo and hit list.
function fitLoop(buffer, { start, beatLen, hits, fixed }, beats) {
  const zsnap = zeroSnapper(buffer);
  let end = start + beats * beatLen;
  let near = null;
  for (const h of hits || []) if (Math.abs(h - end) < 0.12 * beatLen && (near == null || Math.abs(h - end) < Math.abs(near - end))) near = h;
  if (near != null) {
    end = near;
    // Without a source tempo, a hit at the loop end is a better tempo reading than the estimate.
    if (!fixed) beatLen = (end - start) / beats;
  }
  end = Math.min(end, buffer.duration);
  return { start: zsnap(start), end: zsnap(end), bpm: 60 / beatLen, beats, beatLen, hits, fixed: !!fixed };
}

// ---------- pads ----------
function buildPads() {
  const wrap = $('pads');
  for (let s = 0; s < N; s++) {
    const el = document.createElement('div');
    el.className = 'pad';
    el.innerHTML = '<span class="key"></span><span class="note"></span><span class="name"></span><span class="bar"></span>';
    let down = null;
    const up = () => { if (down != null) { release(down); down = null; } };
    el.addEventListener('mousedown', () => { down = page * N + s; select(down); trigger(down, 1); });
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
    // Drag a pad onto another pad to swap them, or onto a page tab to move it to that page.
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      const i = page * N + s;
      if (armed || busy.has(i) || !state.pads[i]) return e.preventDefault();
      down = null;
      stop(i); // the click that began the drag also triggered the pad
      dragFrom = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => { dragFrom = null; el.classList.remove('dragging'); for (const p of padEls) p.classList.remove('dropTarget'); });
    el.addEventListener('dragover', (e) => { if (dragFrom != null) { e.preventDefault(); el.classList.add('dropTarget'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dropTarget'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dropTarget');
      if (dragFrom != null) swapPads(dragFrom, page * N + s);
    });
    wrap.appendChild(el);
    padEls.push(el);
  }
}

// Draws one pad if it is on the page being shown (pads on other pages have no element).
function renderPad(i) {
  const el = padEl(i);
  if (!el) return;
  const s = i % N;
  const clip = state.pads[i];
  const note = noteForPad(s);
  el.querySelector('.key').textContent = KEYS[s].toUpperCase();
  el.querySelector('.note').textContent = note == null ? '' : noteName(note);
  el.querySelector('.name').textContent = clip ? clip.name : '';
  el.querySelector('.name').style.display = clip ? '' : 'none';
  el.style.backgroundImage = clip && clip.thumb ? `url("${clip.thumb}")` : '';
  el.classList.toggle('selected', i === selected);
  const sounding = !!rt[i].voice || rt[i].keys > 0;
  el.classList.toggle('playing', sounding);
  el.classList.toggle('recording', !!recording && recording.pad === i);
  el.classList.toggle('busy', busy.has(i));
  if (!sounding) el.querySelector('.bar').style.width = '0';
}
const renderPads = () => { syncVideos(); for (const i of pageSlots(page)) renderPad(i); renderPages(); };

// A pad only holds a <video> while it is on the page being shown or is playing; audio stays loaded for
// every pad. This keeps hundreds of clips from each tying up a media player.
function ensureVideo(i) {
  const r = rt[i];
  const clip = state.pads[i];
  if (!clip || r.video) return;
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.src = clip.url;
  $('viewer').appendChild(v);
  r.video = v;
}
function dropVideo(i) {
  const r = rt[i];
  if (r.video) { r.video.remove(); r.video = null; }
}
function syncVideos() {
  for (let i = 0; i < rt.length; i++) {
    // `pin` keeps a pad's video loaded off-page (set by scripted performances that cut faster than a video can load).
    if (state.pads[i] && (pageOf(i) === page || rt[i].voice || rt[i].pin)) ensureVideo(i); else dropVideo(i);
  }
}

// ---------- rearranging ----------
let dragFrom = null;

// Exchanges two pads (either may be empty). Clips, loaded audio and settings travel with the pad.
function swapPads(a, b) {
  if (a === b || busy.has(a) || busy.has(b)) return;
  stop(a);
  stop(b);
  [state.pads[a], state.pads[b]] = [state.pads[b], state.pads[a]];
  [rt[a], rt[b]] = [rt[b], rt[a]];
  save();
  select(b);
}

// Moves a pad to the first empty slot of another page.
function movePadToPage(a, p) {
  if (pageOf(a) === p) return;
  const free = pageSlots(p).find((i) => !state.pads[i]);
  if (free == null) return toast(`Page ${p + 1} is full.`);
  const from = page;
  swapPads(a, free);
  select(from * N + (a % N)); // stay on the page you were arranging
}

// ---------- pages ----------
function renderPages() {
  const tabs = $('pageTabs');
  tabs.innerHTML = '';
  for (let p = 0; p < pageCount(); p++) {
    const n = pageSlots(p).filter((i) => state.pads[i]).length;
    const b = document.createElement('button');
    b.textContent = String(p + 1);
    b.title = `Page ${p + 1}: ${n} clip${n === 1 ? '' : 's'}`;
    b.className = `tab${p === page ? ' on' : ''}${n ? '' : ' blank'}${pageSlots(p).some((i) => rt[i].voice) ? ' sounding' : ''}`;
    b.addEventListener('click', () => setPage(p));
    b.addEventListener('dragover', (e) => { if (dragFrom != null && p !== page) { e.preventDefault(); b.classList.add('dropTarget'); } });
    b.addEventListener('dragleave', () => b.classList.remove('dropTarget'));
    b.addEventListener('drop', (e) => { e.preventDefault(); if (dragFrom != null) movePadToPage(dragFrom, p); });
    tabs.appendChild(b);
  }
  $('removePageBtn').disabled = pageCount() < 2;
}

function setPage(p) {
  p = Math.max(0, Math.min(pageCount() - 1, p));
  if (p !== page) select(p * N + (selected % N));
}

function addPage() {
  state.pads.push(...Array(N).fill(null));
  syncRt();
  save();
  setPage(pageCount() - 1);
}

function removePage() {
  if (pageCount() < 2) return;
  const from = page * N;
  const clips = state.pads.slice(from, from + N).filter(Boolean);
  if (clips.length && !confirm(`Remove page ${page + 1} and delete its ${clips.length} clip${clips.length === 1 ? '' : 's'}?`)) return;
  // Later pages shift down, so drop everything that remembers a pad by index first.
  stopAll();
  recording = null;
  heldNotes.clear();
  heldKeys.clear();
  busy.clear();
  for (const r of rt.slice(from, from + N)) if (r.video) r.video.remove();
  state.pads.splice(from, N);
  rt.splice(from, N);
  save();
  page = Math.min(page, pageCount() - 1);
  select(page * N + (selected % N));
  for (const c of clips) window.api.removeClip(c.id);
}

function select(i) {
  selected = i;
  page = pageOf(i);
  renderPads();
  const clip = state.pads[i];
  $('selPadLabel').textContent = `Page ${page + 1} · Pad ${KEYS[i % N].toUpperCase()}`;
  $('padName').value = clip ? clip.name : '';
  $('padMode').value = clip ? clip.mode : 'gate';
  $('padGain').value = clip ? clip.gain : 1;
  for (const id of ['padName', 'clearBtn']) $(id).disabled = !clip;
  for (const id of ['padMode', 'padGain', 'padPitch']) $(id).disabled = !targets().length;
  renderPitch();
  renderLoop();
}

function renderPitch() {
  const clip = state.pads[selected];
  const st = clip ? clip.pitch || 0 : 0;
  $('padPitch').value = st;
  $('pitchLabel').textContent = `${st > 0 ? '+' : ''}${Number.isInteger(st) ? st : st.toFixed(2)} st · ${Math.round(2 ** (st / 12) * 100)}%`;
}

// Sets the pitch (in semitones) of the target pads; a pad that is sounding changes as you move the slider.
function setPitch(st) {
  for (const i of targets()) {
    const clip = state.pads[i];
    clip.pitch = st;
    const r = rt[i];
    if (r.voice && r.voice.src) {
      const rate = padRate(clip);
      r.voice.src.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.01);
      if (r.video) r.video.playbackRate = clampRate(rate);
      r.rate = rate;
    }
  }
  save();
  renderPitch();
  renderWave();
}

// The pads a settings change applies to: the selected pad, or every loaded pad when "All pads" is on.
function targets() {
  if (!allPads) return state.pads[selected] ? [selected] : [];
  return state.pads.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
}

function setAllPads(on) {
  allPads = on;
  $('allBtn').classList.toggle('on', on);
  document.body.classList.toggle('allPads', on);
  select(selected);
}

function renderLoop() {
  const clip = state.pads[selected];
  const lp = clip && clip.loop;
  const ready = targets().some((i) => state.pads[i].loop && rt[i].buffer);
  for (const id of ['autoLoopBtn', 'halfBtn', 'doubleBtn', 'fullLoopBtn']) $(id).disabled = !ready;
  if (!clip) $('loopLabel').textContent = '';
  else if (!lp) $('loopLabel').textContent = 'No audio to analyze';
  else {
    const len = `${(lp.end - lp.start).toFixed(2)} s`;
    $('loopLabel').textContent = lp.beats
      ? `${lp.beats} beat${lp.beats === 1 ? '' : 's'} · ${lp.bpm.toFixed(1)} BPM · ${len}`
      : `${lp.bpm ? `${lp.bpm.toFixed(1)} BPM · ` : 'No steady beat found · '}${len}`;
  }
  renderWave();
}

// Applies a new loop to the selected pad and restarts it so the change is heard at once.
// Applies a new loop to a pad. A playing pad restarts so the change is heard at once;
// `audition` also starts a pad that was silent (used for single-pad Auto loop).
function setLoop(i, lp, forceLoopMode, audition) {
  const clip = state.pads[i];
  if (!clip || !lp) return;
  const wasPlaying = !!rt[i].voice;
  stop(i, true);
  clip.loop = { ...lp, v: 2 };
  if (forceLoopMode) clip.mode = 'loop';
  save();
  if (i === selected) select(selected);
  if (wasPlaying || audition) play(i, 1);
}

function scaleLoop(i, factor, quiet) {
  const clip = state.pads[i];
  const buf = rt[i].buffer;
  if (!clip || !clip.loop || !buf) return;
  const lp = clip.loop;
  const tooShort = () => { if (!quiet) toast('The clip is not long enough for a longer loop.'); };
  if (lp.beats && lp.beatLen) {
    const beats = lp.beats * factor;
    if (beats < 0.25) return;
    if (lp.start + beats * lp.beatLen > buf.duration + 0.03) return tooShort();
    return setLoop(i, fitLoop(buf, lp, beats));
  }
  const len = (lp.end - lp.start) * factor;
  if (len < 0.05 || lp.start + len > buf.duration + 0.001) return tooShort();
  const zsnap = zeroSnapper(buf);
  setLoop(i, { ...lp, end: zsnap(Math.min(buf.duration, lp.start + len)) });
}

async function loadPad(i) {
  const r = rt[i];
  stop(i);
  dropVideo(i);
  r.buffer = null;
  const clip = state.pads[i];
  if (!clip) return;
  if (pageOf(i) === page) ensureVideo(i);
  try {
    const bytes = await window.api.audio(clip.id);
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const j = rt.indexOf(r); // the pad may have moved if a page was removed while decoding
    if (j >= 0 && state.pads[j] && state.pads[j].id === clip.id) {
      r.buffer = buf;
      r.level = measureLevel(buf);
      if (j === selected) renderLoop();
      if (!clip.loop || clip.loop.v !== 2) {
        const hint = await sourceTempo(clip.sourceId);
        const k = rt.indexOf(r);
        if (k >= 0 && state.pads[k] === clip && r.buffer === buf) {
          clip.loop = loopFor(buf, hint);
          save();
          if (k === selected) renderLoop();
        }
      }
    }
  } catch (e) {
    console.warn(`pad ${i}: no audio (${e.message})`);
  }
}

// The one viewer decides what to show (pad, source or deck); see updateViewer in decks.js.
function showLive() {
  if (typeof updateViewer === 'function') updateViewer();
}

function play(i, vel) {
  const clip = state.pads[i];
  const r = rt[i];
  if (!clip) return;
  if (clip.mode === 'loop' && r.voice) { stop(i); return; }
  // Fade in slowly only when taking over from another clip (one still sounding, or still fading out).
  // From silence, or when retriggering the same pad, the attack stays sharp.
  const takingOver = blend > 0 && (liveOrder.some((j) => j !== i) || ctx.currentTime < lastStopAt + blend);
  stop(i, true);
  clearTimeout(r.tail);
  ensureVideo(i);
  if (ctx.state !== 'running') ctx.resume();
  const rate = padRate(clip);
  const [ts, te] = r.buffer ? trimOf(clip, r.buffer) : [0, 0];
  const loop = clip.mode === 'loop';
  // In loop mode the audio loops between the analyzed points and the video is kept in step with it (see tick).
  const range = loop && r.buffer ? (clip.loop || { start: 0, end: r.buffer.duration }) : null;
  const voice = { src: null, gain: null };
  if (r.buffer) {
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    src.buffer = r.buffer;
    src.loop = loop;
    src.playbackRate.value = rate;
    if (range) { src.loopStart = range.start; src.loopEnd = range.end; }
    // A clip rarely starts or ends at silence, so a hard start/stop clicks. Ramp in over 4 ms,
    // and ramp a one-shot out over its last 12 ms.
    const level = clip.gain * padNorm(i) * (0.4 + 0.6 * vel);
    const t0 = ctx.currentTime;
    const dur = (te - ts) / rate; // how long the trimmed clip really lasts at this pitch
    const fadeIn = Math.min(takingOver ? Math.max(FADE_IN, blend) : FADE_IN, dur / 2);
    const fadeOut = Math.min(Math.max(FADE_OUT, blend), dur / 2);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + fadeIn);
    if (!loop && dur > 0.05) {
      gain.gain.setValueAtTime(level, t0 + dur - fadeOut);
      gain.gain.linearRampToValueAtTime(0, t0 + dur);
    }
    src.connect(gain).connect(master);
    src.onended = () => { if (r.voice === voice) stop(i); };
    if (range) src.start(t0, range.start); else src.start(t0, ts, te - ts);
    voice.src = src;
    voice.gain = gain;
  }
  r.range = range;
  r.rate = rate;
  r.playLen = (te - ts) / rate;
  r.video.loop = loop && !range;
  r.video.playbackRate = clampRate(rate);
  r.video.onended = r.buffer ? null : () => { if (r.voice === voice) stop(i); };
  r.video.currentTime = range ? range.start : ts;
  r.video.play().catch(() => {});
  r.voice = voice;
  r.startedAt = ctx.currentTime;
  liveOrder.push(i);
  renderPad(i);
  showLive();
}

// Stops a pad. Normally it fades out over the Blend time, its picture running on underneath so the
// viewer can dissolve away from it; `quick` (retriggers, edits) cuts with only the anti-click ramp.
function stop(i, quick) {
  const r = rt[i];
  if (!r.voice) return;
  const out = quick ? FADE_OUT : Math.max(FADE_OUT, blend);
  if (r.voice.src) {
    const { src, gain } = r.voice;
    src.onended = null;
    const t = ctx.currentTime;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + out);
      src.stop(t + out + 0.003);
    } catch {}
  }
  if (!quick) lastStopAt = ctx.currentTime;
  r.voice = null;
  const v = r.video;
  clearTimeout(r.tail);
  if (v && !quick && out > 0.03) {
    r.tail = setTimeout(() => {
      if (r.voice || r.video !== v) return;
      v.pause();
      const k = rt.indexOf(r);
      if (k >= 0 && pageOf(k) !== page && !r.pin) dropVideo(k);
    }, out * 1000);
  } else {
    if (v) v.pause();
    if (pageOf(i) !== page && !r.pin) dropVideo(i);
  }
  const k = liveOrder.indexOf(i);
  if (k >= 0) liveOrder.splice(k, 1);
  renderPad(i);
  showLive();
}
const stopAll = () => {
  for (const n of [...keyVoices.keys()]) stopNote(n, true);
  for (let i = 0; i < rt.length; i++) stop(i);
};

// ---------- level matching ----------
// Clips come from different videos at very different loudness. Each clip's loudness is measured when it
// loads (ignoring its silent parts) and a correction brings them all to the same level; the pad's Vol
// slider then works on top of that. A limiter on the output catches peaks when several play at once.
let levelMatch = true;
const TARGET_RMS = 0.16; // about -16 dBFS
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -3;
limiter.knee.value = 3;
limiter.ratio.value = 12;
limiter.attack.value = 0.002;
limiter.release.value = 0.12;
master.disconnect();
master.connect(limiter);
limiter.connect(ctx.destination);

function measureLevel(buffer) {
  const sr = buffer.sampleRate;
  const a = buffer.getChannelData(0);
  const b = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : a;
  const win = Math.round(0.05 * sr);
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let s = 0; s + win <= a.length; s += win) {
    let e = 0;
    for (let k = s; k < s + win; k += 2) {
      const v = (a[k] + b[k]) / 2;
      e += v * v;
      const p = Math.abs(v);
      if (p > peak) peak = p;
    }
    e /= win / 2;
    if (e > 1e-5) { sum += e; n++; } // only the parts that are actually sounding (above about -50 dB)
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  if (!rms) return { rms: 0, peak, norm: 1 };
  // Never boost a clip so far that its own peak would clip, and keep the correction within +/-18 dB.
  const norm = Math.max(0.125, Math.min(8, TARGET_RMS / rms, peak ? 0.98 / peak : 8));
  return { rms, peak, norm };
}
const padNorm = (i) => (levelMatch && rt[i].level ? rt[i].level.norm : 1);

function setLevelMatch(on) {
  levelMatch = on;
  $('levelBtn').classList.toggle('on', on);
}

// ---------- pitch, trim and playing a pad across the keys ----------
// Pitch works like a record or tape: up is faster and higher, down is slower and lower.
const padRate = (clip) => 2 ** ((clip.pitch || 0) / 12);
const clampRate = (x) => Math.max(0.1, Math.min(8, x));
// The part of the clip that plays (in clip seconds); the whole clip unless it has been trimmed.
function trimOf(clip, buffer) {
  const d = buffer.duration;
  const s = Math.max(0, Math.min(d - 0.02, clip.trim ? clip.trim.start : 0));
  const e = Math.max(s + 0.02, Math.min(d, clip.trim ? clip.trim.end : d));
  return [s, e];
}

// Keys mode: the keyboard plays the selected pad chromatically, several notes at once. Middle C (or
// the pitch the sound was detected at) plays it as recorded. The pad's picture follows the newest note.
let keysMode = false;
const keyVoices = new Map(); // MIDI note -> { r, src, gain, hold }

function playNote(i, note, vel) {
  const clip = state.pads[i];
  const r = rt[i];
  if (!clip || !r.buffer) return;
  stopNote(note, true);
  if (ctx.state !== 'running') ctx.resume();
  const rate = padRate(clip) * 2 ** ((note - (clip.root == null ? 60 : clip.root)) / 12);
  const [ts, te] = trimOf(clip, r.buffer);
  const loop = clip.mode === 'loop';
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  src.buffer = r.buffer;
  src.playbackRate.value = rate;
  const level = clip.gain * padNorm(i) * (0.4 + 0.6 * vel);
  const t0 = ctx.currentTime;
  const dur = (te - ts) / rate;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(level, t0 + Math.min(FADE_IN, dur / 2));
  if (loop) {
    const lp = clip.loop || { start: ts, end: te };
    src.loop = true;
    src.loopStart = lp.start;
    src.loopEnd = lp.end;
    src.start(t0, lp.start);
  } else {
    gain.gain.setValueAtTime(level, t0 + Math.max(0, dur - FADE_OUT));
    gain.gain.linearRampToValueAtTime(0, t0 + dur);
    src.start(t0, ts, te - ts);
  }
  src.connect(gain).connect(master);
  const kv = { r, src, gain, hold: clip.mode === 'oneshot' };
  src.onended = () => { if (keyVoices.get(note) === kv) endNote(note); };
  keyVoices.set(note, kv);

  ensureVideo(i);
  clearTimeout(r.tail);
  r.video.loop = false;
  r.video.playbackRate = clampRate(rate);
  r.video.currentTime = ts;
  r.video.play().catch(() => {});
  r.keys = (r.keys || 0) + 1;
  r.range = null;
  r.rate = rate;
  r.playLen = dur;
  r.startedAt = t0;
  const at = liveOrder.indexOf(i);
  if (at >= 0) liveOrder.splice(at, 1);
  liveOrder.push(i);
  renderPad(i);
  showLive();
}

// A key was released: one-shot pads ring out, the rest fade.
function stopNote(note, quick) {
  const kv = keyVoices.get(note);
  if (!kv || (kv.hold && !quick)) return;
  const t = ctx.currentTime;
  const out = quick ? FADE_OUT : 0.06;
  try {
    kv.src.onended = null;
    kv.gain.gain.cancelScheduledValues(t);
    kv.gain.gain.setValueAtTime(kv.gain.gain.value, t);
    kv.gain.gain.linearRampToValueAtTime(0, t + out);
    kv.src.stop(t + out + 0.003);
  } catch {}
  endNote(note);
}

function endNote(note) {
  const kv = keyVoices.get(note);
  if (!kv) return;
  keyVoices.delete(note);
  const r = kv.r;
  r.keys = Math.max(0, (r.keys || 1) - 1);
  const i = rt.indexOf(r);
  if (r.keys || r.voice || i < 0) return;
  const at = liveOrder.indexOf(i);
  if (at >= 0) liveOrder.splice(at, 1);
  const v = r.video;
  clearTimeout(r.tail);
  r.tail = setTimeout(() => { if (!r.voice && !r.keys && r.video === v && v) v.pause(); }, Math.max(80, blend * 1000));
  renderPad(i);
  showLive();
}

function setKeysMode(on) {
  keysMode = on;
  if (!on) for (const n of [...keyVoices.keys()]) stopNote(n, true);
  $('keysBtn').classList.toggle('on', on);
}

// ---------- waveform and trim ----------
const peaksCache = new WeakMap();
function peaksOf(buffer, n) {
  const hit = peaksCache.get(buffer);
  if (hit && hit.length === n) return hit;
  const d = buffer.getChannelData(0);
  const out = new Float32Array(n);
  const step = d.length / n;
  for (let x = 0; x < n; x++) {
    let m = 0;
    for (let k = Math.floor(x * step), e = Math.min(d.length, Math.floor((x + 1) * step)); k < e; k += 4) m = Math.max(m, Math.abs(d[k]));
    out[x] = m;
  }
  peaksCache.set(buffer, out);
  return out;
}

function renderWave() {
  const cv = $('wave');
  const w = cv.clientWidth || 600;
  const h = cv.clientHeight || 64;
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, w, h);
  const clip = state.pads[selected];
  const buf = rt[selected] && rt[selected].buffer;
  $('trimLabel').textContent = '';
  if (!clip || !buf) {
    g.fillStyle = '#8b8f9a';
    g.font = '12px "Segoe UI", sans-serif';
    g.fillText(clip ? 'Loading…' : 'Select a pad with a clip to edit its sample', 10, h / 2 + 4);
    return;
  }
  const d = buf.duration;
  const [ts, te] = trimOf(clip, buf);
  const peaks = peaksOf(buf, w);
  const x0 = (ts / d) * w;
  const x1 = (te / d) * w;
  if (clip.mode === 'loop' && clip.loop) {
    g.fillStyle = 'rgba(61, 220, 151, .16)';
    g.fillRect((clip.loop.start / d) * w, 0, ((clip.loop.end - clip.loop.start) / d) * w, h);
  }
  for (let x = 0; x < w; x++) {
    g.fillStyle = x >= x0 && x <= x1 ? '#ff5a36' : '#3a3d47';
    const a = Math.max(1, peaks[x] * (h - 6));
    g.fillRect(x, (h - a) / 2, 1, a);
  }
  g.fillStyle = '#fff';
  g.fillRect(Math.round(x0), 0, 2, h);
  g.fillRect(Math.round(x1) - 2, 0, 2, h);
  const rate = padRate(clip);
  $('trimLabel').textContent = `${(te - ts).toFixed(2)} s of ${d.toFixed(2)} s${rate !== 1 ? ` · plays in ${((te - ts) / rate).toFixed(2)} s` : ''}${clip.root != null ? ` · root ${noteName(clip.root)}` : ''}${levelMatch && rt[selected].level ? ` · level ${(20 * Math.log10(rt[selected].level.norm)) >= 0 ? '+' : ''}${(20 * Math.log10(rt[selected].level.norm)).toFixed(1)} dB` : ''}`;
}

function wireWave() {
  const cv = $('wave');
  let drag = null; // 'start' | 'end'
  const timeAt = (e) => {
    const buf = rt[selected].buffer;
    const box = cv.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * buf.duration;
  };
  const move = (e) => {
    const clip = state.pads[selected];
    const buf = rt[selected].buffer;
    if (!drag || !clip || !buf) return;
    const [ts, te] = trimOf(clip, buf);
    const t = timeAt(e);
    clip.trim = drag === 'start' ? { start: Math.min(t, te - 0.03), end: te } : { start: ts, end: Math.max(t, ts + 0.03) };
    renderWave();
  };
  cv.addEventListener('mousedown', (e) => {
    const clip = state.pads[selected];
    const buf = rt[selected].buffer;
    if (!clip || !buf) return;
    const [ts, te] = trimOf(clip, buf);
    const t = timeAt(e);
    drag = Math.abs(t - ts) <= Math.abs(t - te) ? 'start' : 'end';
    move(e);
  });
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    save();
    if (state.pads[selected]) { stop(selected, true); play(selected, 1); if (state.pads[selected].mode !== 'oneshot') setTimeout(() => stop(selected), 600); } // hear the edit
  });
  cv.addEventListener('dblclick', () => { const c = state.pads[selected]; if (c) { delete c.trim; save(); renderWave(); } });
  window.addEventListener('resize', renderWave);
}

function setBlend(seconds) {
  blend = Math.max(0, Math.min(3, seconds || 0));
  $('blend').value = blend;
  $('blendLabel').textContent = blend ? `${blend.toFixed(2)} s` : 'off';
}

function trigger(i, vel) {
  if (armed) {
    if (recording) return;
    if (!currentSource) return toast('Fetch and select a video first.');
    if (srcVideo.paused) srcVideo.play();
    recording = { pad: i, start: srcVideo.currentTime };
    renderPad(i);
    return;
  }
  play(i, vel);
}

function release(i) {
  if (recording && recording.pad === i) {
    const { start } = recording;
    recording = null;
    renderPad(i);
    doCut(i, start, srcVideo.currentTime);
    return;
  }
  const clip = state.pads[i];
  if (clip && clip.mode === 'gate') stop(i);
}

async function doCut(i, start, end, batchSource, meta) {
  const source = batchSource || currentSource;
  if (!source) return toast('Fetch and select a video first.');
  if (!(end - start > 0.05)) return toast('Clip too short — hold the pad longer, or set In before Out.');
  busy.add(i);
  renderPad(i);
  try {
    const clip = await window.api.cut({
      sourceFile: source.file, sourceId: source.id, start, end,
      name: meta && meta.label ? `${meta.label} · ${fmt(start)}` : `${source.title.slice(0, 22)} ${fmt(start)}`,
    });
    if (meta && meta.note != null) clip.root = meta.note; // the pitch it sounds at, so the keys play it in tune
    const old = state.pads[i];
    state.pads[i] = clip;
    save();
    if (old) window.api.removeClip(old.id);
    await loadPad(i);
    if (batchSource) renderPad(i); else select(i);
  } catch (e) {
    toast(`Cut failed: ${e.message}`);
  } finally {
    busy.delete(i);
    renderPads();
  }
}

// Chops In→Out (or the whole video) across the empty pads of the current page: on detected hits, or in equal slices.
const MAX_HIT_SLICE = 10; // seconds; keeps a hit slice from running on when the next hit is far away
const MAX_AUTO_CLIPS = 400;
let autoBusy = false;
async function autoCut() {
  if (autoBusy) return;
  const source = currentSource;
  if (!source || !srcVideo.duration) return toast('Fetch and select a video first.');
  const bars = Number($('autoLen').value); // 0 = fill this page only; otherwise cover the whole region in clips this long
  const onHits = $('autoMode').value !== 'equal';
  const sounds = $('autoMode').value === 'sounds';
  let empty = pageSlots(page).filter((i) => !state.pads[i]);
  if (!bars && !empty.length) return toast('No empty pads on this page — add a page, or pick a clip length to add pages automatically.');
  const hasRange = markIn != null && markOut != null && markOut > markIn;
  const start = hasRange ? markIn : 0;
  const end = hasRange ? markOut : srcVideo.duration;
  autoBusy = true;
  $('autoBtn').disabled = true;
  $('autoBtn').textContent = 'Analyzing…';
  try {
    let slices = [];
    let note = '';
    if (sounds) {
      // Sounds that stand on their own, to play as instruments: named by character, tuned when they have a pitch.
      const found = await window.api.findSounds({ sourceFile: source.file, start, end, count: bars ? 64 : empty.length });
      slices = found.map((s) => [s.start, s.end, s]);
      const lone = found.filter((s) => s.isolated).length;
      if (found.length && lone < found.length) note = ` ${lone} stand alone; the rest are the strongest hits in busy audio.`;
    } else if (bars) {
      // Whole region, back to back, in clips of a set number of bars; pages are added to hold them all.
      let bpm = source.bpm;
      if (!bpm) {
        bpm = await window.api.bpm({ file: source.file, duration: srcVideo.duration });
        if (bpm) { source.bpm = bpm; save(); }
      }
      if (!bpm) note = ' No steady beat found, so bars were taken as 2 seconds.';
      const beat = 60 / (bpm || 120);
      const len = bars * 4 * beat;
      const hits = onHits ? await window.api.findHits({ sourceFile: source.file, start, end, count: 1e6 }) : [];
      let h = 0;
      // Each boundary snaps to a hit near where the beat should fall, so the grid follows the music instead of drifting.
      const snap = (x) => {
        while (h < hits.length - 1 && Math.abs(hits[h + 1] - x) <= Math.abs(hits[h] - x)) h++;
        return hits.length && Math.abs(hits[h] - x) < 0.2 * beat ? hits[h] : x;
      };
      let t = hits.length && hits[0] - start < len ? hits[0] : start;
      while (t < end - 0.25 * len) {
        let nx = snap(t + len);
        if (nx - t < 0.5 * len) nx = t + len;
        nx = Math.min(nx, end);
        slices.push([t, nx]);
        t = nx;
      }
    } else if (!onHits) {
      const len = (end - start) / empty.length;
      for (let k = 0; k < empty.length; k++) slices.push([start + k * len, start + (k + 1) * len]);
    } else {
      const hits = await window.api.findHits({ sourceFile: source.file, start, end, count: empty.length });
      slices = hits.map((t, k) => [t, Math.min(k + 1 < hits.length ? hits[k + 1] : end, t + MAX_HIT_SLICE)]);
    }
    slices = slices.filter(([a, b]) => b - a > 0.05);
    if (!slices.length) return toast(sounds ? 'No distinct sounds found in that region.' : 'No clear hits found in that region — try Equal slices.');

    if (bars || sounds) {
      if (slices.length > MAX_AUTO_CLIPS) return toast(`That would be ${slices.length} clips. Pick a longer clip length or mark a shorter In→Out region.`);
      empty = [];
      for (let i = page * N; i < state.pads.length; i++) if (!state.pads[i]) empty.push(i);
      const addPages = Math.ceil(Math.max(0, slices.length - empty.length) / N);
      if (slices.length > 3 * N && !confirm(`Cut ${slices.length} clips${addPages ? ` and add ${addPages} page${addPages === 1 ? '' : 's'}` : ''}?`)) return;
      for (let k = 0; k < addPages * N; k++) { empty.push(state.pads.length); state.pads.push(null); }
      syncRt();
      renderPads();
    }

    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < slices.length) {
        const k = next++;
        await doCut(empty[k], slices[k][0], slices[k][1], source, slices[k][2]);
        $('autoBtn').textContent = `Cutting ${++done}/${slices.length}…`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    select(empty[0]);
    const pagesUsed = pageOf(empty[slices.length - 1]) - pageOf(empty[0]) + 1;
    toast(`Cut ${slices.length} clip${slices.length === 1 ? '' : 's'}${pagesUsed > 1 ? ` across ${pagesUsed} pages` : ''}.${note}`);
    return slices.length;
  } catch (e) {
    toast(`Auto cut failed: ${e.message}`);
  } finally {
    autoBusy = false;
    $('autoBtn').disabled = false;
    $('autoBtn').textContent = 'Auto cut to pads';
  }
}

// Empties every pad on the current page.
async function clearPage() {
  const slots = pageSlots(page);
  const clips = slots.map((i) => state.pads[i]).filter(Boolean);
  if (!clips.length) return;
  for (const i of slots) state.pads[i] = null;
  save();
  for (const i of slots) await loadPad(i);
  select(selected);
  for (const c of clips) window.api.removeClip(c.id);
}

// ---------- source ----------
function renderSources() {
  const sel = $('sourceSelect');
  sel.innerHTML = '';
  for (const s of state.sources) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.title;
    sel.appendChild(o);
  }
  if (currentSource) sel.value = currentSource.id;
  $('removeSourceBtn').disabled = !currentSource;
}

function setSource(source) {
  currentSource = source || null;
  markIn = markOut = null;
  if (currentSource) srcVideo.src = currentSource.url; else srcVideo.removeAttribute('src');
  srcVideo.load();
  if (typeof focusViewer === 'function') focusViewer('src');
  renderSources();
  renderMarks();
}

function renderMarks() {
  $('inLabel').textContent = fmt(markIn);
  $('outLabel').textContent = fmt(markOut);
  const d = srcVideo.duration;
  const range = $('selRange');
  if (markIn != null && markOut != null && markOut > markIn && d) {
    range.style.display = 'block';
    range.style.left = `${(markIn / d) * 100}%`;
    range.style.width = `${((markOut - markIn) / d) * 100}%`;
  } else range.style.display = 'none';
}

function togglePlay() {
  if (!currentSource) return;
  if (srcVideo.paused) srcVideo.play(); else srcVideo.pause();
}

function preview() {
  if (markIn == null || markOut == null || markOut <= markIn) return toast('Set In and Out first.');
  srcVideo.currentTime = markIn;
  srcVideo.play();
  previewStop = markOut;
}

function cutToPad() {
  if (markIn == null || markOut == null) return toast('Set In and Out first.');
  let target = selected;
  if (state.pads[target]) {
    const empty = pageSlots(page).find((i) => !state.pads[i]);
    if (empty != null) target = empty;
  }
  doCut(target, markIn, markOut);
}

function setArmed(on) {
  armed = on;
  document.body.classList.toggle('armed', on);
  $('armBtn').textContent = on ? '● Recording armed' : '● Record to pads';
  if (on) stopAll();
}

function setLearning(on) {
  learning = on;
  if (on && learningPage) setLearningPage(null);
  $('learnBtn').classList.toggle('on', on);
  $('learnBtn').textContent = on ? 'Hit a pad…' : 'MIDI learn';
}

// ---------- MIDI ----------
// Page switching can be bound to any pad/key (note) or button (CC) on the controller.
// Learning walks through "previous" then "next"; bound controls stop acting as pads.
let learningPage = null; // null | 'prev' | 'next'
const ccLast = new Map();

function setLearningPage(step) {
  learningPage = step;
  $('learnPageBtn').classList.toggle('on', !!step);
  $('learnPageBtn').textContent = step === 'prev' ? 'Press control for ‹ previous…' : step === 'next' ? 'Now press control for › next…' : 'Learn page buttons';
  const a = state.midiActions || {};
  const label = (k) => (a[k] ? a[k].replace('note:', 'note ').replace('cc:', 'CC ') : 'not set');
  $('learnPageBtn').title = `Bind controller buttons to page switching. Previous: ${label('prev')}. Next: ${label('next')}.`;
}

// Returns true when the message was a page control (or was consumed by learning one).
function pageControl(key) {
  if (learningPage) {
    const other = learningPage === 'prev' ? 'next' : 'prev';
    if (state.midiActions[other] === key) delete state.midiActions[other];
    state.midiActions[learningPage] = key;
    save();
    setLearningPage(learningPage === 'prev' ? 'next' : null);
    return true;
  }
  if (state.midiActions.prev === key) { setPage(page - 1); return true; }
  if (state.midiActions.next === key) { setPage(page + 1); return true; }
  return false;
}

function onMidi(e) {
  const [status, d1, d2] = e.data;
  const cmd = status & 0xf0;
  if (cmd === 0xb0) {
    // Buttons send a high value on press and 0 on release; act on the press only.
    const was = ccLast.get(d1) || 0;
    ccLast.set(d1, d2);
    if (d2 >= 64 && was < 64 && !learning) pageControl(`cc:${d1}`);
    return;
  }
  // Keys mode: notes from the keyboard (any channel but 10, which is the drum pads) play the selected pad.
  if (keysMode && (status & 0x0f) !== 9 && !learning && !learningPage) {
    if (cmd === 0x90 && d2 > 0) return playNote(selected, d1, d2 / 127);
    if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) return stopNote(d1);
  }
  if (cmd === 0x90 && d2 > 0 && !learning && pageControl(`note:${d1}`)) return;
  if (cmd === 0x90 && d2 > 0) {
    if (learning) {
      const slot = selected % N; // a note maps to a pad position, which then works on every page
      for (const k of Object.keys(state.midiMap)) if (state.midiMap[k] === slot) delete state.midiMap[k];
      state.midiMap[d1] = slot;
      save();
      setLearning(false);
      renderPads();
      return;
    }
    const slot = padForNote(d1);
    if (slot == null) return;
    const p = page * N + slot;
    heldNotes.set(d1, p);
    if (p !== selected) select(p);
    trigger(p, d2 / 127);
  } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
    const p = heldNotes.get(d1);
    heldNotes.delete(d1);
    if (p != null) release(p);
  }
}

const QUERY = new URLSearchParams(location.search);
const OPEN_MIDI = !QUERY.get('smoke') || !!QUERY.get('openMidi');
let midiInputs = 0;
let midiBusy = false;

// Asks for the MIDI devices and listens to all of them. Safe to call again: it is also the rescan,
// run when the chip is clicked and every few seconds while no device is found (a controller plugged
// in late, or released by another program, does not always announce itself).
async function initMidi() {
  if (midiBusy && performance.now() - midiBusy < 8000) return; // a request that never answers must not block retries
  midiBusy = performance.now();
  const chip = $('midiStatus');
  try {
    const access = await navigator.requestMIDIAccess();
    const hook = () => {
      const names = [];
      for (const input of access.inputs.values()) {
        if (input.state !== 'connected') continue;
        if (OPEN_MIDI) input.onmidimessage = onMidi;
        names.push(input.name);
      }
      midiInputs = names.length;
      chip.textContent = names.length ? `MIDI: ${names.join(', ')}` : 'MIDI: none — click to rescan';
      chip.title = `${names.join('\n') || 'No MIDI inputs found.'}\nClick to rescan.`;
      chip.classList.toggle('ok', names.length > 0);
    };
    hook();
    access.onstatechange = hook;
  } catch (e) {
    midiInputs = 0;
    chip.textContent = 'MIDI unavailable — click to retry';
    chip.title = e.message;
  } finally {
    midiBusy = false;
  }
}

// ---------- YouTube search ----------
// Typing words instead of a link lists matching videos; picking one fetches it like a pasted link.
async function searchVideos(query) {
  const box = $('results');
  box.hidden = false;
  box.innerHTML = '<div class="none">Searching…</div>';
  $('addBtn').disabled = true;
  try {
    const hits = await window.api.search(query);
    box.innerHTML = hits.length ? '' : '<div class="none">No videos found.</div>';
    for (const h of hits) {
      const row = document.createElement('div');
      row.className = 'hit';
      const img = document.createElement('img');
      img.src = h.thumb;
      const text = document.createElement('div');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = h.title;
      const m = document.createElement('div');
      m.className = 'm';
      m.textContent = [h.channel, h.duration ? fmt(h.duration).replace(/\.\d+$/, '') : ''].filter(Boolean).join(' · ');
      text.append(t, m);
      row.append(img, text);
      row.addEventListener('click', () => { $('urlInput').value = h.url; box.hidden = true; $('addForm').requestSubmit(); });
      box.appendChild(row);
    }
  } catch (e) {
    box.innerHTML = '';
    box.hidden = true;
    toast('Search failed: ' + e.message);
  } finally {
    $('addBtn').disabled = false;
  }
}

// ---------- wiring ----------
function wire() {
  $('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('urlInput').value.trim();
    if (!url) return;
    if (!/^https?:[/][/]/i.test(url)) return searchVideos(url); // words, not a link: search YouTube
    $('results').hidden = true;
    $('addBtn').disabled = true;
    try {
      const source = await window.api.addSource(url);
      const k = state.sources.findIndex((s) => s.id === source.id);
      if (k >= 0) state.sources[k] = source; else state.sources.push(source);
      save();
      setSource(source);
      $('urlInput').value = '';
    } catch (err) {
      toast(`Fetch failed: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    } finally {
      $('addBtn').disabled = false;
      $('progress').hidden = true;
    }
  });
  window.api.onProgress(({ text, pct }) => {
    $('progress').hidden = pct == null;
    $('progressBar').style.width = `${pct || 0}%`;
    $('progressText').textContent = pct ? `${text} — ${pct.toFixed(0)}%` : text;
  });

  $('sourceSelect').addEventListener('change', (e) => setSource(state.sources.find((s) => s.id === e.target.value)));
  $('removeSourceBtn').addEventListener('click', async () => {
    if (!currentSource) return;
    const id = currentSource.id;
    srcVideo.pause();
    state.sources = state.sources.filter((s) => s.id !== id);
    setSource(state.sources[0]);
    save();
    await window.api.removeSource(id);
  });
  $('folderBtn').addEventListener('click', () => window.api.openFolder());

  $('playBtn').addEventListener('click', togglePlay);
  srcVideo.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; focusViewer('src'); });
  srcVideo.addEventListener('seeking', () => focusViewer('src'));
  srcVideo.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; previewStop = null; });
  srcVideo.addEventListener('loadedmetadata', renderMarks);
  $('rateInput').addEventListener('input', (e) => {
    srcVideo.playbackRate = Number(e.target.value);
    $('rateLabel').textContent = `${srcVideo.playbackRate.toFixed(2)}×`;
  });
  $('timeline').addEventListener('mousedown', (e) => {
    if (!srcVideo.duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    srcVideo.currentTime = ((e.clientX - box.left) / box.width) * srcVideo.duration;
  });
  $('inBtn').addEventListener('click', () => { markIn = srcVideo.currentTime; renderMarks(); });
  $('outBtn').addEventListener('click', () => { markOut = srcVideo.currentTime; renderMarks(); });
  $('previewBtn').addEventListener('click', preview);
  $('cutBtn').addEventListener('click', cutToPad);
  $('armBtn').addEventListener('click', () => setArmed(!armed));

  $('padName').addEventListener('input', (e) => { const c = state.pads[selected]; if (c) { c.name = e.target.value; renderPad(selected); save(); } });
  $('allBtn').addEventListener('click', () => setAllPads(!allPads));
  $('padMode').addEventListener('change', (e) => {
    for (const i of targets()) { stop(i); state.pads[i].mode = e.target.value; }
    save();
  });
  $('padGain').addEventListener('input', (e) => {
    for (const i of targets()) {
      const c = state.pads[i];
      c.gain = Number(e.target.value);
      const v = rt[i].voice;
      if (v && v.gain) v.gain.gain.setTargetAtTime(c.gain * padNorm(i), ctx.currentTime, 0.01);
    }
    save();
  });
  $('learnBtn').addEventListener('click', () => setLearning(!learning));
  $('clearBtn').addEventListener('click', async () => {
    const c = state.pads[selected];
    if (!c) return;
    state.pads[selected] = null;
    save();
    await loadPad(selected);
    select(selected);
    window.api.removeClip(c.id);
  });
  $('stopAllBtn').addEventListener('click', stopAll);
  $('padPitch').addEventListener('input', (e) => setPitch(Number(e.target.value)));
  $('padPitch').addEventListener('dblclick', () => setPitch(0));
  $('keysBtn').addEventListener('click', () => setKeysMode(!keysMode));
  $('levelBtn').addEventListener('click', () => { setLevelMatch(!levelMatch); state.levelMatch = levelMatch; save(); renderWave(); applyVolumes(); });
  wireWave();
  $('blend').addEventListener('input', (e) => { setBlend(Number(e.target.value)); state.blend = blend; save(); });
  $('autoBtn').addEventListener('click', autoCut);
  // With "All pads" on these act on every pad; only the single-pad Auto loop starts playback by itself.
  $('autoLoopBtn').addEventListener('click', async () => {
    for (const i of targets()) {
      const clip = state.pads[i];
      const hint = await sourceTempo(clip.sourceId);
      const b = rt[i].buffer;
      if (b && state.pads[i] === clip) setLoop(i, analyzeLoop(b, hint), true, !allPads);
    }
    select(selected);
  });
  $('halfBtn').addEventListener('click', () => { for (const i of targets()) scaleLoop(i, 0.5, allPads); });
  $('doubleBtn').addEventListener('click', () => { for (const i of targets()) scaleLoop(i, 2, allPads); });
  $('fullLoopBtn').addEventListener('click', () => {
    for (const i of targets()) {
      const b = rt[i].buffer;
      const c = state.pads[i];
      if (b) setLoop(i, { ...(c.loop || {}), start: 0, end: b.duration, beats: null });
    }
  });
  $('clearAllBtn').addEventListener('click', () => {
    const n = pageSlots(page).filter((i) => state.pads[i]).length;
    if (n && confirm(`Delete the ${n} clip${n === 1 ? '' : 's'} on page ${page + 1}?`)) clearPage();
  });
  $('prevPageBtn').addEventListener('click', () => setPage(page - 1));
  $('nextPageBtn').addEventListener('click', () => setPage(page + 1));
  $('learnPageBtn').addEventListener('click', () => { setLearning(false); setLearningPage(learningPage ? null : 'prev'); });
  $('addPageBtn').addEventListener('click', addPage);
  $('removePageBtn').addEventListener('click', removePage);

  window.addEventListener('keydown', (e) => {
    const typing = e.target.matches('input[type=text], input[type=number], select');
    if (e.key === 'Escape') { $('results').hidden = true; stopAll(); setLearning(false); setLearningPage(null); if (typing) e.target.blur(); return; }
    if (typing || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const slot = KEYS.indexOf(k);
    if (k.length === 1 && slot >= 0) {
      const pad = page * N + slot;
      heldKeys.set(k, pad);
      select(pad);
      trigger(pad, 1);
      return;
    }
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === '[' || k === 'pageup') { e.preventDefault(); setPage(page - 1); }
    else if (k === ']' || k === 'pagedown') { e.preventDefault(); setPage(page + 1); }
    else if (k === 'i') $('inBtn').click();
    else if (k === 'o') $('outBtn').click();
    else if (k === 'p') preview();
    else if (k === 'enter') cutToPad();
    else if (k === 'delete') $('clearBtn').click();
    else if (k === '`') setArmed(!armed);
    else if (k === 'arrowleft' || k === 'arrowright') {
      e.preventDefault();
      srcVideo.currentTime += (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30);
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    const pad = heldKeys.get(k);
    heldKeys.delete(k);
    if (pad != null) release(pad);
  });
  // Keep buttons from holding focus so Space/Enter stay transport keys.
  document.addEventListener('click', (e) => { if (e.target.closest('button')) e.target.closest('button').blur(); });
}

function tick() {
  const d = srcVideo.duration;
  if (d) {
    $('playhead').style.left = `${(srcVideo.currentTime / d) * 100}%`;
    if (previewStop != null && srcVideo.currentTime >= previewStop) srcVideo.pause();
  }
  $('timeLabel').textContent = `${fmt(srcVideo.currentTime || 0)} / ${fmt(d || 0)}`;
  showLive();
  for (const i of liveOrder) {
    const r = rt[i];
    const el = padEl(i);
    const bar = el ? el.querySelector('.bar') : { style: {} }; // off-page pads still need their video kept in step
    if (r.range && r.video) {
      // The audio loop is the clock; pull the video back whenever it drifts or runs past the loop end.
      const len = r.range.end - r.range.start;
      const off = ((ctx.currentTime - r.startedAt) * (r.rate || 1)) % len;
      const want = r.range.start + off;
      // Seek on each wrap; otherwise only correct real drift, and never while a seek is still landing
      // (re-seeking every frame would freeze the picture on a slow decode).
      const wrapped = off < (r.lastOff || 0);
      r.lastOff = off;
      const now = performance.now();
      const drift = Math.abs(r.video.currentTime - want);
      if (wrapped || (drift > 0.15 && !r.video.seeking && now - (r.lastSeek || 0) > 500)) {
        r.video.currentTime = want;
        r.lastSeek = now;
      }
      if (r.video.paused || r.video.ended) r.video.play().catch(() => {});
      bar.style.width = `${(off / len) * 100}%`;
      continue;
    }
    const len = r.playLen || (r.buffer ? r.buffer.duration : (r.video && r.video.duration) || 0);
    if (len) bar.style.width = `${(((ctx.currentTime - r.startedAt) % len) / len) * 100}%`;
  }
}

async function init() {
  buildPads();
  wire();
  const loaded = await window.api.load();
  const saved = loaded.pads || [];
  const total = Math.max(1, Math.ceil(saved.length / N)) * N; // whole pages
  state = { sources: loaded.sources || [], pads: Array.from({ length: total }, (_, i) => saved[i] || null), midiMap: loaded.midiMap || {}, midiActions: loaded.midiActions || {}, decks: loaded.decks || [], recordings: loaded.recordings || [], xfade: loaded.xfade, blend: loaded.blend, fx: loaded.fx };
  setBlend(typeof state.blend === 'number' ? state.blend : 0.25);
  state.levelMatch = loaded.levelMatch !== false;
  setLevelMatch(state.levelMatch);
  syncRt();
  setLearningPage(null);
  setSource(state.sources[0]);
  select(0);
  // MIDI first: asking for it while hundreds of clips are decoding at once never completes.
  $('midiStatus').addEventListener('click', initMidi);
  setInterval(() => { if (!midiInputs) initMidi(); }, 3000);
  await Promise.race([initMidi(), new Promise((r) => setTimeout(r, 3000))]);
  setInterval(tick, 16); // a timer rather than animation frames, so loops stay in sync when the window is covered
  initDecks(); // decks.js
  initFx(); // fx.js
  initBeat(); // beat.js
  // Then the clips, a few at a time, starting with the page on screen.
  const queue = Array.from({ length: total }, (_, i) => i).filter((i) => state.pads[i]);
  const loader = async () => { while (queue.length) await loadPad(queue.shift()); };
  await Promise.all([loader(), loader(), loader(), loader()]);
}

window.__smoke = () => ({
  pads: padEls.length, api: typeof window.api, audio: ctx.state,
  sources: state.sources.length, clips: state.pads.filter(Boolean).length, midi: $('midiStatus').textContent,
});

// Smoke-test only: cut a clip from a given source onto the last pad, play it, then clean up.
window.__smokeCut = async (source) => {
  const i = N - 1;
  currentSource = source;
  await doCut(i, 1.3, 3.9);
  const clip = state.pads[i];
  if (!clip) return { cut: false };
  const lp = clip.loop && { start: +clip.loop.start.toFixed(3), end: +clip.loop.end.toFixed(3), bpm: clip.loop.bpm && +clip.loop.bpm.toFixed(1), beats: clip.loop.beats };
  clip.mode = 'loop';
  play(i, 1);
  await new Promise((r) => setTimeout(r, 2600)); // past one wrap of a 2 s loop
  const loopVideoTime = +rt[i].video.currentTime.toFixed(2);
  const loopStillPlaying = !!rt[i].voice;
  stop(i);
  clip.mode = 'oneshot';
  const audioSeconds = rt[i].buffer ? rt[i].buffer.duration : 0;
  play(i, 1);
  await new Promise((r) => setTimeout(r, 700));
  const playing = !!rt[i].voice;
  const videoTime = rt[i].video.currentTime;
  state.pads[i] = null;
  await loadPad(i);
  await window.api.removeClip(clip.id);
  currentSource = null;
  save();
  return { cut: true, audioSeconds, playing, videoTime, thumb: !!clip.thumb, loop: lp, loopVideoTime, loopStillPlaying };
};

// Smoke-test only: auto cut in both modes and report what landed on the pads.
window.__smokeAuto = async (source) => {
  const out = {};
  for (const mode of ['hits', 'equal']) {
    setSource(source);
    await new Promise((r) => srcVideo.addEventListener('loadedmetadata', r, { once: true }));
    $('autoMode').value = mode;
    await autoCut();
    const clips = state.pads.filter(Boolean);
    const defaultModes = [...new Set(clips.map((c) => c.mode))];
    setAllPads(true);
    $('padMode').value = 'loop';
    $('padMode').dispatchEvent(new Event('change'));
    setAllPads(false);
    out[mode] = {
      defaultModes,
      afterAllPadsLoop: [...new Set(state.pads.filter(Boolean).map((c) => c.mode))],
      clips: clips.length,
      loaded: rt.filter((r) => r.buffer).length,
      starts: clips.map((c) => Number(c.start.toFixed(2))),
    };
    await clearPage();
  }
  // Whole-song cut: with page 1 full, 1-bar clips of an 8 s / 120 BPM video must land on a new page.
  $('autoMode').value = 'equal';
  await autoCut();
  $('autoMode').value = 'hits';
  $('autoLen').value = '1';
  await autoCut();
  $('autoLen').value = '0';
  const p2 = pageSlots(1).map((i) => state.pads[i]).filter(Boolean);
  out.wholeSong = { pages: pageCount(), page1: pageSlots(0).filter((i) => state.pads[i]).length, page2: p2.length, starts: p2.map((c) => +c.start.toFixed(2)), lengths: p2.map((c) => +(c.end - c.start).toFixed(2)), videoElements: document.querySelectorAll('#viewer video').length };
  // Loop from the source tempo: a 1-bar clip of a 120 BPM video must come out as 4 beats at exactly 120.
  {
    const lp = loopFor(rt[N].buffer, 120);
    const guess = analyzeLoop(rt[N].buffer);
    out.wholeSong.hintLoop = { beats: lp.beats, bpm: lp.bpm, seconds: +(lp.end - lp.start).toFixed(3), v: lp.v };
    out.wholeSong.guessLoop = { beats: guess.beats, bpm: guess.bpm && +guess.bpm.toFixed(1), seconds: +(guess.end - guess.start).toFixed(3) };
  }
  // Rearranging: swap two pads on page 2, then move one to page 1 (full, so refused) and swap with an empty slot.
  const [idA, idB] = [state.pads[N].id, state.pads[N + 1].id];
  swapPads(N, N + 1);
  const swapped = state.pads[N].id === idB && state.pads[N + 1].id === idA && rt[N].buffer && rt[N + 1].buffer;
  swapPads(N, N + 10);
  out.rearrange = { swapped: !!swapped, movedToEmpty: state.pads[N + 10] && state.pads[N + 10].id === idB && !state.pads[N], selected };
  play(N + 10, 1);
  await new Promise((r) => setTimeout(r, 300));
  out.rearrange.movedPadPlays = !!rt[N + 10].voice;
  stop(N + 10);
  {
    const realConfirm = window.confirm;
    window.confirm = () => true;
    setPage(1);
    removePage();
    window.confirm = realConfirm;
    await clearPage();
  }
  // Pages: add one, fill it, play a pad on it from page 1's view, then remove it.
  addPage();
  $('autoMode').value = 'equal';
  await autoCut();
  const onPage2 = pageSlots(1).filter((i) => state.pads[i]).length;
  const onPage1 = pageSlots(0).filter((i) => state.pads[i]).length;
  state.pads[N].mode = 'loop';
  play(N, 1);
  setPage(0);
  await new Promise((r) => setTimeout(r, 400));
  out.pages = {
    count: pageCount(), onPage1, onPage2, shownPage: page + 1,
    page2PadStillPlaying: !!rt[N].voice, tabs: $('pageTabs').children.length,
  };
  // MIDI page buttons: learn CC 104 = previous and note 60 = next, then drive pages with them.
  const midi = (...data) => onMidi({ data });
  $('learnPageBtn').click();
  midi(0xb0, 104, 127); midi(0xb0, 104, 0);
  midi(0x90, 60, 100); midi(0x80, 60, 0);
  const seen = [];
  midi(0x90, 60, 100); seen.push(page + 1); // next -> 2
  midi(0xb0, 104, 127); seen.push(page + 1); // prev -> 1
  midi(0xb0, 104, 0); seen.push(page + 1); // release does nothing
  midi(0xb0, 104, 127); seen.push(page + 1); // already first page
  out.midiPages = { learned: { ...state.midiActions }, seen, learningEnded: learningPage === null };
  state.midiActions = {};
  setPage(1);
  const realConfirm = window.confirm;
  window.confirm = () => true;
  removePage();
  window.confirm = realConfirm;
  out.pages.afterRemove = { count: pageCount(), pads: state.pads.length, rt: rt.length, clips: state.pads.filter(Boolean).length };
  return out;
};

// Wait for every script (decks.js comes after this file) before starting.
window.addEventListener('load', init);
