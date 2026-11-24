// Maps a song bar by bar: loudness, bass weight, and the strongest bass note (the chord root) of each
// bar, so you can see its sections (intro, verse, chorus, breakdown) and write parts that follow it.
//   node scripts/bars.js <library folder> <source id> [--roots]
// It reads the one-bar clips the app's auto cut made ("hits", "Whole song · 1-bar clips"), so the bars
// are the app's own bar grid. Prints rows of 8 bars: bar number, start time, then per bar
// "<root><loudness>" with loudness in dB against the song's loudest bar, and a mark under bars whose
// low end is 6 dB or more below the song's norm (no bass: an intro, a break).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { chroma, NAMES } = require('./key');

const RATE = 11025;
const [lib, id] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(lib, 'state.json'), 'utf8'));
const src = state.sources.find((s) => s.id === id);
const bars = state.pads.filter((c) => c && c.sourceId === id).sort((p, q) => p.start - q.start);
const out = spawnSync(ffmpeg, ['-v', 'error', '-i', src.file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 29 });
const x = new Int16Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + (out.stdout.length & ~1)));

const rows = bars.map((c, k) => {
  const seg = x.subarray(Math.floor(c.start * RATE), Math.floor(c.end * RATE));
  let e = 0, lp = 0, b = 0;
  const a = Math.exp((-2 * Math.PI * 120) / RATE);
  for (const v0 of seg) { const v = v0 / 32768; e += v * v; lp = a * lp + (1 - a) * v; b += lp * lp; }
  const { bass } = chroma(seg);
  const root = [...bass.keys()].sort((p, q) => bass[q] - bass[p])[0];
  return { k, start: c.start, db: 10 * Math.log10(e / seg.length + 1e-12), bass: 10 * Math.log10(b / seg.length + 1e-12), root: NAMES[root] };
});
// `--roots`: print only the roots, one per bar, ready to paste into a script's bass line.
if (process.argv.includes('--roots')) { console.log(rows.map((r) => r.root).join(' ')); process.exit(0); }
const top = Math.max(...rows.map((r) => r.db));
const medBass = [...rows.map((r) => r.bass)].sort((p, q) => p - q)[Math.floor(rows.length / 2)];
console.log(`${src.title}: ${rows.length} bars, ${src.bpm} BPM. Each cell: bass root + level vs the loudest bar (dB); "_" = low end 6+ dB down.`);
for (let k = 0; k < rows.length; k += 8) {
  const r8 = rows.slice(k, k + 8);
  console.log(`bar ${String(k).padStart(3)}  ${r8[0].start.toFixed(1).padStart(6)}s  ` + r8.map((r) => `${r.root.padEnd(2)}${String(Math.round(r.db - top)).padStart(3)}${r.bass - medBass < -6 ? '_' : ' '}`).join(' '));
}
