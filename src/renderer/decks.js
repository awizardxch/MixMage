'use strict';
// Two decks, a mixer, the single viewer, and recording.
// Each deck plays a video (a fetched source, a pad clip, or a recording) with tempo control, and can
// record the pad performance (picture + sound) straight into itself. The whole output — the viewer's
// picture with every sound — can be recorded to a file as the final take.
// Loaded after renderer.js and shares its globals (state, save, ctx, master, rt, liveOrder, toast, $).

const decks = [];
let xfade = 0.5;
let recState = null; // { deck, cap } while a deck is recording the pads
let outState = null; // { cap } while the final output is being recorded

// Everything the pads play goes through `master`. `recDest` (pads only) is what a deck records;
// `mixDest` (pads + source + both decks) is what the final output records.
const recDest = ctx.createMediaStreamDestination();
const mixDest = ctx.createMediaStreamDestination();
const mixProbe = ctx.createAnalyser();
// The full mix is taken after the limiter in renderer.js, so recordings get the same level-safe sound you hear.
master.connect(recDest);
limiter.connect(mixDest);
limiter.connect(mixProbe);
// Every video's sound (the source and both decks) meets on one bus before the limiter. The beat box
// (beat.js) ducks this bus on each kick, the sidechain pump of dance music, and its low cut is the
// filter sweep of a build. Both rest at "no effect".
const deckBus = ctx.createGain();
const deckLowCut = ctx.createBiquadFilter();
deckLowCut.type = 'highpass';
deckLowCut.frequency.value = 10;
deckLowCut.Q.value = 0.7;
deckBus.connect(deckLowCut).connect(limiter);

// Low cut on the decks: 0 = open (10 Hz), 1 = thin (about 2 kHz), over `seconds`.
function setDeckLowCut(v, seconds = 0.05) {
  const hz = 10 * Math.pow(200, Math.max(0, Math.min(1, v)));
  deckLowCut.frequency.cancelScheduledValues(ctx.currentTime);
  deckLowCut.frequency.setValueAtTime(deckLowCut.frequency.value, ctx.currentTime);
  deckLowCut.frequency.exponentialRampToValueAtTime(hz, ctx.currentTime + Math.max(0.01, seconds));
}

// Routes a <video>'s sound through the audio graph (a gain for level matching, then the deck bus and
// the limiter) so it can be leveled and recorded as well as heard. Returns the gain.
function tapElement(el) {
  const node = ctx.createMediaElementSource(el);
  // A low shelf in front of the gain is the deck's bass control: a DJ blends two records with the
  // incoming one's bass cut, then swaps the bass over, so two bass lines never fight.
  const bass = ctx.createBiquadFilter();
  bass.type = 'lowshelf';
  bass.frequency.value = 180;
  bass.gain.value = 0;
  // A DJ filter after it (setDeckFilter): a high-pass and a low-pass in series, both resting open.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 20;
  hp.Q.value = 0.9;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 20000;
  lp.Q.value = 0.9;
  const gain = ctx.createGain();
  node.connect(bass).connect(hp).connect(lp).connect(gain).connect(deckBus);
  gain.bass = bass;
  gain.hp = hp;
  gain.lp = lp;
  return gain;
}

// The DJ's one-knob filter on a deck, ramped over `seconds`: 0 = open; toward +1 a high-pass rises
// (20 Hz to 2.5 kHz: only the hats and the top line are left, how an incoming record is teased in);
// toward -1 a low-pass closes (20 kHz to 180 Hz: the record sinks to a muffled thud, how an outgoing
// one is taken away). Blends use both at once: the incoming opens while the outgoing closes.
function setDeckFilter(d, v, seconds = 0.05) {
  v = Math.max(-1, Math.min(1, v));
  d.filter = v;
  const hpHz = v > 0 ? 20 * Math.pow(125, v) : 20;
  const lpHz = v < 0 ? 20000 * Math.pow(180 / 20000, -v) : 20000;
  const t = ctx.currentTime;
  for (const [p, hz] of [[d.gain.hp.frequency, hpHz], [d.gain.lp.frequency, lpHz]]) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.exponentialRampToValueAtTime(hz, t + Math.max(0.01, seconds));
  }
}

