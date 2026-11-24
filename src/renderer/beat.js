'use strict';
// Beat box: a drum machine in the spirit of the 909, synthesized live (nothing sampled) and locked to a
// tempo, for turning any record into a dance record under the decks.
//   kick   four on the floor, a falling sine with a click
//   clap   on 2 and 4, three bursts of filtered noise
//   hat    open hats on the off-beats, closed sixteenths under them
//   bass   an off-beat bass on each bar's root note (the classic dance bass that sits between kicks)
//   roll   a snare roll for a build: eighths, then sixteenths, then thirty-seconds, rising in level
// Each kick ducks the decks (`deckBus` in decks.js) and comes back over most of a beat: the sidechain
// pump. Everything goes to the limiter, so it is heard, recorded in "Record output", and level-safe.
const beatBus = ctx.createGain();
// Measured against the original record (scripts/compare-mix.js): at 0.9 the kit and the pump took
// about 5 dB of share from the record's mids (its voice and guitars). The beat is an addition.
beatBus.gain.value = 0.5;
beatBus.connect(limiter);

const beat = {
  on: false,
  bpm: 128,
  start: 0, // ctx time of bar 0's downbeat
  parts: { kick: true, clap: false, hat: false, closed: false, bass: false },
  duck: 0.5, // 0..1, how far each kick pulls the decks down (0.5 is about -6 dB)
  hats: 1, // hat level (lower them over a quiet intro)
  roots: [], // MIDI note of the bass for each bar (cycled); empty = no bass
  roll: null, // { from, to } in bars, a snare roll
  nextStep: 0, // next sixteenth to schedule, counted from `start`
  timer: null,
  // Follow mode: play on a record's own tracked beats (src/beats.js) instead of a fixed grid, so the
  // beat stays with a live drummer. { deck, beats: [song seconds], down: index in `beats` of bar 0's
  // first beat (may be negative; the grid is extended at either end), offset: seconds added to every
  // hit, m: smoothed audio-clock minus song-time, next: next sixteenth }.
  follow: null,
};

let noiseBuf = null;
function noise() {
  if (noiseBuf) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
  return noiseBuf;
}

function env(t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function burst(t, { type, freq, q = 1, peak, decay, attack = 0.001 }) {
  const s = ctx.createBufferSource();
  s.buffer = noise();
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(t, peak, attack, decay);
  s.connect(f).connect(g).connect(beatBus);
  s.start(t, Math.random() * 0.5);
  s.stop(t + attack + decay + 0.05);
}

function kickAt(t) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
  const g = env(t, 1.0, 0.002, 0.42);
  o.connect(g).connect(beatBus);
  o.start(t);
  o.stop(t + 0.5);
  burst(t, { type: 'highpass', freq: 3000, peak: 0.25, decay: 0.012 });
  // The pump: the decks drop under the kick and swell back over most of the beat.
  if (beat.duck > 0) {
    const beatLen = 60 / beat.bpm;
    const low = Math.max(0.05, 1 - beat.duck);
    deckBus.gain.cancelAndHoldAtTime(t); // carry on from wherever the last swell had got to: no jump, no click
    deckBus.gain.linearRampToValueAtTime(low, t + 0.008);
    deckBus.gain.setTargetAtTime(1, t + 0.03, beatLen * 0.28);
  }
}

function clapAt(t, level = 1) {
  for (const [dt, p] of [[0, 0.35], [0.011, 0.3], [0.022, 0.45]]) burst(t + dt, { type: 'bandpass', freq: 1400, q: 1.2, peak: p * level, decay: dt < 0.02 ? 0.01 : 0.16 });
}

function hatAt(t, open) {
  burst(t, { type: 'highpass', freq: open ? 7000 : 9000, peak: Math.max(0.002, (open ? 0.22 : 0.09) * beat.hats), decay: open ? 0.14 : 0.035 });
}

