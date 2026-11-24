// Checks whether added drums land on a song's own beat (no flam), by folding onset strength over the
// beat period: one peak means everything hits together, two peaks mean two grids a few ms apart.
//   node scripts/beat-phase.js <file> <bpm> <fromSeconds> <toSeconds> [bandHz=150]
// Prints, per 5 ms slot of the beat, how much low-band onset energy lands there (a bar chart), and the
// strongest slot. Run it on the original song over the section you used and on the render over the
// same music: if the peak moved, or a second peak appeared, the added beat is off the song's grid.
// For a render the phase is relative to the render's own start, so compare the shape, not the slot.
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 22050;
const [file, bpm, from, to, band] = process.argv.slice(2);
if (!to) { console.error('usage: node scripts/beat-phase.js <file> <bpm> <from> <to> [bandHz]'); process.exit(1); }
const out = spawnSync(ffmpeg, ['-v', 'error', '-ss', from, '-to', to, '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 });
const x = new Int16Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + (out.stdout.length & ~1)));
const a = Math.exp((-2 * Math.PI * Number(band || 150)) / RATE);
const hop = Math.round(RATE / 1000); // 1 ms
let lp = 0;
let prev = 0;
const beat = 60 / Number(bpm);
const slots = 40;
const hist = new Float64Array(slots);
for (let f = 0; f * hop + hop <= x.length; f++) {
  let e = 0;
  for (let k = f * hop; k < (f + 1) * hop; k++) { lp = a * lp + (1 - a) * (x[k] / 32768); e += lp * lp; }
  const env = Math.log1p(1000 * Math.sqrt(e / hop));
  const rise = Math.max(0, env - prev);
  prev = 0.9 * prev + 0.1 * env; // compare with a short running average, so slow swells do not count
  const t = (f * hop) / RATE;
  const ph = (t % beat) / beat;
  hist[Math.floor(ph * slots) % slots] += rise;
}
const top = Math.max(...hist);
const ms = (k) => Math.round((k / slots) * beat * 1000);
for (let k = 0; k < slots; k++) console.log(`${String(ms(k)).padStart(4)} ms ${'#'.repeat(Math.round((hist[k] / top) * 50))}`);
const best = hist.indexOf(top);
const second = [...hist.keys()].filter((k) => Math.min(Math.abs(k - best), slots - Math.abs(k - best)) > 2).sort((p, q) => hist[q] - hist[p])[0];
console.log(`PEAK at ${ms(best)} ms of a ${Math.round(beat * 1000)} ms beat; next peak away from it: ${ms(second)} ms at ${(100 * hist[second] / top).toFixed(0)}% of the top`);
