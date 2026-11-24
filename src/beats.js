'use strict';
// Beat tracking for records played by people: finds every beat, so added drums follow a live
// drummer who speeds up and slows down, instead of a fixed grid that drifts off the band. It takes
// the best-proven parts of the open-source music-analysis tools:
//
//   Onset strength (librosa): spectral flux over 40 log-spaced bands, log-compressed, averaged.
//   More onset functions (aubio, Essentia): high-frequency content (snare and hats) and low-band
//     flux (kicks), each a different view of where the beats are.
//   Beat tracking (librosa / Ellis 2007): dynamic programming that picks the beats landing on
//     strong onsets while keeping neighboring gaps near the tempo's period; the tempo may wander,
//     a sudden skip may not.
//   Multi-feature agreement (Essentia's BeatTrackerMultiFeature): track the beats from each onset
//     function separately and keep the sequence the others agree with most.
//   Peak picking (aubio): move each beat onto the strongest onset within 17 ms.
//   Smoothing: pull each beat a quarter of the way toward its neighbors' midpoint; noise is evened,
//     real drift is kept.
//   Downbeats: chords change on the one (bass chroma novelty) and the kick lands on 1 and 3.
//   Bass roots (librosa HPSS + KeyFinder-style chroma, as in Mixxx): separate the harmonic part of
//     the low end from the drums by median filtering, then take the strongest pitch class of each
//     bar, with a confidence (top against runner-up). An unsure bar keeps the last sure root.
const RATE = 22050;
const HOP = 128; // 5.8 ms
const NFFT = 1024;
const TIGHT = 100;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Three onset functions, one frame per HOP: log-band flux, high-frequency content, low-band flux.
function onsets(x) {
  const frames = Math.floor((x.length - NFFT) / HOP);
  const win = new Float64Array(NFFT).map((_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / NFFT));
  const nb = 40;
  const edges = Array.from({ length: nb + 2 }, (_, k) => Math.round(((30 * Math.pow(8000 / 30, k / (nb + 1))) * NFFT) / RATE));
  const kickHi = Math.round((150 * NFFT) / RATE);
  const band = new Float64Array(frames);
  const hfc = new Float64Array(frames);
  const kick = new Float64Array(frames);
  let prevB = new Float64Array(nb);
  let prevH = 0;
  let prevK = 0;
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const mag = new Float64Array(NFFT / 2);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < NFFT; k++) { re[k] = (x[f * HOP + k] / 32768) * win[k]; im[k] = 0; }
    fft(re, im);
    let h = 0;
    let lowE = 0;
    for (let b = 1; b < NFFT / 2; b++) {
      mag[b] = Math.hypot(re[b], im[b]);
      h += b * mag[b] * mag[b];
      if (b <= kickHi) lowE += mag[b] * mag[b];
    }
    const cur = new Float64Array(nb);
    let s = 0;
    for (let k = 0; k < nb; k++) {
      let e = 0;
      for (let b = edges[k]; b <= Math.max(edges[k], edges[k + 2]); b++) e += mag[b] * mag[b];
      cur[k] = Math.log1p(1000 * e);
      s += Math.max(0, cur[k] - prevB[k]);
    }
    band[f] = s / nb;
    const lh = Math.log1p(h);
    hfc[f] = Math.max(0, lh - prevH);
    const lk = Math.log1p(1000 * lowE);
    kick[f] = Math.max(0, lk - prevK);
    prevB = cur;
    prevH = lh;
    prevK = lk;
  }
  // Take away the local average (about a second), so loud passages do not outweigh quiet ones.
  const detrend = (o) => {
    const w = Math.round(RATE / HOP / 2);
    const out = new Float64Array(o.length);
    let acc = 0;
    for (let k = 0; k < o.length; k++) {
      acc += o[k] - (k - 2 * w >= 0 ? o[k - 2 * w] : 0);
      out[k] = Math.max(0, o[k] - acc / Math.min(k + 1, 2 * w));
    }
    let sd = 0;
    for (const v of out) sd += v * v;
    sd = Math.sqrt(sd / out.length) || 1;
    return out.map((v) => v / sd);
  };
  return { band: detrend(band), hfc: detrend(hfc), kick: detrend(kick), fps: RATE / HOP };
}