function bassAt(t, midi, len) {
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  const g = env(t, 0.55, 0.004, len);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 6;
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(140, t + len);
  for (const [type, det, lvl] of [['sawtooth', -7, 0.5], ['sawtooth', 7, 0.5], ['sine', 0, 0.9]]) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = type === 'sine' ? hz / 2 : hz;
    o.detune.value = det;
    const m = ctx.createGain();
    m.gain.value = lvl;
    o.connect(m).connect(f);
    o.start(t);
    o.stop(t + len + 0.05);
  }
  f.connect(g).connect(beatBus);
}

// A rising noise sweep, for the bars before a drop.
function riser(t, seconds) {
  const s = ctx.createBufferSource();
  s.buffer = noise();
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 2.5;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(9000, t + seconds);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + seconds); // measured: 0.35 stood 17 dB out in the air band at its peak
  g.gain.linearRampToValueAtTime(0, t + seconds + 0.02);
  s.connect(f).connect(g).connect(beatBus);
  s.start(t);
  s.stop(t + seconds + 0.05);
}

function scheduleStep(n, t) {
  const p = beat.parts;
  const step = ((n % 16) + 16) % 16; // sixteenth in the bar
  const bar = Math.floor(n / 16);
  const sixteenth = 15 / beat.bpm;
  if (p.kick && step % 4 === 0) kickAt(t);
  if (p.clap && (step === 4 || step === 12)) clapAt(t);
  if (p.hat && step % 4 === 2) hatAt(t, true);
  if (p.closed && step % 2 === 1) hatAt(t, false);
  const root = beat.follow ? beat.roots[bar] : beat.roots[bar % (beat.roots.length || 1)];
  if (p.bass && root != null && step % 4 === 2) bassAt(t, root, sixteenth * 1.7); // null = rest (an unsure bar)
  const r = beat.roll;
  if (r && n / 16 >= r.from && n / 16 < r.to) {
    const prog = (n / 16 - r.from) / (r.to - r.from);
    const every = prog < 0.5 ? 2 : 1; // eighths, then sixteenths
    if (step % every === 0) clapAt(t, 0.35 + 0.65 * prog);
    if (prog >= 0.75) clapAt(t + sixteenth / 2, 0.35 + 0.65 * prog); // thirty-seconds at the end
  }
}

// The song time of sixteenth n in follow mode: between the two tracked beats it falls between.
function followSongTime(f, n) {
  const B = f.beats;
  const q = Math.floor(n / 4);
  const i = f.down + q;
  const frac = (n - 4 * q) / 4;
  const at = (k) => {
    if (k < 0) return B[0] + k * (B[1] - B[0]);
    if (k >= B.length) return B[B.length - 1] + (k - B.length + 1) * (B[B.length - 1] - B[B.length - 2]);
    return B[k];
  };
  return at(i) + frac * (at(i + 1) - at(i));
}

// Follow mode: map the record's song time to the audio clock through the deck's live position.
// The mapping is smoothed (a slow phase lock, as DJ software syncs to a playing deck) so the
// coarse steps of a video's currentTime do not jitter the hits; a jump (a seek, a new deck) resets it.
function followTick() {
  const f = beat.follow;
  const v = f.deck.video;
  if (!f.deck.playing || v.paused || v.seeking) { f.next = null; return; }
  const rate = v.playbackRate || 1;
  const m = ctx.currentTime - v.currentTime / rate;
  if (f.m == null || Math.abs(m - f.m) > 0.06) { f.m = m; f.next = null; } else f.m += 0.04 * (m - f.m);
  const now = v.currentTime;
  if (f.next == null) {
    // The first sixteenth at or after the deck's position.
    let n = Math.floor(((now - f.beats[0]) / ((f.beats[f.beats.length - 1] - f.beats[0]) / (f.beats.length - 1)) - f.down) * 4) - 8;
    while (followSongTime(f, n) < now - 0.002) n++;
    f.next = n;
  }
  for (;;) {
    const s = followSongTime(f, f.next);
    const t = f.m + s / rate + (f.offset || 0);
    if (t > ctx.currentTime + 0.12) break;
    if (t >= ctx.currentTime - 0.005) scheduleStep(f.next, t);
    f.next++;
  }
}

