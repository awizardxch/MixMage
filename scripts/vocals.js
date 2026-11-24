// Finds where a song is sung, bar by bar, without transcribing it: the lead vocal is mixed dead
// center, while double-tracked guitars and keys are spread wide, so the center ("mid", L+R) carries
// noticeably more of the voice band (250-3500 Hz) than the sides (L-R) whenever someone sings.
//   node scripts/vocals.js <library folder> <source id>
// Prints rows of 8 bars: per bar the center-to-side ratio in dB against the song's median, and a
// mark: "V" for a bar that is clearly sung (3 dB or more above the median), "v" for a maybe (1.5 dB).
// Read it with bars.js: verses and choruses are runs of V; solos and instrumental breaks are runs
// without. Check a few bars by ear or by captions when they exist; a centered lead guitar or a mono
// recording will fool it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const RATE = 11025;
const [lib, id] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(path.join(lib, 'state.json'), 'utf8'));
const src = state.sources.find((s) => s.id === id);
const bars = state.pads.filter((c) => c && c.sourceId === id).sort((p, q) => p.start - q.start);
const out = spawnSync(ffmpeg, ['-v', 'error', '-i', src.file, '-vn', '-af', 'highpass=f=250,lowpass=f=3500', '-ac', '2', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 29 });
const x = new Int16Array(out.stdout.buffer.slice(out.stdout.byteOffset, out.stdout.byteOffset + (out.stdout.length & ~1)));

const rows = bars.map((c) => {
  let mid = 0;
  let side = 0;
  for (let k = Math.floor(c.start * RATE); k < Math.floor(c.end * RATE) && 2 * k + 1 < x.length; k++) {
    const l = x[2 * k] / 32768;
    const r = x[2 * k + 1] / 32768;
    mid += ((l + r) / 2) ** 2;
    side += ((l - r) / 2) ** 2;
  }
  return 10 * Math.log10((mid + 1e-9) / (side + 1e-9));
});
const med = [...rows].sort((p, q) => p - q)[Math.floor(rows.length / 2)];
console.log(`${src.title}: center-to-side in the voice band, dB against the median (${med.toFixed(1)} dB). V = sung, v = maybe.`);
for (let k = 0; k < rows.length; k += 8) {
  const r8 = rows.slice(k, k + 8).map((v) => v - med);
  console.log(`bar ${String(k).padStart(3)}  ${bars[k].start.toFixed(1).padStart(6)}s  ` + r8.map((d) => `${(d >= 0 ? '+' : '') + d.toFixed(1)}${d >= 3 ? 'V' : d >= 1.5 ? 'v' : ' '}`.padStart(7)).join(' '));
}
module.exports = {};