// Global tempo near the hint: autocorrelation of the onset strength, searched within 8% of it.
function refineTempo(o, fps, hint) {
  const ac = (lag) => { let s = 0; for (let f = lag; f < o.length; f++) s += o[f] * o[f - lag]; return s; };
  let best = hint;
  let top = -Infinity;
  for (let bpm = hint * 0.92; bpm <= hint * 1.08; bpm += 0.05) {
    const p = (60 * fps) / bpm;
    const v = [1, 2, 4].reduce((sum, m) => { const q = p * m; const l = Math.floor(q); return sum + ac(l) + (q - l) * (ac(l + 1) - ac(l)); }, 0);
    if (v > top) { top = v; best = bpm; }
  }
  return best;
}

function dpBeats(o, period) {
  const n = o.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const pmin = Math.round(period / 2);
  const pmax = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let p = Math.max(0, t - pmax); p <= t - pmin; p++) {
      const v = score[p] - TIGHT * Math.log((t - p) / period) ** 2;
      if (arg < 0 || v > best) { best = v; arg = p; }
    }
    score[t] = o[t] + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  let t = n - 1;
  for (let k = n - 1; k >= Math.max(0, n - Math.round(period)); k--) if (score[k] > score[t]) t = k;
  const beats = [];
  while (t >= 0) { beats.push(t); t = back[t]; }
  return beats.reverse();
}

// How well two beat sequences (in frames) agree: F-measure with a 50 ms window.
function agreement(a, b, fps) {
  const tol = 0.05 * fps;
  let hit = 0;
  let j = 0;
  for (const t of a) {
    while (j < b.length && b[j] < t - tol) j++;
    if (j < b.length && Math.abs(b[j] - t) <= tol) { hit++; j++; }
  }
  return (2 * hit) / (a.length + b.length || 1);
}

// The harmonic low end: magnitudes under 300 Hz with the drums taken out by median filtering
// (harmonic sounds are steady along time, drum hits are spread across frequency).
function harmonicBass(x) {
  const N = 8192;
  const H = 1024;
  const maxBin = Math.ceil((300 * N) / RATE);
  const frames = Math.max(0, Math.floor((x.length - N) / H));
  const S = [];
  const win = new Float64Array(N).map((_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < N; k++) { re[k] = (x[f * H + k] / 32768) * win[k]; im[k] = 0; }
    fft(re, im);
    const m = new Float32Array(maxBin);
    for (let b = 1; b < maxBin; b++) m[b] = Math.hypot(re[b], im[b]);
    S.push(m);
  }
  const med = (arr) => { const s = Float32Array.from(arr).sort(); return s[s.length >> 1]; };
  const out = S.map((m, f) => {
    const h = new Float32Array(maxBin);
    for (let b = 1; b < maxBin; b++) {
      const along = [];
      for (let k = Math.max(0, f - 8); k <= Math.min(frames - 1, f + 8); k++) along.push(S[k][b]);
      const across = [];
      for (let k = Math.max(1, b - 8); k <= Math.min(maxBin - 1, b + 8); k++) across.push(m[k]);
      const hv = med(along);
      const pv = med(across);
      h[b] = hv >= pv ? m[b] : 0; // harmonic where the steady view outweighs the drum view
    }
    return h;
  });
  return { S: out, H, N };
}

