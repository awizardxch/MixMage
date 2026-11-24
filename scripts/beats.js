// Tracks every beat of a song (src/beats.js) and prints what it found:
//   node scripts/beats.js <audio or video file> <tempo hint BPM> [--json out.json]
// Prints the refined tempo, the range of local tempo (how much the drummer moves), the downbeat
// phase and how clearly it won, then the bars: start time and bass root, 8 a row. With a live
// drummer, expect local tempo to wander a few percent; a fixed grid would drift off that band.
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { trackBeats, RATE } = require('../src/beats');

const [file, hint, flag, out] = process.argv.slice(2);
if (!hint) { console.error('usage: node scripts/beats.js <file> <bpm hint> [--json out.json]'); process.exit(1); }
const r = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 30 });
const x = new Int16Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + (r.stdout.length & ~1)));
const t0 = Date.now();
const res = trackBeats(x, Number(hint));
console.log(`TEMPO ${res.bpm} BPM; beat to beat ${res.localBpm.p5}-${res.localBpm.p95} (5th-95th percentile); ${res.beats.length} beats, ${res.bars.length} bars; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`ONSET VIEWS agreeing with the others (F-measure, 50 ms): ${Object.entries(res.agreement).map(([k, v]) => `${k} ${v}`).join(', ')}; chosen: ${res.chosen}`);
console.log(`DOWNBEAT phase ${res.downbeat} (scores ${res.phaseScore.join(' ')}); bass roots sure in ${res.bars.filter((b) => b.sure).length} of ${res.bars.length} bars (unsure bars keep the last sure root, marked ~)`);
// Tempo per 8 bars, to see the drift.
const per = [];
for (let k = 0; k + 8 < res.bars.length; k += 8) per.push((60 * 32) / (res.bars[k + 8].t - res.bars[k].t));
console.log(`TEMPO per 8 bars: ${per.map((b) => b.toFixed(1)).join(' ')}`);
for (let k = 0; k < res.bars.length; k += 8) {
  console.log(`bar ${String(k).padStart(3)}  ` + res.bars.slice(k, k + 8).map((b) => `${b.t.toFixed(2).padStart(7)} ${(b.root + (b.sure ? '' : '~')).padEnd(3)}`).join(' '));
}
if (flag === '--json' && out) fs.writeFileSync(out, JSON.stringify(res));