// Deck bass: 1 = full, 0 = cut (about -36 dB below 180 Hz). Above 1 boosts the record's own bass
// (1.5 = +6 dB): the low end of a dance version that is always in tune and in time, being the record.
function setDeckBass(d, v) {
  d.bass = Math.max(0, Math.min(1.5, v));
  d.gain.bass.gain.setTargetAtTime(d.bass <= 1 ? -36 * (1 - d.bass) : 12 * (d.bass - 1), ctx.currentTime, 0.03);
  d.q('bass').value = Math.min(1, d.bass);
}
tapElement(srcVideo);

const DECK_HTML = (n) => `
  <div class="deckHead"><b>DECK ${n}</b><span class="deckTitle">Empty</span><span class="deckTime mono"></span></div>
  <div class="deckBar" title="Click to seek"><div class="deckPos"></div></div>
  <div class="deckCtl">
    <div class="row">
      <button data-a="loadSource" title="Load the video shown in the source panel">Load source</button>
      <button data-a="loadPad" title="Load the selected pad's clip">Load pad</button>
      <select data-a="recs" title="Load an earlier recording"></select>
      <button data-a="play" class="primary">Play</button>
      <button data-a="cue" title="Stop and return to the start">Cue</button>
      <button data-a="loop" class="on" title="Loop the deck">Loop</button>
      <button data-a="rec" class="recBtn" title="Record what the pads play (picture and sound) into this deck">● Rec pads</button>
    </div>
    <div class="row">
      <label>BPM <input data-a="bpm" type="number" step="0.1" min="20" max="400" placeholder="–" title="Type a BPM to change this deck's tempo to it"></label>
      <button data-a="half" title="Detected tempo is double the real one">÷2</button>
      <button data-a="dbl" title="Detected tempo is half the real one">×2</button>
      <button data-a="tap" title="Tap along to set the tempo by hand">Tap</button>
      <button data-a="sync" title="Match this deck's BPM to the other deck">Sync</button>
      <label>Tempo <input data-a="tempo" type="range" min="0.5" max="1.5" step="0.001" value="1" title="Double-click to reset"></label>
      <span data-a="pct" class="mono pct">0.0%</span>
      <button data-a="bendDown" title="Hold to slow down briefly (line up the beats)">−</button>
      <button data-a="bendUp" title="Hold to speed up briefly (line up the beats)">+</button>
    </div>
    <div class="row">
      <label>Vol <input data-a="vol" type="range" min="0" max="1" step="0.01" value="1"></label>
      <label title="Bass: cut it on the deck you are bringing in, then swap. Double-click for full.">Bass <input data-a="bass" type="range" min="0" max="1" step="0.01" value="1"></label>
      <label title="Keep the pitch when the tempo changes"><input data-a="keylock" type="checkbox" checked> Key lock</label>
      <button data-a="show" title="Show this deck in the viewer">Show in viewer</button>
    </div>
  </div>`;

