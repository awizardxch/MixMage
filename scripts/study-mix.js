// Studies how a recorded DJ set is put together, from its audio and its tracklist times.
//   node scripts/study-mix.js <audio or video file> <time,time,...>   (transition times in seconds)
// For each transition it prints, in 4-second steps from 96 s before to 96 s after: overall level,
// the bass (under 120 Hz) relative to the piece's norm, and tempo. A bass line that dips and returns
// is a bass swap; the span over which two tracks are both audible is the length of the blend.
// It also prints the tempo of each track, to show how far the DJ moves between records.
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 11025;

function pcm(file, start, dur) {
  const out = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  return new Int16Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + (out.stdout.length & ~1)));
}

// One-pole low-pass at ~120 Hz splits bass from the rest cheaply.
function bands(x) {
  const a = Math.exp((-2 * Math.PI * 120) / RATE);
  let lp = 0;
  let bass = 0;
  let rest = 0;
  for (let k = 0; k < x.length; k++) {
    const v = x[k] / 32768;
    lp = a * lp + (1 - a) * v;
    bass += lp * lp;
    rest += (v - lp) * (v - lp);
  }
  const db = (e) => 10 * Math.log10(e / x.length + 1e-12);
  return { bass: db(bass), rest: db(rest), total: db(bass + rest) };
}

function tempo(x) {
  const hop = 128;
  const frames = Math.floor(x.length / hop);
  const nov = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let k = f * hop; k < (f + 1) * hop; k++) s += x[k] * x[k];
    const env = Math.log1p((100 * Math.sqrt(s / hop)) / 32768);
    nov[f] = Math.max(0, env - prev);
    prev = env;
  }
  const fps = RATE / hop;
  const ac = (lag) => { let s = 0; for (let f = lag; f < frames; f++) s += nov[f] * nov[f - lag]; return s / (frames - lag); };
  let best = 0;
  let top = 0;
  for (let lag = Math.round((fps * 60) / 140); lag <= Math.round((fps * 60) / 100); lag++) { const v = ac(lag); if (v > top) { top = v; best = lag; } }
  const interp = (p) => { const lo = Math.floor(p); return ac(lo) + (p - lo) * (ac(lo + 1) - ac(lo)); };
  let lag = best;
  let score = -1;
  for (let p = best - 1.5; p <= best + 1.5; p += 0.02) { const s = interp(p) + interp(2 * p) + interp(4 * p); if (s > score) { score = s; lag = p; } }
  return (60 * fps) / lag;
}

const [file, list] = process.argv.slice(2);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;

// Scan mode, for a set with no tracklist:  node scripts/study-mix.js <file> scan
// Prints the tempo of every minute, every stretch where the bass drops out (a bass swap, a
// breakdown, or the DJ cutting the low end), and how steady the overall level is.
if (list === 'scan') {
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr || '');
  const total = m ? m[1] * 3600 + m[2] * 60 + Number(m[3]) : 0;
  const step = 4;
  const rows = [];
  const tempos = [];
  for (let t = 0; t + 60 <= total; t += 60) {
    const x = pcm(file, t, 60);
    tempos.push(tempo(x.subarray(10 * RATE, 50 * RATE)));
    for (let k = 0; k < 60 / step; k++) rows.push({ t: t + k * step, ...bands(x.subarray(k * step * RATE, (k + 1) * step * RATE)) });
  }
  const med = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  console.log(`LENGTH ${fmt(total)}`);
  console.log('TEMPO per minute (BPM):');
  for (let k = 0; k < tempos.length; k += 10) console.log(`  ${String(k).padStart(2)}-${String(Math.min(k + 9, tempos.length - 1)).padStart(2)} min: ${tempos.slice(k, k + 10).map((b) => b.toFixed(1)).join(' ')}`);
  const steps = tempos.slice(1).map((b, k) => Math.abs(b - tempos[k]));
  console.log(`  range ${Math.min(...tempos).toFixed(1)}-${Math.max(...tempos).toFixed(1)}; minute-to-minute change: median ${med(steps).toFixed(2)}, largest ${Math.max(...steps).toFixed(1)}`);
  const playing = rows.filter((r) => r.total > med(rows.map((q) => q.total)) - 15);
  const medTot = med(playing.map((r) => r.total));
  const dev = playing.map((r) => Math.abs(r.total - medTot));
  console.log(`LEVEL: ${(100 * dev.filter((d) => d <= 1.5).length / dev.length).toFixed(0)}% of the set within 1.5 dB of its norm, ${(100 * dev.filter((d) => d <= 3).length / dev.length).toFixed(0)}% within 3 dB`);
  // Bass drop-outs: relative to the surrounding two minutes, so a quieter record is not mistaken for one.
  const drops = [];
  let cur = null;
  rows.forEach((r, k) => {
    const near = med(rows.slice(Math.max(0, k - 15), k + 16).map((q) => q.bass));
    const d = r.bass - near;
    if (d < -6 && r.total > medTot - 15) {
      if (cur && r.t - cur.end <= step) { cur.end = r.t + step; cur.depth = Math.min(cur.depth, d); }
      else drops.push(cur = { start: r.t, end: r.t + step, depth: d });
    }
  });
  console.log(`BASS DROP-OUTS (6+ dB under the surrounding two minutes): ${drops.length}`);
  for (const d of drops) console.log(`  ${fmt(d.start)}  ${String(d.end - d.start).padStart(3)} s  ${d.depth.toFixed(0)} dB`);
  const lens = drops.map((d) => d.end - d.start);
  if (lens.length) console.log(`  lengths: ${lens.filter((l) => l <= 8).length} of 8 s or less, ${lens.filter((l) => l > 8 && l <= 32).length} of 9-32 s, ${lens.filter((l) => l > 32).length} longer; one every ${(total / 60 / lens.length).toFixed(1)} minutes`);
  process.exit(0);
}

const times = list.split(',').map(Number);

console.log('TRACK TEMPOS (measured over 40 s in the middle of each track)');
const edges = [0, ...times];
const bpms = [];
for (let k = 0; k < edges.length - 1; k++) {
  const mid = (edges[k] + edges[k + 1]) / 2;
  const b = tempo(pcm(file, mid - 20, 40));
  bpms.push(b);
  console.log(`  track ${k + 1} (${fmt(edges[k])}-${fmt(edges[k + 1])}): ${b.toFixed(1)} BPM`);
}

for (const [k, T] of times.entries()) {
  const step = 4;
  const rows = [];
  for (let t = T - 96; t < T + 96; t += step) rows.push({ t, ...bands(pcm(file, t, step)) });
  const sorted = (key) => rows.map((r) => r[key]).sort((a, b) => a - b);
  const medBass = sorted('bass')[Math.floor(rows.length / 2)];
  const medTot = sorted('total')[Math.floor(rows.length / 2)];
  console.log(`\nTRANSITION ${k + 1} at ${fmt(T)}  (bass and level in dB against this window's norm; one column per 4 s, | marks the listed time)`);
  const line = (key, med) => rows.map((r) => (r.t === T ? '|' : '') + (Math.round(r[key] - med) >= 0 ? '+' : '') + Math.round(r[key] - med)).join(' ');
  console.log(`  bass : ${line('bass', medBass)}`);
  console.log(`  level: ${line('total', medTot)}`);
  const low = rows.filter((r) => r.bass - medBass < -6);
  if (low.length) console.log(`  bass is 6+ dB down for ${low.length * step} s, between ${fmt(low[0].t)} and ${fmt(low[low.length - 1].t + step)}`);
  else console.log('  bass never drops 6 dB: the low end is carried straight through');
}