function beatTick() {
  if (!beat.on) return;
  if (beat.follow) return followTick();
  const sixteenth = 15 / beat.bpm;
  const horizon = ctx.currentTime + 0.15;
  for (;;) {
    const t = beat.start + beat.nextStep * sixteenth;
    if (t > horizon) break;
    if (t >= ctx.currentTime - 0.01) scheduleStep(beat.nextStep, t);
    beat.nextStep++;
  }
}

// Starts the beat with bar 0 on `at` (ctx time; default now). Options override `beat` fields.
function startBeat(opts = {}) {
  Object.assign(beat, opts, { parts: { ...beat.parts, ...(opts.parts || {}) } });
  if (!('follow' in opts)) beat.follow = null;
  beat.start = opts.at != null ? opts.at : ctx.currentTime + 0.02;
  beat.nextStep = 0;
  beat.on = true;
  if (!beat.timer) beat.timer = setInterval(beatTick, 20);
  beatTick();
}

function setBeatParts(parts) { Object.assign(beat.parts, parts); }

function stopBeat() {
  beat.on = false;
  beat.follow = null;
  deckBus.gain.cancelScheduledValues(ctx.currentTime);
  deckBus.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
}

// The bar the beat is in now (fractional), for scripts that need to line things up with it.
function beatBar() { return beat.on ? (ctx.currentTime - beat.start) / (240 / beat.bpm) : null; }

// The mixer's controls: Beat toggles a full beat at the playing deck's tempo (bar 0 = the press);
// Lo cut sweeps the decks' low cut.
function initBeat() {
  const btn = $('beatBtn');
  btn.addEventListener('click', async () => {
    if (beat.on) { stopBeat(); btn.classList.remove('on'); return; }
    const parts = { kick: true, clap: true, hat: true, closed: true, bass: false };
    const d = decks.find((x) => x.playing && x.item);
    // A record on a deck: track its beats (once; a few seconds) and play on them, so the beat stays
    // with the band even where its tempo moves. Anything else: a fixed grid from the press.
    if (d && d.item.file && d.item.kind !== 'rec') {
      btn.textContent = 'Tracking…';
      btn.disabled = true;
      try {
        const tr = await window.api.beats({ file: d.item.file, bpm: d.item.bpm || 120 });
        startBeat({ bpm: tr.bpm * (d.video.playbackRate || 1), parts, follow: { deck: d, beats: tr.beats, down: tr.downbeat, offset: 0 } });
      } catch (e) {
        toast(`Beat tracking failed (${e.message}); playing a fixed grid.`);
        startBeat({ bpm: (d.item.bpm || 128) * (d.video.playbackRate || 1), parts });
      } finally {
        btn.textContent = 'Beat';
        btn.disabled = false;
      }
    } else {
      const bpm = d && d.item.bpm ? d.item.bpm * (d.video.playbackRate || 1) : 128;
      startBeat({ bpm, parts });
    }
    btn.classList.add('on');
  });
  $('lowCut').addEventListener('input', (e) => setDeckLowCut(Number(e.target.value)));
  $('lowCut').addEventListener('dblclick', () => { $('lowCut').value = 0; setDeckLowCut(0); });
}

// Smoke-test only: the beat must sound, and the kick must duck the decks.
window.__smokeBeat = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const probe = ctx.createAnalyser();
  probe.fftSize = 2048;
  beatBus.connect(probe);
  const buf = new Float32Array(probe.fftSize);
  startBeat({ bpm: 120, parts: { kick: true, clap: true, hat: true, closed: true, bass: true }, roots: [36] });
  let peak = 0;
  let minDuck = 1;
  for (let k = 0; k < 60; k++) {
    await wait(20);
    probe.getFloatTimeDomainData(buf);
    for (const v of buf) peak = Math.max(peak, Math.abs(v));
    minDuck = Math.min(minDuck, deckBus.gain.value);
  }
  stopBeat();
  await wait(200);
  beatBus.disconnect(probe);
  return { peak: +peak.toFixed(3), minDuck: +minDuck.toFixed(3), restored: +deckBus.gain.value.toFixed(3) };
};