function makeDeck(idx) {
  const name = 'AB'[idx];
  const root = $(`deck${name}`);
  root.innerHTML = DECK_HTML(name);
  const q = (a) => root.querySelector(`[data-a="${a}"]`);
  // The deck's picture lives in the shared viewer, not in the deck panel.
  const video = document.createElement('video');
  video.preload = 'auto';
  $('viewer').appendChild(video);
  const d = {
    idx, name, root, q, video, gain: tapElement(video), norm: 1,
    item: null, baseBpm: null, rate: 1, bend: 0, loop: true, vol: 1, bass: 1, playing: false, taps: [],
  };

  q('loadSource').addEventListener('click', () => {
    if (!currentSource) return toast('Fetch and select a video first.');
    loadDeck(d, { kind: 'source', title: currentSource.title, url: currentSource.url, file: currentSource.file, bpm: currentSource.bpm || null });
  });
  q('loadPad').addEventListener('click', () => {
    const clip = state.pads[selected];
    if (!clip) return toast('Select a pad that has a clip first.');
    const lp = clip.loop && clip.loop.beats ? clip.loop : null;
    loadDeck(d, {
      kind: 'clip', title: clip.name, url: clip.url, file: clip.file,
      bpm: clip.loop ? clip.loop.bpm : null, loopStart: lp ? lp.start : null, loopEnd: lp ? lp.end : null,
    });
  });
  q('recs').addEventListener('change', (e) => {
    const rec = state.recordings.find((r) => r.id === e.target.value);
    if (rec) loadDeck(d, { kind: 'rec', title: rec.title, url: rec.url, file: rec.file, bpm: rec.bpm || null });
    e.target.value = '';
    e.target.blur();
  });

  q('play').addEventListener('click', () => { if (d.item) setDeckPlaying(d, !d.playing); });
  q('cue').addEventListener('click', () => {
    if (!d.item) return;
    setDeckPlaying(d, false);
    d.video.currentTime = d.item.loopStart || 0;
    focusViewer('deck', d.idx);
  });
  q('loop').addEventListener('click', () => { d.loop = !d.loop; applyLoop(d); persistDecks(); });
  q('rec').addEventListener('click', () => toggleRec(d));
  q('show').addEventListener('click', () => focusViewer('deck', d.idx));
  d.video.addEventListener('ended', () => { if (!d.loop) setDeckPlaying(d, false); });

  q('bpm').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!(v >= 20 && v <= 400)) return renderDeck(d);
    // With a known tempo, typing a BPM retunes the deck to it; without one, it tells the deck its tempo.
    if (d.baseBpm) d.rate = Math.max(0.25, Math.min(4, v / d.baseBpm)); else setBaseBpm(d, v / d.rate);
    applyRate(d);
    e.target.blur();
  });
  q('half').addEventListener('click', () => { if (d.baseBpm) setBaseBpm(d, d.baseBpm / 2); });
  q('dbl').addEventListener('click', () => { if (d.baseBpm) setBaseBpm(d, d.baseBpm * 2); });
  q('tap').addEventListener('click', () => {
    const now = performance.now();
    if (d.taps.length && now - d.taps[d.taps.length - 1] > 2000) d.taps = [];
    d.taps.push(now);
    if (d.taps.length > 8) d.taps.shift();
    if (d.taps.length >= 4) setBaseBpm(d, 60000 / ((now - d.taps[0]) / (d.taps.length - 1)) / d.rate);
  });
  q('sync').addEventListener('click', () => syncDeck(d));

  q('tempo').addEventListener('input', (e) => { d.rate = Number(e.target.value); applyRate(d); });
  q('tempo').addEventListener('dblclick', () => { d.rate = 1; applyRate(d); });
  for (const [a, dir] of [['bendDown', -1], ['bendUp', 1]]) {
    q(a).addEventListener('mousedown', () => { d.bend = dir * 0.04; applyRate(d); });
    for (const ev of ['mouseup', 'mouseleave']) q(a).addEventListener(ev, () => { if (d.bend) { d.bend = 0; applyRate(d); } });
  }
  q('keylock').addEventListener('change', () => applyRate(d));
  q('vol').addEventListener('input', (e) => { d.vol = Number(e.target.value); applyVolumes(); persistDecks(); });
  q('bass').addEventListener('input', (e) => setDeckBass(d, Number(e.target.value)));
  q('bass').addEventListener('dblclick', () => setDeckBass(d, 1));
  root.querySelector('.deckBar').addEventListener('mousedown', (e) => {
    if (!d.video.duration) return;
    const box = e.currentTarget.getBoundingClientRect();
    d.video.currentTime = ((e.clientX - box.left) / box.width) * d.video.duration;
    focusViewer('deck', d.idx);
  });
  return d;
}

const deckBpm = (d) => (d.baseBpm ? d.baseBpm * d.rate : null);

function setBaseBpm(d, bpm) {
  d.baseBpm = bpm;
  if (d.item) d.item.bpm = bpm;
  renderDeck(d);
  persistDecks();
}

function applyRate(d) {
  d.video.preservesPitch = d.q('keylock').checked;
  d.video.playbackRate = Math.max(0.25, Math.min(4, d.rate * (1 + d.bend)));
  renderDeck(d);
}

