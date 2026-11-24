// Measures whether added drums land with a record's own beat, beat by beat, in a render.
//   node scripts/sync-check.js <render> <original song file> <beats.json> <renderFrom> <renderTo>
// beats.json is scripts/beats.js --json output for the song. Steps:
//   1. Find where the song sits in the render (cross-correlating mid-band envelopes of the stretch).
//   2. For every tracked beat of the song inside that stretch, find the strongest low-band (kick)
//      onset in the render within 60 ms of where the beat should be, and note how far off it is.
//   3. Do the same on the original song alone: its own drummer against the tracker, the baseline.
// In sync: the render's offsets sit as tight around zero as the original's (median within ~5 ms,
// most beats within 15 ms). Out of sync: a median well off zero, or a wide spread.
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 22050;
// An optional 6th argument, the song time you expect at `from`, limits the search to 3 s around it
// (a song that repeats itself can otherwise match the wrong chorus).
const [render, songFile, beatsFile, rf, rt, hint] = process.argv.slice(2);
if (!rt) { console.error('usage: node scripts/sync-check.js <render> <song> <beats.json> <from> <to>'); process.exit(1); }
const tr = JSON.parse(fs.readFileSync(beatsFile, 'utf8'));
const pcm = (file, from, dur, af) => {
  const args = ['-v', 'error', '-ss', String(Math.max(0, from)), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE)];
  if (af) args.push('-af', af);
  args.push('-f', 's16le', 'pipe:1');
  const o = spawnSync(ffmpeg, args, { maxBuffer: 1 << 28 });
  return new Int16Array(o.stdout.buffer.slice(o.stdout.byteOffset, o.stdout.byteOffset + (o.stdout.length & ~1)));
};
const env = (x, hop) => { const e = []; for (let f = 0; f * hop + hop <= x.length; f++) { let s = 0; for (let k = f * hop; k < (f + 1) * hop; k++) s += x[k] * x[k]; e.push(Math.log1p(Math.sqrt(s / hop))); } const m = e.reduce((p, q) => p + q, 0) / e.length; return e.map((v) => v - m); };

// 1. Locate the song in the render (5 ms resolution), searching the whole song.
const from = Number(rf);
const to = Number(rt);
const HOP = 110; // 5 ms
const R = env(pcm(render, from, to - from, 'bandpass=f=1500:w=2500'), HOP);
const S = env(pcm(songFile, 0, 100000, 'bandpass=f=1500:w=2500'), HOP);
let best = -Infinity;
let lag = 0;
const lo = hint ? Math.max(0, Math.round(((Number(hint) - 3) * RATE) / HOP)) : 0;
const hi = hint ? Math.round(((Number(hint) + 3) * RATE) / HOP) : Infinity;
for (let l = lo; l <= hi && l + R.length <= S.length; l += 2) { let c = 0; for (let k = 0; k < R.length; k += 2) c += R[k] * S[l + k]; if (c > best) { best = c; lag = l; } }
for (let l = Math.max(0, lag - 3); l <= lag + 3 && l + R.length <= S.length; l++) { let c = 0; for (let k = 0; k < R.length; k++) c += R[k] * S[l + k]; if (c > best) { best = c; lag = l; } }
const songAtFrom = (lag * HOP) / RATE; // song time playing at render time `from`
console.log(`song ${songAtFrom.toFixed(3)} s plays at render ${from} s`);

// 2-3. Kick-band onsets around each tracked beat.
const offsets = (file, startInFile, songStart, songEnd) => {
  const x = pcm(file, startInFile, songEnd - songStart, 'lowpass=f=150');
  const h = 22; // 1 ms
  const e = [];
  let prev = 0;
  for (let f = 0; f * h + h <= x.length; f++) { let s = 0; for (let k = f * h; k < (f + 1) * h; k++) s += x[k] * x[k]; const v = Math.log1p(Math.sqrt(s / h) / 30); e.push(Math.max(0, v - prev)); prev = 0.7 * prev + 0.3 * v; }
  const out = [];
  for (const b of tr.beats) {
    if (b < songStart + 0.1 || b > songEnd - 0.1) continue;
    const c = Math.round((b - songStart) * 1000);
    let m = -1;
    let arg = 0;
    for (let k = c - 60; k <= c + 60; k++) if (e[k] > m) { m = e[k]; arg = k; }
    out.push(arg - c);
  }
  return out;
};
const stats = (o) => {
  const s = [...o].sort((p, q) => p - q);
  const med = s[s.length >> 1];
  const mad = [...o.map((v) => Math.abs(v - med))].sort((p, q) => p - q)[o.length >> 1];
  return `${o.length} beats: median ${med} ms, spread (MAD) ${mad} ms, within 15 ms of the beat ${((100 * o.filter((v) => Math.abs(v) <= 15).length) / o.length).toFixed(0)}%`;
};
const songEnd = songAtFrom + (to - from);
console.log(`ORIGINAL (its own low end vs the tracked beats; a noisy reference): ${stats(offsets(songFile, songAtFrom, songAtFrom, songEnd))}`);

// The beat box's kick is a known sound (beat.js kickAt), so it can be found exactly with a matched
// filter: correlate the render's low end with the kick's own waveform near every beat.
const kickT = (() => {
  const n = Math.round(0.12 * RATE);
  const k = new Float64Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = t < 0.09 ? 160 * Math.pow(48 / 160, t / 0.09) : 48 * Math.pow(40 / 48, (t - 0.09) / 0.31);
    ph += (2 * Math.PI * f) / RATE;
    k[i] = Math.sin(ph) * Math.exp(-t / 0.08);
  }
  return k;
})();
const xr = pcm(render, from, to - from, 'lowpass=f=200');
const kickOffsets = [];
for (const b of tr.beats) {
  if (b < songAtFrom + 0.1 || b > songEnd - 0.2) continue;
  const c = Math.round((b - songAtFrom) * RATE);
  let m = -Infinity;
  let arg = 0;
  for (let d = -Math.round(0.08 * RATE); d <= Math.round(0.08 * RATE); d += 2) {
    let s = 0;
    let e = 0;
    for (let i = 0; i < kickT.length; i += 2) { const v = xr[c + d + i] || 0; s += v * kickT[i]; e += v * v; }
    const r = s / Math.sqrt(e + 1);
    if (r > m) { m = r; arg = d; }
  }
  kickOffsets.push({ ms: Math.round((arg / RATE) * 1000), score: m });
}
// Beats where the kick is playing correlate far better than the rest; keep the top half.
const sorted = [...kickOffsets].sort((p, q) => q.score - p.score);
const found = sorted.slice(0, Math.ceil(sorted.length / 2)).map((o) => o.ms);
console.log(`ADDED KICK (matched filter) vs the tracked beats: ${stats(found)}`);
