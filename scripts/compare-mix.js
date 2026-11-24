// Compares a remix with the original record over the same music: how much each frequency band
// holds (dB of the total), so added drums and bass can be kept subtle, an addition rather than a
// takeover. The remix is mastered louder or quieter than the original, so totals are not compared;
// the balance between bands is.
//   node scripts/compare-mix.js <remix> <original> <remixFrom> <remixTo>
// Finds where the original sits in that stretch of the remix (cross-correlating mid-band envelopes),
// then prints, per band, the original's share, the remix's share and the difference. Subtle: the low
// bands within about +2 dB of the original, the rest within about 1 dB. A larger gain in sub or low
// is the added kick and bass overwhelming the record.
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 22050;
// Optional 5th argument: the original's time expected at `remixFrom`; the search stays within 3 s.
const [remix, orig, rf, rt, hint] = process.argv.slice(2);
if (!rt) { console.error('usage: node scripts/compare-mix.js <remix> <original> <remixFrom> <remixTo>'); process.exit(1); }
const pcm = (file, from, dur, af) => {
  const args = ['-v', 'error', '-ss', String(Math.max(0, from)), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE)];
  if (af) args.push('-af', af);
  args.push('-f', 's16le', 'pipe:1');
  const o = spawnSync(ffmpeg, args, { maxBuffer: 1 << 28 });
  return new Int16Array(o.stdout.buffer.slice(o.stdout.byteOffset, o.stdout.byteOffset + (o.stdout.length & ~1)));
};
const HOP = 110;
const env = (x) => { const e = []; for (let f = 0; f * HOP + HOP <= x.length; f++) { let s = 0; for (let k = f * HOP; k < (f + 1) * HOP; k++) s += x[k] * x[k]; e.push(Math.log1p(Math.sqrt(s / HOP))); } const m = e.reduce((p, q) => p + q, 0) / e.length; return e.map((v) => v - m); };
const from = Number(rf);
const dur = Number(rt) - from;
const R = env(pcm(remix, from, dur, 'bandpass=f=1500:w=2500'));
const S = env(pcm(orig, 0, 100000, 'bandpass=f=1500:w=2500'));
let best = -Infinity;
let lag = 0;
const lo = hint ? Math.max(0, Math.round(((Number(hint) - 3) * RATE) / HOP)) : 0;
const hi = hint ? Math.round(((Number(hint) + 3) * RATE) / HOP) : Infinity;
for (let l = lo; l <= hi && l + R.length <= S.length; l += 2) { let c = 0; for (let k = 0; k < R.length; k += 2) c += R[k] * S[l + k]; if (c > best) { best = c; lag = l; } }
const origFrom = (lag * HOP) / RATE;

const BANDS = [['sub', 'lowpass=f=60'], ['bass', 'highpass=f=60,lowpass=f=150'], ['low-mid', 'highpass=f=150,lowpass=f=500'], ['mid', 'highpass=f=500,lowpass=f=2000'], ['presence', 'highpass=f=2000,lowpass=f=6000'], ['air', 'highpass=f=6000']];
const energy = (x) => { let s = 0; for (const v of x) s += (v / 32768) ** 2; return s / x.length + 1e-12; };
const share = (file, start) => {
  const tot = energy(pcm(file, start, dur));
  return BANDS.map(([, af]) => 10 * Math.log10(energy(pcm(file, start, dur, af)) / tot));
};
const a = share(orig, origFrom);
const b = share(remix, from);
console.log(`original ${origFrom.toFixed(1)}-${(origFrom + dur).toFixed(1)} s against remix ${from}-${from + dur} s`);
console.log('band       original  remix   change');
BANDS.forEach(([name], k) => {
  const d = b[k] - a[k];
  const flag = (k < 2 ? d > 2 : Math.abs(d) > 1.5) ? '  <- more than subtle' : '';
  console.log(`${name.padEnd(9)} ${a[k].toFixed(1).padStart(7)} ${b[k].toFixed(1).padStart(7)} ${(d >= 0 ? '+' : '') + d.toFixed(1).padStart(5)}${flag}`);
});