function applyLoop(d) {
  // Clips with analyzed loop points are looped by hand in deckFrame; everything else loops the whole file.
  d.video.loop = d.loop && !(d.item && d.item.loopEnd);
  d.q('loop').classList.toggle('on', d.loop);
}

// Equal-power crossfade: both decks sit at about 71% in the middle, so the level stays even as you move across.
function applyVolumes() {
  const gains = [Math.cos((xfade * Math.PI) / 2), Math.sin((xfade * Math.PI) / 2)];
  for (const d of decks) {
    d.video.volume = Math.max(0, Math.min(1, d.vol * gains[d.idx]));
    // Level match: each deck's video is brought to the same loudness as the pads.
    d.gain.gain.setTargetAtTime(levelMatch ? d.norm : 1, ctx.currentTime, 0.02);
  }
}

// Measures a deck's video once (remembered on the item) and sets its level-match correction.
async function levelDeck(d, item) {
  try {
    if (!item.level) {
      if (!d.video.duration) await new Promise((r) => d.video.addEventListener('loadedmetadata', r, { once: true }));
      item.level = await window.api.level({ file: item.file, duration: d.video.duration });
    }
    if (d.item !== item) return;
    const { rms, peak } = item.level;
    d.norm = rms ? Math.max(0.125, Math.min(8, TARGET_RMS / rms, peak ? 0.98 / peak : 8)) : 1;
    applyVolumes();
  } catch (e) {
    console.warn(`deck ${d.name}: level measurement failed (${e.message})`);
  }
}

function setDeckPlaying(d, on) {
  d.playing = on;
  if (on) {
    if (ctx.state !== 'running') ctx.resume();
    d.video.play().catch(() => {});
    focusViewer('deck', d.idx);
  } else d.video.pause();
  d.q('play').textContent = on ? 'Pause' : 'Play';
  d.root.classList.toggle('playing', on);
}

function renderDeck(d) {
  d.root.querySelector('.deckTitle').textContent = d.item ? d.item.title : 'Empty — load a video or record the pads';
  const bpm = deckBpm(d);
  const input = d.q('bpm');
  if (document.activeElement !== input) input.value = bpm ? bpm.toFixed(1) : '';
  d.q('tempo').value = d.rate;
  const pct = (d.rate - 1) * 100;
  d.q('pct').textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  for (const a of ['half', 'dbl', 'sync']) d.q(a).disabled = !d.baseBpm;
  for (const a of ['play', 'cue', 'tap', 'show']) d.q(a).disabled = !d.item;
}

function renderRecLists() {
  for (const d of decks) {
    const sel = d.q('recs');
    sel.innerHTML = `<option value="">Recordings (${state.recordings.length})</option>`;
    for (const r of [...state.recordings].reverse()) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.title;
      sel.appendChild(o);
    }
    sel.disabled = !state.recordings.length;
  }
}

function persistDecks() {
  state.decks = decks.map((d) => ({ item: d.item, loop: d.loop, vol: d.vol }));
  state.xfade = xfade;
  save();
}

async function loadDeck(d, item, autoplay) {
  setDeckPlaying(d, false);
  d.item = item;
  d.baseBpm = item.bpm || null;
  d.rate = 1;
  d.video.src = item.url;
  d.video.load();
  applyLoop(d);
  applyRate(d);
  applyVolumes();
  persistDecks();
  if (autoplay) setDeckPlaying(d, true);
  d.norm = 1;
  if (item.file) await levelDeck(d, item);
  if (!d.baseBpm && item.file) {
    // Tempo is found in the background; the deck is playable meanwhile.
    try {
      if (!d.video.duration) await new Promise((r) => d.video.addEventListener('loadedmetadata', r, { once: true }));
      const bpm = await window.api.bpm({ file: item.file, duration: d.video.duration });
      if (d.item === item && bpm && !d.baseBpm) {
        setBaseBpm(d, bpm);
        const src = item.kind === 'source' && state.sources.find((s) => s.file === item.file);
        if (src) { src.bpm = bpm; save(); }
      }
    } catch (e) {
      console.warn(`deck ${d.name}: tempo detection failed (${e.message})`);
    }
  }
}

