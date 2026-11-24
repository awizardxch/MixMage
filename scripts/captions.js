// Fetches a YouTube video's captions (its own, or YouTube's automatic ones) and prints what is said when,
// so words can be matched to clips and titles without listening.
//   node scripts/captions.js <video id or url> [fromSeconds] [toSeconds]
// Captions are cached in demo/captions/<id>.json. Nothing but the caption text is downloaded.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ytdlp = path.join(root, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const dir = path.join(root, 'demo', 'captions');

function load(idOrUrl) {
  const id = (String(idOrUrl).match(/(?:v=|youtu\.be\/)([\w-]{6,})/) || [null, idOrUrl])[1];
  const cache = path.join(dir, `${id}.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const out = spawnSync(ytdlp, ['--js-runtimes', 'node', '--no-playlist', '--no-warnings', '--skip-download',
    '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en', '--sub-format', 'json3',
    '-o', path.join(dir, '%(id)s'), `https://www.youtube.com/watch?v=${id}`], { encoding: 'utf8' });
  const file = fs.readdirSync(dir).find((f) => f.startsWith(`${id}.`) && f.endsWith('.json3'));
  if (!file) {
    const none = { id, lines: [], note: (out.stderr || 'no captions available').trim().split('\n').pop() };
    // Remember "this video has none", but not a failed request (rate limits clear up; retry those later).
    if (!/ERROR/.test(out.stderr || '')) fs.writeFileSync(cache, JSON.stringify(none));
    return none;
  }
  const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const lines = [];
  for (const ev of raw.events || []) {
    const text = (ev.segs || []).map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ t: (ev.tStartMs || 0) / 1000, d: (ev.dDurationMs || 0) / 1000, text });
  }
  const data = { id, lines };
  fs.writeFileSync(cache, JSON.stringify(data));
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${id}.`) && f.endsWith('.json3')) fs.rmSync(path.join(dir, f));
  return data;
}

// The words spoken or sung between two times (used to label or choose clips).
function wordsBetween(data, from, to) {
  return data.lines.filter((l) => l.t < to && l.t + Math.max(l.d, 0.5) > from).map((l) => l.text).join(' ');
}

if (require.main === module) {
  const [idOrUrl, from, to] = process.argv.slice(2);
  if (!idOrUrl) { console.error('usage: node scripts/captions.js <video id or url> [fromSeconds] [toSeconds]'); process.exit(1); }
  const data = load(idOrUrl);
  if (!data.lines.length) { console.log(`No captions for ${data.id}${data.note ? `: ${data.note}` : ''}`); process.exit(0); }
  const a = Number(from) || 0;
  const b = Number(to) || Infinity;
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  for (const l of data.lines) if (l.t >= a && l.t <= b) console.log(`${fmt(l.t)}  ${l.text}`);
}

module.exports = { load, wordsBetween };
