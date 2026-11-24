// Measures a rendered mix by frequency band over time, as a stand-in for listening.
//   node scripts/analyze-mix.js demo/promo2-output.mp4 [more files...]
// For each file: the overall balance between five bands, and every half-second where a band or the
// overall level departs from the piece's own norm — the places a stab, a cut or a section sticks out.
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 22050;
const N = 2048;
const HOP = 1024;
const BANDS = [['sub', 20, 120], ['low', 120, 500], ['mid', 500, 2000], ['high', 2000, 6000], ['air', 6000, 11000]];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

function analyze(file) {
  const out = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  const pcm = new Int16Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.length >> 1);
  const win = Float64Array.from({ length: N }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N));
  const frames = [];
  for (let s = 0; s + N <= pcm.length; s += HOP) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let k = 0; k < N; k++) re[k] = (pcm[s + k] / 32768) * win[k];
    fft(re, im);
    const e = BANDS.map(([, lo, hi]) => {
      let sum = 0;
      for (let b = Math.ceil((lo * N) / RATE); b <= Math.min(N / 2 - 1, Math.floor((hi * N) / RATE)); b++) sum += re[b] * re[b] + im[b] * im[b];
      return sum;
    });
    frames.push(e);
  }
  // Half-second blocks.
  const per = Math.round((0.5 * RATE) / HOP);
  const blocks = [];
  for (let f = 0; f + per <= frames.length; f += per) {
    const e = BANDS.map((_, b) => frames.slice(f, f + per).reduce((s, x) => s + x[b], 0) / per);
    blocks.push(e);
  }
  const db = (x) => 10 * Math.log10(x + 1e-12);
  const total = blocks.map((e) => db(e.reduce((s, x) => s + x, 0)));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const loud = blocks.map((_, k) => k).filter((k) => total[k] > median(total) - 20); // ignore fades and silence
  const medTotal = median(loud.map((k) => total[k]));
  const share = blocks.map((e, k) => e.map((x) => db(x) - total[k])); // each band relative to the block's total
  const medShare = BANDS.map((_, b) => median(loud.map((k) => share[k][b])));
  const flags = [];
  for (const k of loud) {
    const notes = [];
    if (Math.abs(total[k] - medTotal) > 4) notes.push(`level ${(total[k] - medTotal > 0 ? '+' : '') + (total[k] - medTotal).toFixed(1)} dB`);
    BANDS.forEach(([name], b) => {
      const d = share[k][b] - medShare[b];
      if (Math.abs(d) > 7 && share[k][b] > -25) notes.push(`${name} ${(d > 0 ? '+' : '') + d.toFixed(0)} dB`);
    });
    if (notes.length) flags.push(`${(k * 0.5).toFixed(1)}s ${notes.join(', ')}`);
  }
  return { seconds: +(pcm.length / RATE).toFixed(1), balance: Object.fromEntries(BANDS.map(([name], b) => [name, +medShare[b].toFixed(1)])), flagged: flags.length, of: loud.length, flags };
}

for (const file of process.argv.slice(2)) {
  const r = analyze(file);
  console.log(`\n${file}  (${r.seconds}s)`);
  console.log(`  balance (dB of total): ${Object.entries(r.balance).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  console.log(`  stands out in ${r.flagged} of ${r.of} half-seconds${r.flags.length ? ':' : ''}`);
  for (const f of r.flags.slice(0, 40)) console.log(`    ${f}`);
}