// Matches this deck's tempo to the other deck, picking the nearest octave so the speed change stays small.
function syncDeck(d) {
  const other = decks[1 - d.idx];
  const target = deckBpm(other);
  if (!target || !d.baseBpm) return toast(`Deck ${other.name} needs a BPM to sync to.`);
  let r = target / d.baseBpm;
  while (r > Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  d.rate = r;
  applyRate(d);
}

// ---------- the viewer ----------
// One large picture. A pad that is sounding always shows; otherwise it shows whichever of the source
// or the decks you touched last. Two decks playing together blend by the crossfader.
let viewerHold = { kind: 'src', deck: 0 };
let viewerLayers = []; // [{ el, alpha }] bottom to top; also what the output recording draws
let viewerShown = []; // the layers last shown at rest (what a dissolve fades away from)
let viewerTop = null;
let viewerFade = null; // { from, start, ms } while a dissolve is running

function focusViewer(kind, deck) {
  viewerHold = { kind, deck: deck == null ? viewerHold.deck : deck };
}

function updateViewer() {
  // `noPic` pads are heard but never shown (a juggled bar of a song whose picture is only its cover).
  let topPad = null;
  for (let k = liveOrder.length - 1; k >= 0; k--) if (!rt[liveOrder[k]].noPic) { topPad = liveOrder[k]; break; }
  let layers = [];
  let label = '';
  if (topPad != null && rt[topPad].video) {
    layers = [{ el: rt[topPad].video, alpha: 1 }];
    label = `Pad ${KEYS[topPad % N].toUpperCase()} · ${state.pads[topPad] ? state.pads[topPad].name : ''}`;
  } else if (viewerHold.kind === 'deck' && decks.length) {
    const playing = decks.filter((d) => d.playing && d.item);
    if (playing.length === 2) {
      layers = [{ el: decks[0].video, alpha: 1 }, { el: decks[1].video, alpha: xfade }];
      label = 'Decks A + B · crossfade';
    } else {
      const d = playing[0] || decks[viewerHold.deck];
      if (d.item) { layers = [{ el: d.video, alpha: 1 }]; label = `Deck ${d.name} · ${d.item.title}`; }
    }
  } else if (currentSource) {
    layers = [{ el: srcVideo, alpha: 1 }];
    label = `Source · ${currentSource.title}`;
  }
  // Dissolve: when what is on top changes, keep the old picture underneath and fade the new one in
  // over the Blend time. The same layers feed the output recording, so takes get the dissolve too.
  const top = layers.length ? layers[layers.length - 1].el : null;
  const now = performance.now();
  if (top !== viewerTop) {
    if (blend > 0 && top && viewerShown.length) viewerFade = { from: viewerShown.filter((l) => l.el.isConnected), start: now, ms: blend * 1000 };
    else viewerFade = null;
    viewerTop = top;
  }
  if (viewerFade) {
    const p = (now - viewerFade.start) / viewerFade.ms;
    if (p >= 1) viewerFade = null;
    else {
      const incoming = new Set(layers.map((l) => l.el));
      layers = [...viewerFade.from.filter((l) => !incoming.has(l.el)), ...layers.map((l) => ({ el: l.el, alpha: l.alpha * p }))];
    }
  }
  if (!viewerFade) viewerShown = layers;
  viewerLayers = layers;
  if (typeof fxNote === 'function') fxNote(layers);
  const vids = $('viewer').getElementsByTagName('video');
  for (let k = 0; k < vids.length; k++) {
    const at = layers.findIndex((l) => l.el === vids[k]);
    vids[k].style.visibility = at >= 0 && layers[at].alpha > 0 ? 'visible' : 'hidden';
    vids[k].style.opacity = at >= 0 ? layers[at].alpha : 1;
    vids[k].style.zIndex = at >= 0 ? at + 1 : 0;
  }
  $('viewerLabel').textContent = label;
  $('srcEmpty').hidden = layers.length > 0;
}

// ---------- recording ----------
function paintLayers(g, canvas, layers) {
  if (typeof fxActive === 'function' && fxActive()) return fxPaint(g, canvas, layers);
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const { el, alpha } of layers) {
    if (!el || !el.videoWidth || alpha <= 0) continue;
    const s = Math.min(canvas.width / el.videoWidth, canvas.height / el.videoHeight);
    const w = el.videoWidth * s;
    const h = el.videoHeight * s;
    g.globalAlpha = alpha;
    g.drawImage(el, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  g.globalAlpha = 1;
}

// A title drawn over the recorded output (not over the app): a headline with an optional second line,
// either as a lower third or centered as a full card. Set to null to clear.
let outTitle = null;
function setOutputTitle(t) {
  outTitle = t ? { ...t, at: performance.now() } : null;
}
function paintTitle(g, canvas) {
  if (!outTitle) return;
  const { title, sub, center, at } = outTitle;
  const a = Math.min(1, (performance.now() - at) / 220);
  const w = canvas.width;
  const h = canvas.height;
  g.save();
  g.globalAlpha = a;
  const shade = g.createLinearGradient(0, center ? 0 : h * 0.5, 0, h);
  shade.addColorStop(0, center ? 'rgba(0,0,0,.38)' : 'rgba(0,0,0,0)');
  shade.addColorStop(1, center ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.82)');
  g.fillStyle = shade;
  g.fillRect(0, center ? 0 : h * 0.5, w, center ? h : h * 0.5);
  g.textAlign = center ? 'center' : 'left';
  g.textBaseline = 'alphabetic';
  const x = center ? w / 2 : 70;
  const y = center ? h * 0.5 : h - 118;
  const slide = (1 - a) * 18;
  // Shrink the headline until it fits the frame.
  let size = center ? 104 : 66;
  do { g.font = `800 ${size}px "Segoe UI", sans-serif`; size -= 4; } while (g.measureText(title).width > w - 140 && size > 28);
  g.fillStyle = '#ff5a36';
  if (center) g.fillRect(w / 2 - 60, y - size - 36 + slide, 120, 8); else g.fillRect(x, y - size - 22 + slide, 90, 7);
  g.fillStyle = '#fff';
  g.shadowColor = 'rgba(0,0,0,.7)';
  g.shadowBlur = 18;
  g.fillText(title, x, y + slide);
  if (sub) {
    let s2 = center ? 52 : 32;
    do { g.font = `500 ${s2}px "Segoe UI", sans-serif`; s2 -= 2; } while (g.measureText(sub).width > w - 140 && s2 > 18);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.fillText(sub, x, y + (center ? 76 : 50) + slide);
  }
  g.restore();
}

// Records a picture (repainted every frame by getLayers) together with an audio stream.
// stop() resolves with the recorded bytes and how long it ran.
function startCapture(getLayers, audioStream, onTick, overlay) {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  for (const t of audioStream.getAudioTracks()) stream.addTrack(t);
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  const started = performance.now();
  // Painted on a timer, not on animation frames: those stop when the window is covered or minimized,
  // which would leave a recording black while its sound carried on.
  const draw = () => {
    updateViewer();
    paintLayers(g, canvas, getLayers());
    if (overlay) overlay(g, canvas);
    if (onTick) onTick((performance.now() - started) / 1000);
  };
  const timer = setInterval(draw, 33);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => {
    recorder.onstop = async () => {
      clearInterval(timer);
      const seconds = (performance.now() - started) / 1000;
      const bytes = chunks.length ? new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()) : null;
      resolve({ bytes, seconds });
    };
  });
  if (ctx.state !== 'running') ctx.resume();
  draw();
  recorder.start(250);
  return { stop: () => { if (recorder.state !== 'inactive') recorder.stop(); return done; } };
}

