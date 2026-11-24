// Checks a rendered video's picture the way analyze-mix.js checks its sound, so effects can be
// judged without watching: too dark, washed out, frozen, and flashing too fast.
//   node scripts/check-video.js <video>
// Reads every frame (30 a second, shrunk to 64x36 grayscale) and reports:
//   DARK     stretches where the picture's average brightness is under 7%    (lost in the dark)
//   WASHED   stretches over 85%                                              (blown out)
//   FROZEN   stretches over 3 s where nothing changes                        (a stuck clip)
//   FLASHES  any second with more than 3 flashes (a jump of 10% of full brightness and back): the
//            photosensitive-epilepsy limit broadcasters use (Ofcom, the Harding test). A FAIL here
//            must be fixed before posting.
// Short dark or bright moments (a fade, a flash on a drop) are normal; long ones are worth a look.
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/check-video.js <video>'); process.exit(1); }
const W = 64;
const H = 36;
const FPS = 30;
const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 1 << 30 });
if (r.status) { console.error(r.stderr.toString()); process.exit(1); }
const buf = r.stdout;
const n = Math.floor(buf.length / (W * H));
const mean = new Float32Array(n);
const diff = new Float32Array(n);
for (let f = 0; f < n; f++) {
  let s = 0;
  let d = 0;
  for (let i = 0; i < W * H; i++) {
    const v = buf[f * W * H + i];
    s += v;
    if (f) d += Math.abs(v - buf[(f - 1) * W * H + i]);
  }
  mean[f] = s / (W * H) / 255;
  diff[f] = d / (W * H) / 255;
}
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const runs = (test, minSec) => {
  const out = [];
  let start = -1;
  for (let f = 0; f <= n; f++) {
    const on = f < n && test(f);
    if (on && start < 0) start = f;
    if (!on && start >= 0) { if ((f - start) / FPS >= minSec) out.push([start / FPS, f / FPS]); start = -1; }
  }
  return out;
};
const show = (label, list) => console.log(`${label}: ${list.length ? list.map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(', ') : 'none'}`);
console.log(`${file}: ${(n / FPS).toFixed(1)} s, average brightness ${(100 * mean.reduce((p, q) => p + q, 0) / n).toFixed(0)}%`);
show('DARK (under 7% for 1 s or more)', runs((f) => mean[f] < 0.07, 1));
show('WASHED (over 85% for 0.5 s or more)', runs((f) => mean[f] > 0.85, 0.5));
show('FROZEN (no change for 3 s or more)', runs((f) => diff[f] < 0.002, 3));
// Flashes: count brightness reversals of 10% or more; two reversals (up and down) make one flash.
const turns = [];
let dir = 0;
let ref = mean[0];
for (let f = 1; f < n; f++) {
  const d = mean[f] - ref;
  if (Math.abs(d) >= 0.1) {
    const nd = Math.sign(d);
    if (nd !== dir) { turns.push(f / FPS); dir = nd; }
    ref = mean[f];
  } else if ((dir > 0 && mean[f] > ref) || (dir < 0 && mean[f] < ref)) ref = mean[f];
}
let worst = 0;
let worstAt = 0;
for (let k = 0; k < turns.length; k++) {
  let j = k;
  while (j < turns.length && turns[j] - turns[k] < 1) j++;
  const flashes = (j - k) / 2;
  if (flashes > worst) { worst = flashes; worstAt = turns[k]; }
}
console.log(`FLASHES: at most ${worst} in any second${worst ? ` (from ${fmt(worstAt)})` : ''}: ${worst > 3 ? 'FAIL, over 3 a second' : 'ok'}`);
