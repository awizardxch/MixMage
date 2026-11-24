// A contact sheet of one source's clips, so titles, credits, logos, banners and dark frames can be
// found and left out by eye.
//   node scripts/clip-sheet.js <library folder> <source id> <out.jpg>
// Three frames per clip (at 15%, 50% and 85% of it), each labeled with the clip's index in time
// order, twelve to a row. Use three frames, not the clip's thumbnail: text that appears partway
// through a clip ("EVERY JULY" banners in a rodeo newsreel) never shows on its first frame.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const [lib, id, out] = process.argv.slice(2);
if (!out) { console.error('usage: node scripts/clip-sheet.js <library> <source id> <out.jpg>'); process.exit(1); }
const s = JSON.parse(fs.readFileSync(path.join(lib, 'state.json'), 'utf8'));
const src = s.sources.find((x) => x.id === id);
if (!src) throw new Error(`no source ${id}`);
const clips = s.pads.filter((c) => c && c.sourceId === id).sort((p, q) => p.start - q.start);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipsheet-'));
const files = [];
clips.forEach((c, k) => [0.15, 0.5, 0.85].forEach((f, j) => {
  const o = path.join(tmp, `${k}_${j}.jpg`);
  spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', (c.start + (c.end - c.start) * f).toFixed(2), '-i', src.file, '-frames:v', '1',
    '-vf', `scale=200:-2,drawtext=text='${k}':x=4:y=4:fontsize=22:fontcolor=yellow:box=1:boxcolor=black`, o]);
  if (fs.existsSync(o)) files.push(o);
}));
const args = ['-y', '-v', 'error'];
for (const f of files) args.push('-i', f);
args.push('-filter_complex', files.map((_, k) => `[${k}:v]`).join('') + `concat=n=${files.length}:v=1:a=0,tile=12x${Math.ceil(files.length / 12)}[o]`, '-map', '[o]', '-frames:v', '1', out);
const r = spawnSync(ffmpeg, args, { encoding: 'utf8' });
fs.rmSync(tmp, { recursive: true, force: true });
if (r.status) { console.error(r.stderr); process.exit(1); }
console.log(`${out}: ${clips.length} clips of ${src.title}`);