// Deck recording: the pads only (picture of the pad being played + pad sound) into this deck.
async function toggleRec(d) {
  const btn = d.q('rec');
  if (recState) {
    if (recState.deck !== d) return toast(`Deck ${recState.deck.name} is recording — stop it first.`);
    const rs = recState;
    recState = null;
    d.root.classList.remove('recording');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      const { bytes, seconds } = await rs.cap.stop();
      if (!bytes || seconds < 0.3) { toast('Recording too short.'); return; }
      const rec = await window.api.saveRecording(bytes, `Take ${state.recordings.length + 1} · deck ${d.name} · ${seconds.toFixed(1)}s`);
      state.recordings.push(rec);
      save();
      renderRecLists();
      d.loop = true;
      await loadDeck(d, { kind: 'rec', title: rec.title, url: rec.url, file: rec.file, bpm: null }, true);
    } catch (e) {
      toast(`Recording failed: ${e.message}`);
    } finally {
      btn.textContent = '● Rec pads';
      btn.disabled = false;
    }
    return;
  }
  setDeckPlaying(d, false);
  d.root.classList.add('recording');
  const padLayer = () => {
    const top = liveOrder[liveOrder.length - 1];
    return top != null && rt[top].video ? [{ el: rt[top].video, alpha: 1 }] : [];
  };
  recState = { deck: d, cap: startCapture(padLayer, recDest.stream, (s) => { btn.textContent = `■ Stop ${s.toFixed(1)}s`; }) };
}

