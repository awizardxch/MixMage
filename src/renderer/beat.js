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
beatBus.gain.value = 0.9;
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
  const step = n % 16; // sixteenth in the bar
  const bar = Math.floor(n / 16);
  const sixteenth = 15 / beat.bpm;
  if (p.kick && step % 4 === 0) kickAt(t);
  if (p.clap && (step === 4 || step === 12)) clapAt(t);
  if (p.hat && step % 4 === 2) hatAt(t, true);
  if (p.closed && step % 2 === 1) hatAt(t, false);
  if (p.bass && beat.roots.length && step % 4 === 2) bassAt(t, beat.roots[bar % beat.roots.length], sixteenth * 1.7);
  const r = beat.roll;
  if (r && n / 16 >= r.from && n / 16 < r.to) {
    const prog = (n / 16 - r.from) / (r.to - r.from);
    const every = prog < 0.5 ? 2 : 1; // eighths, then sixteenths
    if (step % every === 0) clapAt(t, 0.35 + 0.65 * prog);
    if (prog >= 0.75) clapAt(t + sixteenth / 2, 0.35 + 0.65 * prog); // thirty-seconds at the end
  }
}

function beatTick() {
  if (!beat.on) return;
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
  beat.start = opts.at != null ? opts.at : ctx.currentTime + 0.02;
  beat.nextStep = 0;
  beat.on = true;
  if (!beat.timer) beat.timer = setInterval(beatTick, 20);
  beatTick();
}

function setBeatParts(parts) { Object.assign(beat.parts, parts); }

function stopBeat() {
  beat.on = false;
  deckBus.gain.cancelScheduledValues(ctx.currentTime);
  deckBus.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
}

// The bar the beat is in now (fractional), for scripts that need to line things up with it.
function beatBar() { return beat.on ? (ctx.currentTime - beat.start) / (240 / beat.bpm) : null; }

// The mixer's controls: Beat toggles a full beat at the playing deck's tempo (bar 0 = the press);
// Lo cut sweeps the decks' low cut.
function initBeat() {
  $('beatBtn').addEventListener('click', () => {
    if (beat.on) { stopBeat(); $('beatBtn').classList.remove('on'); return; }
    const d = decks.find((x) => x.playing && x.item && x.item.bpm);
    const bpm = d ? d.item.bpm * (d.video.playbackRate || 1) : 128;
    startBeat({ bpm, parts: { kick: true, clap: true, hat: true, closed: true, bass: false } });
    $('beatBtn').classList.add('on');
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