function chromaBetween(hb, from, to) {
  const c = new Float64Array(12);
  const f0 = Math.max(0, Math.floor((from * RATE) / hb.H));
  const f1 = Math.min(hb.S.length, Math.ceil((to * RATE - hb.N) / hb.H) + 1);
  for (let f = f0; f < Math.max(f1, f0 + 1) && f < hb.S.length; f++) {
    const m = hb.S[f];
    for (let b = 1; b < m.length; b++) {
      const hz = (b * RATE) / hb.N;
      if (hz < 38) continue;
      c[((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12] += m[b];
    }
  }
  const tot = c.reduce((p, q) => p + q, 0) || 1;
  return c.map((v) => v / tot);
}

// x: mono Int16Array at 22050 Hz.
function trackBeats(x, hintBpm) {
  const o = onsets(x);
  const { fps } = o;
  const combo = o.band.map((v, k) => v + 0.6 * o.hfc[k] + 0.6 * o.kick[k]);
  const bpm = refineTempo(combo, fps, hintBpm || 120);
  const period = (60 * fps) / bpm;
  const runs = { band: dpBeats(o.band, period), hfc: dpBeats(o.hfc, period), kick: dpBeats(o.kick, period), combo: dpBeats(combo, period) };
  const names = Object.keys(runs);
  const agree = {};
  for (const a of names) agree[a] = names.filter((b) => b !== a).reduce((s, b) => s + agreement(runs[a], runs[b], fps), 0) / (names.length - 1);
  const chosen = names.reduce((p, q) => (agree[q] > agree[p] ? q : p));
  // Peak picking: onto the strongest combined onset within 3 frames, with parabolic interpolation.
  let beats = runs[chosen].map((f) => {
    let m = f;
    for (let k = f - 3; k <= f + 3; k++) if (k > 0 && k < combo.length - 1 && combo[k] > combo[m]) m = k;
    const a = combo[m - 1] || 0;
    const b = combo[m];
    const c = combo[m + 1] || 0;
    const den = a - 2 * b + c;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return ((m + off) * HOP + NFFT / 2) / RATE;
  });
  beats = beats.map((t, i) => (i === 0 || i === beats.length - 1 ? t : 0.75 * t + 0.125 * (beats[i - 1] + beats[i + 1])));

  // Downbeats and roots from the harmonic low end.
  const hb = harmonicBass(x);
  const novelty = beats.map((t, i) => {
    if (i < 2 || i + 2 >= beats.length) return 0;
    const before = chromaBetween(hb, beats[i - 2], t);
    const after = chromaBetween(hb, t, beats[i + 2]);
    return before.reduce((s, v, k) => s + Math.abs(v - after[k]), 0);
  });
  const kickAt = beats.map((t) => { const f = Math.round((t * RATE - NFFT / 2) / HOP); let m = 0; for (let k = f - 3; k <= f + 3; k++) if (o.kick[k] > m) m = o.kick[k]; return m; });
  const z = (a) => { const m = a.reduce((p, q) => p + q, 0) / a.length; const s = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length) || 1; return a.map((v) => (v - m) / s); };
  const zn = z([0, 1, 2, 3].map((k) => novelty.filter((_, i) => i % 4 === k).reduce((p, q) => p + q, 0)));
  const zk = z([0, 1, 2, 3].map((k) => kickAt.filter((_, i) => i % 4 === k || i % 4 === (k + 2) % 4).reduce((p, q) => p + q, 0)));
  const phaseScore = [0, 1, 2, 3].map((k) => zn[k] + 0.5 * zk[k]);
  const downbeat = phaseScore.indexOf(Math.max(...phaseScore));
  const bars = [];
  let last = null;
  for (let i = downbeat; i + 4 < beats.length; i += 4) {
    const c = chromaBetween(hb, beats[i], beats[i + 4]);
    const order = [...c.keys()].sort((p, q) => c[q] - c[p]);
    const conf = c[order[0]] / (c[order[1]] || 1e-9);
    const sure = conf >= 1.25;
    const r = sure || last == null ? order[0] : last;
    if (sure) last = order[0];
    bars.push({ t: +beats[i].toFixed(4), root: NAMES[r], note: 36 + r, conf: +conf.toFixed(2), sure });
  }
  const gaps = beats.slice(1).map((t, i) => t - beats[i]);
  const sorted = [...gaps].sort((p, q) => p - q);
  return {
    bpm: +bpm.toFixed(2),
    beats: beats.map((t) => +t.toFixed(4)),
    downbeat,
    phaseScore: phaseScore.map((v) => +v.toFixed(2)),
    chosen,
    agreement: Object.fromEntries(names.map((k) => [k, +agree[k].toFixed(3)])),
    bars,
    localBpm: { p5: +(60 / sorted[Math.floor(sorted.length * 0.95)]).toFixed(1), p95: +(60 / sorted[Math.floor(sorted.length * 0.05)]).toFixed(1) },
  };
}

module.exports = { trackBeats, RATE, NAMES };