// Final output: exactly what the viewer shows, with pads, source and both decks all in the sound.
async function toggleOutputRec() {
  const btn = $('recOutBtn');
  if (outState) {
    const os = outState;
    outState = null;
    document.body.classList.remove('recOut');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    try {
      const { bytes, seconds } = await os.cap.stop();
      if (!bytes || seconds < 0.3) { toast('Recording too short.'); return; }
      const n = state.recordings.filter((r) => r.final).length + 1;
      const rec = await window.api.saveRecording(bytes, `Final take ${n} · ${seconds.toFixed(1)}s`);
      rec.final = true;
      state.recordings.push(rec);
      save();
      renderRecLists();
      toast(`Saved ${rec.title} as ${rec.file.split(/[\\/]/).pop()} — the Folder button opens it.`);
      return rec;
    } catch (e) {
      toast(`Recording failed: ${e.message}`);
    } finally {
      btn.textContent = '● Record output';
      btn.disabled = false;
    }
    return;
  }
  document.body.classList.add('recOut');
  outState = { cap: startCapture(() => viewerLayers, mixDest.stream, (s) => { btn.textContent = `■ Stop ${s.toFixed(1)}s`; }, paintTitle) };
}

// ---------- per-frame upkeep ----------
function deckFrame() {
  for (const d of decks) {
    const v = d.video;
    const it = d.item;
    if (!it) continue;
    if (d.loop && it.loopEnd && (v.currentTime >= it.loopEnd || v.ended)) {
      v.currentTime = it.loopStart || 0;
      if (d.playing && v.paused) v.play().catch(() => {});
    }
    const dur = v.duration || 0;
    d.root.querySelector('.deckPos').style.width = dur ? `${(v.currentTime / dur) * 100}%` : '0';
    d.root.querySelector('.deckTime').textContent = dur ? `${fmt(v.currentTime)} / ${fmt(dur)}` : '';
  }
}

function initDecks() {
  state.recordings = state.recordings || [];
  decks.push(makeDeck(0), makeDeck(1));
  xfade = typeof state.xfade === 'number' ? state.xfade : 0.5;
  $('xfade').value = xfade;
  $('xfade').addEventListener('input', (e) => { xfade = Number(e.target.value); applyVolumes(); persistDecks(); });
  $('xfade').addEventListener('dblclick', () => { xfade = 0.5; $('xfade').value = 0.5; applyVolumes(); persistDecks(); });
  $('decksBtn').addEventListener('click', () => {
    const hidden = $('deckRow').classList.toggle('hidden');
    $('decksBtn').classList.toggle('on', !hidden);
  });
  $('recOutBtn').addEventListener('click', toggleOutputRec);
  renderRecLists();
  const saved = state.decks || [];
  for (const d of decks) {
    const s = saved[d.idx];
    if (s) { d.loop = s.loop !== false; d.vol = typeof s.vol === 'number' ? s.vol : 1; d.q('vol').value = d.vol; }
    if (s && s.item) loadDeck(d, s.item); else { applyLoop(d); renderDeck(d); }
  }
  applyVolumes();
  focusViewer('src');
  setInterval(deckFrame, 16); // a timer, so deck loops keep time even when the window is covered
}

