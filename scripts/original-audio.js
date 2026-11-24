// Puts a record's original sound under a rendered video, lined up to the millisecond, so a music
// video plays the record exactly as released (the app's own output passes its limiter).
//   node scripts/original-audio.js <render.mp4> <original audio or video> <out.mp4>
// Finds where the original starts in the render by cross-correlating the two soundtracks' onset
// envelopes (first coarse at 10 ms, then fine at 1 ms over the best region), then copies the
// render's picture untouched and lays the original's audio in at that offset.
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 11025;
const [render, orig, out] = process.argv.slice(2);
if (!out) { console.error('usage: node scripts/original-audio.js <render> <original> <out>'); process.exit(1); }
const pcm = (file, from, dur) => {
  const o = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(from), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
  return new Int16Array(o.stdout.buffer.slice(o.stdout.byteOffset, o.stdout.byteOffset + (o.stdout.length & ~1)));
};
const env = (x, hop) => {
  const e = [];
  let prev = 0;
  for (let f = 0; f * hop + hop <= x.length; f++) {
    let s = 0;
    for (let k = f * hop; k < (f + 1) * hop; k++) s += x[k] * x[k];
    const v = Math.log1p(Math.sqrt(s / hop) / 30);
    e.push(Math.max(0, v - prev));
    prev = v;
  }
  return e;
};
// The render's first 60 s against the original's first 70 s: the original starts at render time `lag`.
const R = pcm(render, 0, 60);
const O = pcm(orig, 0, 70);
const corr = (a, b, lag) => { let s = 0; for (let k = 0; k < b.length; k++) { const i = k + lag; if (i >= 0 && i < a.length) s += a[i] * b[k]; } return s; };
// Coarse: 10 ms frames, render lag -5..+5 s (the render may start before or after the record).
const h1 = Math.round(RATE / 100);
const r1 = env(R, h1);
const o1 = env(O, h1);
let best = -Infinity;
let lag1 = 0;
for (let l = -500; l <= 500; l++) { const c = corr(r1, o1, l); if (c > best) { best = c; lag1 = l; } }
// Fine: 1 ms frames within 20 ms of the coarse answer.
const h2 = Math.round(RATE / 1000);
const r2 = env(R, h2);
const o2 = env(O, h2);
best = -Infinity;
let lag2 = lag1 * 10;
for (let l = lag1 * 10 - 20; l <= lag1 * 10 + 20; l++) { const c = corr(r2, o2, l); if (c > best) { best = c; lag2 = l; } }
const offset = lag2 / 1000; // seconds: original time 0 plays at render time `offset`
console.log(`the original starts at render time ${offset.toFixed(3)} s`);
const args = ['-y', '-v', 'error', '-i', render];
if (offset >= 0) args.push('-itsoffset', offset.toFixed(3), '-i', orig);
else args.push('-ss', (-offset).toFixed(3), '-i', orig);
args.push('-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out);
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
if (r.status) { console.error(r.stderr); process.exit(1); }
console.log(`wrote ${path.resolve(out)}`);
