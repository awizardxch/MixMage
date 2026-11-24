// Finds a song's musical key from its audio, so added bass lines, stabs and pitched samples fit it.
//   node scripts/key.js <audio or video file> [fromSeconds] [toSeconds]
// Method: a chromagram (energy per pitch class from an FFT, 55 Hz to 2 kHz), summed over the song and
// matched against the Krumhansl-Kessler major and minor key profiles. Prints the best keys with their
// correlation; a winner well clear of the runner-up is a confident reading. A song that leans on a
// relative major/minor pair (C major / A minor share notes) can score them close: use your ear,
// or the bass notes it also prints (the strongest pitch classes in the low end).
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 11025;
const NFFT = 8192;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pcm(file, from, to) {
  const args = ['-v', 'error'];
  if (from) args.push('-ss', String(from));
  if (to) args.push('-to', String(to));
  args.push('-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1');
  const out = spawnSync(ffmpeg, args, { maxBuffer: 1 << 29 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  return new Int16Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + (out.stdout.length & ~1)));
}

// In-place radix-2 FFT.
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
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * c - im[i + k + len / 2] * s;
        const vi = re[i + k + len / 2] * s + im[i + k + len / 2] * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function chroma(x) {
  const all = new Float64Array(12);
  const bass = new Float64Array(12);
  const win = new Float64Array(NFFT).map((_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / NFFT));
  const binPc = new Int8Array(NFFT / 2).fill(-1);
  for (let b = 1; b < NFFT / 2; b++) {
    const f = (b * RATE) / NFFT;
    if (f < 55 || f > 2000) continue;
    binPc[b] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // A = 9
  }
  for (let s = 0; s + NFFT <= x.length; s += NFFT / 2) {
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    for (let k = 0; k < NFFT; k++) re[k] = (x[s + k] / 32768) * win[k];
    fft(re, im);
    const frame = new Float64Array(12);
    for (let b = 1; b < NFFT / 2; b++) {
      if (binPc[b] < 0) continue;
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      frame[binPc[b]] += m;
      if ((b * RATE) / NFFT < 220) bass[binPc[b]] += m;
    }
    const tot = frame.reduce((p, q) => p + q, 0) || 1;
    for (let k = 0; k < 12; k++) all[k] += frame[k] / tot; // each frame counts once, loud or quiet
  }
  return { all, bass };
}

function corr(a, b) {
  const ma = a.reduce((p, q) => p + q, 0) / 12;
  const mb = b.reduce((p, q) => p + q, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let k = 0; k < 12; k++) { num += (a[k] - ma) * (b[k] - mb); da += (a[k] - ma) ** 2; db += (b[k] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}

if (require.main === module) {
  const [file, from, to] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/key.js <file> [fromSeconds] [toSeconds]'); process.exit(1); }
  const { all, bass } = chroma(pcm(file, Number(from) || 0, Number(to) || 0));
  const keys = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p) => p.map((_, k) => p[(k - t + 12) % 12]);
    keys.push({ name: `${NAMES[t]} major`, r: corr(all, rot(MAJOR)) });
    keys.push({ name: `${NAMES[t]} minor`, r: corr(all, rot(MINOR)) });
  }
  keys.sort((p, q) => q.r - p.r);
  console.log('KEY (correlation with the key profile; 1 = perfect):');
  for (const k of keys.slice(0, 4)) console.log(`  ${k.name.padEnd(9)} ${k.r.toFixed(3)}`);
  const order = [...bass.keys()].sort((p, q) => bass[q] - bass[p]);
  console.log(`BASS NOTES, strongest first: ${order.slice(0, 5).map((k) => NAMES[k]).join(' ')}`);
  const top = [...all.keys()].sort((p, q) => all[q] - all[p]);
  console.log(`ALL NOTES, strongest first: ${top.slice(0, 7).map((k) => NAMES[k]).join(' ')}`);
}

module.exports = { chroma, NAMES };