// Smoke-test only: load, retune and sync the decks, record a pad into deck B, then record the final output.
window.__smokeDecks = async (source) => {
  const [a, b] = decks;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const level = () => {
    const buf = new Float32Array(mixProbe.fftSize);
    let peak = 0;
    for (let k = 0; k < 12; k++) { mixProbe.getFloatTimeDomainData(buf); for (const s of buf) peak = Math.max(peak, Math.abs(s)); }
    return +peak.toFixed(3);
  };
  const out = { silentLevel: level() };
  $('xfade').value = 0;
  $('xfade').dispatchEvent(new Event('input'));
  await loadDeck(a, { kind: 'source', title: 'smoke', url: source.url, file: source.file, bpm: null }, true);
  const aBpm = a.baseBpm;
  a.q('bpm').value = '132';
  a.q('bpm').dispatchEvent(new Event('change'));
  let deckLevel = 0;
  for (let k = 0; k < 12; k++) { await wait(60); deckLevel = Math.max(deckLevel, level()); }
  updateViewer();
  Object.assign(out, {
    aBpm, aBpmAfterSet: deckBpm(a), aRate: +a.video.playbackRate.toFixed(3), aPlaying: !a.video.paused && a.video.currentTime > 0,
    deckAudioLevel: deckLevel, viewerShows: $('viewerLabel').textContent, volumesAtA: decks.map((d) => +d.video.volume.toFixed(2)),
  });
  await loadDeck(b, { kind: 'source', title: 'smoke', url: source.url, file: source.file, bpm: aBpm });
  syncDeck(b);
  out.syncedBpm = deckBpm(b);
  // Record: put a clip on pad 0, play it while deck B records.
  currentSource = source;
  await doCut(0, 1.3, 3.9);
  state.pads[0].mode = 'oneshot';
  await toggleRec(b);
  await wait(200);
  play(0, 1);
  await wait(300);
  updateViewer();
  out.viewerDuringPad = $('viewerLabel').textContent;
  await wait(1200);
  await toggleRec(b);
  for (let i = 0; i < 100 && !(b.item && b.item.kind === 'rec' && b.video.duration); i++) await wait(100);
  out.recLoaded = !!(b.item && b.item.kind === 'rec');
  out.recSeconds = +(b.video.duration || 0).toFixed(2);
  out.recHasPicture = b.video.videoWidth;
  await wait(400);
  out.recPlaying = !b.video.paused;
  out.aStillPlayingDuringRec = !a.video.paused;
  // Blend: a second clip taking over from the first dissolves in; a stopped clip's picture runs on for the tail.
  for (const d of decks) setDeckPlaying(d, false);
  await doCut(1, 4.3, 6.9);
  state.pads[1].mode = 'oneshot';
  setBlend(0.4);
  play(0, 1);
  await wait(300);
  play(1, 1);
  await wait(150);
  updateViewer();
  out.blend = { midLayers: viewerLayers.length, midAlpha: viewerLayers.length ? +viewerLayers[viewerLayers.length - 1].alpha.toFixed(2) : null };
  await wait(500);
  updateViewer();
  out.blend.afterLayers = viewerLayers.length;
  stop(0);
  stop(1);
  await wait(120);
  out.blend.tailStillRunning = !rt[1].video.paused;
  await wait(500);
  out.blend.tailEnded = rt[1].video.paused;
  setBlend(0);
  play(0, 1);
  await wait(100);
  play(1, 1);
  await wait(60);
  updateViewer();
  out.blend.hardCutLayers = viewerLayers.length;
  stopAll();
  setBlend(0.25);
  // Final output: both decks playing, crossfader centered, 1.5 s.
  for (const d of decks) setDeckPlaying(d, true);
  $('xfade').value = 0.5;
  $('xfade').dispatchEvent(new Event('input'));
  await toggleOutputRec();
  await wait(1500);
  updateViewer();
  out.viewerDuringOutput = $('viewerLabel').textContent;
  out.outputLayers = viewerLayers.length;
  const final = await toggleOutputRec();
  out.finalSaved = !!final;
  out.finalTitle = final ? final.title : null;
  out.videosInViewer = $('viewer').getElementsByTagName('video').length;
  for (const d of decks) setDeckPlaying(d, false);
  // Delete key clears the selected pad.
  select(0);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await wait(300);
  out.deleteKeyCleared = !state.pads[0];
  return out;
};
