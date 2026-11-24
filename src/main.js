const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Demo mode (DEMO_JS=<script> DEMO_OUT=<folder>): opens the real library read-only, runs a scripted
// performance, and saves a screen capture of the app plus the recorded output into DEMO_OUT.
// READONLY_LIBRARY=1 gives the same read-only view of the real library to a SMOKE_JS probe script.
const DEMO = !!process.env.DEMO_JS || !!process.env.READONLY_LIBRARY;
const SMOKE = process.argv.includes('--smoke') || DEMO;
const ffmpegPath = require('ffmpeg-static');
const ytdlpLocal = path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const ytdlpPath = () => (fs.existsSync(ytdlpLocal) ? ytdlpLocal : 'yt-dlp');
// YouTube needs a JavaScript runtime to unlock formats; without one yt-dlp reports videos as "not available".
// yt-dlp only looks for deno by default, so point it at the Node that is already installed.
const YTDLP_BASE = ['--js-runtimes', 'node', '--no-playlist', '--no-warnings'];

let root, libraryDir, clipsDir, recordingsDir, stateFile, win;

function initDirs() {
  // Smoke runs get a throwaway folder so they can never touch real clips or pad assignments.
  // SMOKE_ROOT: a named data folder of its own (used to build the demo's extra library).
  root = process.env.SMOKE_ROOT ? path.resolve(process.env.SMOKE_ROOT)
    : SMOKE && !DEMO ? path.join(app.getPath('temp'), SMOKE_TAG) : path.join(app.getPath('videos'), 'Video Sampler');
  libraryDir = path.join(root, 'library');
  clipsDir = path.join(root, 'clips');
  recordingsDir = DEMO ? path.resolve(process.env.DEMO_OUT || path.join(app.getPath('temp'), `${SMOKE_TAG}-out`)) : path.join(root, 'recordings');
  stateFile = path.join(root, 'state.json');
  for (const d of [root, libraryDir, clipsDir, recordingsDir]) fs.mkdirSync(d, { recursive: true });
}

const fileUrl = (p) => pathToFileURL(p).href;
const safeId = (s) => String(s).replace(/[^\w-]/g, '_');

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    const feed = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) err += text; else out += text;
      if (onLine) text.split(/\r?\n|\r/).forEach((l) => l && onLine(l));
    };
    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${path.basename(cmd)} not found. Run "npm run setup".` : e.message)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `${path.basename(cmd)} exited ${code}`))));
  });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { sources: [], pads: Array(16).fill(null), midiMap: {} };
  }
}

function saveState(state) {
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

const progress = (d) => win && !win.isDestroyed() && win.webContents.send('progress', d);

async function addSource(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('That is not a valid URL.'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) URLs are supported.');

  progress({ text: 'Reading video info…', pct: 0 });
  const info = JSON.parse(await run(ytdlpPath(), [...YTDLP_BASE, '-J', parsed.href]));
  const id = safeId(info.id);
  const file = path.join(libraryDir, `${id}.mp4`);

  if (!fs.existsSync(file)) {
    await run(ytdlpPath(), [
      ...YTDLP_BASE, '--newline',
      // H.264 + AAC in mp4 so Chromium plays it and seeks quickly; 720p keeps scrubbing snappy.
      '-S', 'vcodec:h264,res:720,acodec:m4a',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', ffmpegPath,
      '-o', path.join(libraryDir, `${id}.%(ext)s`),
      parsed.href,
    ], (line) => {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) progress({ text: `Downloading ${info.title}`, pct: Number(m[1]) });
      else if (/\[Merger\]/.test(line)) progress({ text: 'Merging audio and video…', pct: 100 });
    });
  }
  if (!fs.existsSync(file)) throw new Error('Download finished but no mp4 was produced.');
  progress({ text: '', pct: null });
  return { id, title: info.title || id, duration: info.duration || 0, file, url: fileUrl(file) };
}

// Searches YouTube by words and returns the top results (nothing is downloaded).
async function searchYoutube(query) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!q) return [];
  const out = await run(ytdlpPath(), ['--js-runtimes', 'node', '--no-warnings', '--flat-playlist',
    '--print', '%(id)s|~|%(title)s|~|%(duration)s|~|%(channel)s', `ytsearch12:${q}`]);
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, title, duration, channel] = line.split('|~|');
    return { id, title, duration: Number(duration) || 0, channel: channel === 'NA' ? '' : channel, url: `https://www.youtube.com/watch?v=${id}`, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
  }).filter((r) => /^[\w-]{6,}$/.test(r.id));
}

async function cutClip({ sourceFile, sourceId, start, end, name }) {
  if (!sourceFile || !path.resolve(sourceFile).startsWith(libraryDir)) throw new Error('Unknown source file.');
  start = Math.max(0, Number(start));
  const dur = Number(end) - start;
  if (!(dur > 0.02)) throw new Error('Clip is too short.');

  const id = `${safeId(sourceId)}_${Date.now().toString(36)}`;
  const video = path.join(clipsDir, `${id}.mp4`);
  const wav = path.join(clipsDir, `${id}.wav`);
  const thumb = path.join(clipsDir, `${id}.jpg`);
  const ss = start.toFixed(3);
  const t = dur.toFixed(3);

  // Re-encode so the cut is frame-accurate and starts on a keyframe; short GOP makes retriggering instant.
  await run(ffmpegPath, ['-y', '-v', 'error', '-ss', ss, '-i', sourceFile, '-t', t,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '12', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', video]);
  // Uncompressed audio beside it: decoded into memory for low-latency, sample-accurate pad playback.
  await run(ffmpegPath, ['-y', '-v', 'error', '-ss', ss, '-i', sourceFile, '-t', t, '-vn', '-ac', '2', '-ar', '48000', wav]);
  await run(ffmpegPath, ['-y', '-v', 'error', '-ss', ss, '-i', sourceFile, '-frames:v', '1', '-vf', 'scale=320:-2', thumb]).catch(() => {});

  return {
    id, sourceId, start, end: start + dur, name: name || 'Clip',
    file: video, url: fileUrl(video), wav,
    thumb: fs.existsSync(thumb) ? fileUrl(thumb) : null,
    mode: 'gate', gain: 1,
  };
}

// Every beat of a song (src/beats.js), worked out in a background thread so the app never stalls,
// and kept for the session. { bpm, beats, downbeat, bars, ... }; see beats.js.
const beatCache = new Map();
function mediaBeats({ file, bpm }) {
  const key = `${file}|${bpm || ''}`;
  if (!beatCache.has(key)) {
    const job = (async () => {
      const { RATE } = require('./beats');
      const pcm = await decodePcm(file, 0, 36000, RATE);
      const { Worker } = require('worker_threads');
      return new Promise((resolve, reject) => {
        const w = new Worker(`const { parentPort, workerData } = require('worker_threads');
          const { trackBeats } = require(workerData.mod);
          parentPort.postMessage(trackBeats(new Int16Array(workerData.pcm), workerData.bpm));`,
        { eval: true, workerData: { mod: path.join(__dirname, 'beats.js'), pcm: pcm.buffer, bpm: bpm || 120 } });
        w.once('message', resolve);
        w.once('error', reject);
      });
    })();
    job.catch(() => beatCache.delete(key));
    beatCache.set(key, job);
  }
  return beatCache.get(key);
}

function decodePcm(file, start, dur, rate) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-v', 'error', '-ss', start.toFixed(3), '-i', file, '-t', dur.toFixed(3),
      '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    let err = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited ${code}`));
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1))));
    });
  });
}

// Finds the strongest audio onsets (drum hits, word starts, cuts) in a region; returns up to `count` times in seconds.
async function findHits({ sourceFile, start, end, count }) {
  if (!sourceFile || !path.resolve(sourceFile).startsWith(libraryDir)) throw new Error('Unknown source file.');
  start = Math.max(0, Number(start));
  const dur = Number(end) - start;
  if (!(dur > 0.2)) throw new Error('Region is too short to analyze.');
  const rate = 11025;
  const hop = 256; // ~23 ms
  const pcm = await decodePcm(sourceFile, start, dur, rate);
  const frames = Math.floor(pcm.length / hop);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let k = f * hop, e = k + hop; k < e; k++) sum += pcm[k] * pcm[k];
    env[f] = Math.log1p(100 * Math.sqrt(sum / hop) / 32768);
  }
  const nov = new Float32Array(frames);
  for (let f = 0; f < frames; f++) nov[f] = Math.max(0, env[f] - (f ? env[f - 1] : 0));

  const win = 20; // ~0.5 s either side for the adaptive threshold
  const gap = 6; // hits closer than ~140 ms merge into one
  const peaks = [];
  for (let f = 0; f < frames; f++) {
    if (!nov[f]) continue;
    let mean = 0;
    let n = 0;
    let isMax = true;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win + 1); k++) {
      mean += nov[k];
      n++;
      if (Math.abs(k - f) <= gap && (nov[k] > nov[f] || (nov[k] === nov[f] && k < f))) isMax = false;
    }
    if (isMax && nov[f] > 1.5 * (mean / n) + 0.02) peaks.push({ f, strength: nov[f] });
  }
  return peaks
    .sort((a, b) => b.strength - a.strength)
    .slice(0, Math.max(1, Number(count) || 16))
    .map((p) => Math.max(start, start + (p.f * hop) / rate - 0.01)) // 10 ms pre-roll keeps the attack
    .sort((a, b) => a - b);
}

// Finds sounds that stand on their own — a hit, a note, a word, an effect — rather than slices of a
// continuous mix: stretches that rise clearly out of quieter audio and fall back again. When the audio
// is too dense to have gaps, the strongest onsets fill the remaining places as short slices.
// Each result is named by what it sounds like, with its pitch when it has one.
async function findSounds({ sourceFile, start, end, count }) {
  if (!sourceFile || !path.resolve(sourceFile).startsWith(libraryDir)) throw new Error('Unknown source file.');
  start = Math.max(0, Number(start));
  const span = Number(end) - start;
  if (!(span > 0.3)) throw new Error('Region is too short to analyze.');
  count = Math.max(1, Number(count) || 16);
  const rate = 11025;
  const hop = 64; // ~5.8 ms
  const fps = rate / hop;
  const pcm = await decodePcm(sourceFile, start, span, rate);
  const frames = Math.floor(pcm.length / hop);
  if (frames < 50) return [];
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let k = f * hop, e = k + hop; k < e; k++) sum += pcm[k] * pcm[k];
    db[f] = 20 * Math.log10(Math.sqrt(sum / hop) / 32768 + 1e-5);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(frames * 0.1)];
  const peak = sorted[Math.floor(frames * 0.97)];
  const cands = [];
  const overlaps = (s, e) => cands.some((c) => s < c.e && e > c.s);

  if (peak - floor >= 6) {
    const on = floor + Math.max(8, 0.4 * (peak - floor));
    const off = on - 6;
    const hold = Math.round(0.06 * fps);
    let s = -1;
    let quiet = 0;
    const close = (e) => {
      const len = (e - s) / fps;
      if (len >= 0.05 && len <= 2.5) {
        let b = s;
        for (let k = 0; k < Math.round(0.02 * fps) && b > 0 && db[b - 1] < db[b]; k++) b--; // include the attack
        let pk = -200;
        for (let f = b; f < e; f++) pk = Math.max(pk, db[f]);
        let pre = 0;
        const n = Math.round(0.15 * fps);
        for (let f = Math.max(0, b - n); f < b; f++) pre += db[f];
        pre = b > 0 ? pre / Math.min(n, b) : floor;
        cands.push({ s: b, e, score: (pk - pre) + 0.3 * (pk - floor) });
      }
      s = -1;
    };
    for (let f = 0; f < frames; f++) {
      if (s < 0) { if (db[f] > on) { s = f; quiet = 0; } continue; }
      if (db[f] < off) { if (++quiet >= hold) close(f - quiet + 1); } else quiet = 0;
    }
    if (s >= 0) close(frames);
  }

  if (cands.length < count) {
    // Dense audio: add the strongest onsets, each running to the next onset (0.8 s at most).
    const nov = new Float32Array(frames);
    for (let f = 4; f < frames; f++) nov[f] = Math.max(0, db[f] - db[f - 4]);
    const gap = Math.round(0.09 * fps);
    const win = Math.round(0.4 * fps);
    const onsets = [];
    for (let f = 0; f < frames; f++) {
      if (nov[f] < 3) continue;
      let isMax = true;
      let mean = 0;
      let n = 0;
      for (let k = Math.max(0, f - win); k < Math.min(frames, f + win + 1); k++) {
        mean += nov[k];
        n++;
        if (Math.abs(k - f) <= gap && (nov[k] > nov[f] || (nov[k] === nov[f] && k < f))) isMax = false;
      }
      if (isMax && nov[f] > 1.5 * (mean / n)) onsets.push({ f: Math.max(0, f - 4), strength: nov[f] });
    }
    onsets.forEach((o, k) => {
      const e = Math.min(frames, k + 1 < onsets.length ? onsets[k + 1].f : frames, o.f + Math.round(0.8 * fps));
      if ((e - o.f) / fps >= 0.06 && !overlaps(o.f, e)) cands.push({ s: o.f, e, score: -100 + o.strength });
    });
  }

  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const describe = (c) => {
    const a = c.s * hop + Math.round(0.02 * rate);
    const n = Math.min(2048, c.e * hop - a);
    if (n < 400) return { label: 'Click' };
    // Work on a copy with any constant offset removed: an offset repeats at every lag and reads as a pitch.
    let mean = 0;
    for (let k = a; k < a + n; k++) mean += pcm[k];
    mean /= n;
    const x = new Float32Array(n);
    for (let k = 0; k < n; k++) x[k] = pcm[a + k] - mean;
    let zc = 0;
    let e0 = 0;
    for (let k = 1; k < n; k++) { if ((x[k - 1] < 0) !== (x[k] < 0)) zc++; e0 += x[k] * x[k]; }
    // Pitch: the lag (60-1000 Hz) at which the sound best repeats itself.
    const ac = (lag) => { let s = 0; for (let k = 0; k < n - lag; k++) s += x[k] * x[k + lag]; return s / (n - lag); };
    const e0n = e0 / n || 1;
    let bestLag = 0;
    let best = 0;
    for (let lag = 11; lag <= 183 && lag < n / 2; lag++) { const v = ac(lag) / e0n; if (v > best) { best = v; bestLag = lag; } }
    if (best > 0.6) {
      const y0 = ac(bestLag - 1);
      const y1 = ac(bestLag);
      const y2 = ac(bestLag + 1);
      const d = y0 - 2 * y1 + y2;
      const lag = bestLag + (d ? (0.5 * (y0 - y2)) / d : 0);
      const midi = Math.round(69 + 12 * Math.log2(rate / lag / 440));
      return { label: `Tone ${noteNames[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`, note: midi };
    }
    const hz = (zc / n) * rate / 2;
    return { label: hz < 400 ? 'Low hit' : hz < 1500 ? 'Mid hit' : 'Bright hit' };
  };

  return cands
    .sort((x, y) => y.score - x.score)
    .slice(0, count)
    .sort((x, y) => x.s - y.s)
    .map((c) => ({
      start: Math.max(start, start + (c.s * hop) / rate - 0.005),
      end: Math.min(start + span, start + (c.e * hop) / rate + 0.03),
      isolated: c.score > -50,
      ...describe(c),
    }));
}

// Estimates the tempo of a file from about a minute of its audio. Returns BPM or null when no steady beat shows.
async function estimateBpm({ file, duration }) {
  if (!file || !path.resolve(file).startsWith(root)) throw new Error('Unknown media file.');
  duration = Number(duration) || 0;
  const start = duration > 120 ? duration * 0.25 : 0; // skip intros on long videos
  const rate = 11025;
  const hop = 128; // ~11.6 ms, fine enough to place a beat period
  const pcm = await decodePcm(file, start, Math.min(60, duration || 60), rate);
  const frames = Math.floor(pcm.length / hop);
  if (frames < 200) return null;
  const nov = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let k = f * hop, e = k + hop; k < e; k++) sum += pcm[k] * pcm[k];
    const env = Math.log1p(100 * Math.sqrt(sum / hop) / 32768);
    nov[f] = Math.max(0, env - prev);
    prev = env;
  }
  const fps = rate / hop;
  const ac = (lag) => {
    let s = 0;
    for (let f = lag; f < frames; f++) s += nov[f] * nov[f - lag];
    return s / (frames - lag);
  };
  const minLag = Math.round((fps * 60) / 180);
  const maxLag = Math.min(Math.round((fps * 60) / 70), Math.floor(frames / 2));
  let best = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = ac(lag) * Math.exp(-0.5 * (Math.log2((60 * fps) / lag / 120) / 0.6) ** 2);
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (!best || ac(best) < 0.08 * ac(0)) return null;
  // One frame of lag is about 2 BPM, too coarse to sync by. Refine the period by also asking how well
  // 2, 3 and 4 beats later line up, which resolves it four times finer.
  const cache = new Map();
  const acAt = (x) => {
    const lo = Math.floor(x);
    if (lo < 1 || lo + 1 >= frames - 1) return 0;
    for (const l of [lo, lo + 1]) if (!cache.has(l)) cache.set(l, ac(l));
    return cache.get(lo) + (x - lo) * (cache.get(lo + 1) - cache.get(lo));
  };
  let lag = best;
  let top = -1;
  for (let p = best - 1.5; p <= best + 1.5; p += 0.02) {
    const s = acAt(p) + acAt(2 * p) + acAt(3 * p) + acAt(4 * p);
    if (s > top) { top = s; lag = p; }
  }
  return Math.round(((60 * fps) / lag) * 10) / 10;
}

// Measures how loud a file is over about a minute of it: RMS of the parts that are sounding, and peak.
async function mediaLevel({ file, duration }) {
  if (!file || !(path.resolve(file).startsWith(root) || (process.env.DEMO_EXTRA && path.resolve(file).startsWith(path.resolve(process.env.DEMO_EXTRA))))) throw new Error('Unknown media file.');
  duration = Number(duration) || 0;
  const start = duration > 120 ? duration * 0.25 : 0;
  const rate = 11025;
  const pcm = await decodePcm(file, start, Math.min(60, duration || 60), rate);
  const win = Math.round(0.05 * rate);
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let s = 0; s + win <= pcm.length; s += win) {
    let e = 0;
    for (let k = s; k < s + win; k++) { const v = pcm[k] / 32768; e += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    e /= win;
    if (e > 1e-5) { sum += e; n++; }
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}

// Saves a deck recording: MediaRecorder's webm has no duration or seek index, so it is rewritten as mp4.
async function saveRecording(bytes, title) {
  const id = `rec_${Date.now().toString(36)}`;
  const webm = path.join(recordingsDir, `${id}.webm`);
  const file = path.join(recordingsDir, `${id}.mp4`);
  await fs.promises.writeFile(webm, Buffer.from(bytes));
  try {
    await run(ffmpegPath, ['-y', '-v', 'error', '-i', webm, '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '12', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', file]);
  } finally {
    fs.rmSync(webm, { force: true });
  }
  return { id, title: title || 'Recording', file, url: fileUrl(file), created: Date.now() };
}

function removeClipFiles(clipId) {
  const id = safeId(clipId);
  for (const ext of ['mp4', 'wav', 'jpg']) fs.rmSync(path.join(clipsDir, `${id}.${ext}`), { force: true });
}

function registerIpc() {
  ipcMain.handle('state:load', () => loadState());
  // Demo mode never writes to or deletes from the library.
  const guard = (fn) => (DEMO ? () => undefined : fn);
  ipcMain.handle('state:save', guard((_e, state) => saveState(state)));
  ipcMain.handle('source:add', guard((_e, url) => addSource(url)));
  ipcMain.handle('source:remove', guard((_e, id) => fs.rmSync(path.join(libraryDir, `${safeId(id)}.mp4`), { force: true })));
  ipcMain.handle('clip:cut', guard((_e, opts) => cutClip(opts)));
  ipcMain.handle('source:hits', (_e, opts) => findHits(opts));
  ipcMain.handle('yt:search', (_e, q) => searchYoutube(q));
  ipcMain.handle('source:sounds', (_e, opts) => findSounds(opts));
  ipcMain.handle('media:level', (_e, opts) => mediaLevel(opts));
  ipcMain.handle('media:bpm', (_e, opts) => estimateBpm(opts));
  ipcMain.handle('media:beats', (_e, opts) => mediaBeats(opts));
  ipcMain.handle('rec:save', (_e, bytes, title) => saveRecording(bytes, title));
  ipcMain.handle('rec:remove', guard((_e, id) => fs.rmSync(path.join(recordingsDir, `${safeId(id)}.mp4`), { force: true })));
  ipcMain.handle('clip:audio', (_e, clipId) => {
    const name = `${safeId(clipId)}.wav`;
    const own = path.join(clipsDir, name);
    // Demo mode can also draw on a second, demo-only library (DEMO_EXTRA).
    const extra = process.env.DEMO_EXTRA && path.join(path.resolve(process.env.DEMO_EXTRA), 'clips', name);
    return fs.promises.readFile(extra && !fs.existsSync(own) ? extra : own);
  });
  ipcMain.handle('clip:remove', guard((_e, clipId) => removeClipFiles(clipId)));
  ipcMain.handle('folder:open', () => shell.openPath(root));
}

// Runs the demo script's performance while grabbing the app window, then joins those frames with the
// sound of the recorded output: demo-app.mp4 (the program in use) and final-take.mp4 (the output itself).
async function runDemo() {
  const out = recordingsDir;
  fs.mkdirSync(out, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const variant = (process.env.DEMO_VARIANT || 'mix').replace(/[^\w-]/g, '');
  const extraFile = process.env.DEMO_EXTRA && path.join(path.resolve(process.env.DEMO_EXTRA), 'state.json');
  const extra = extraFile && fs.existsSync(extraFile) ? fs.readFileSync(extraFile, 'utf8') : 'null';
  await js(`window.__demoVariant = ${JSON.stringify(variant)}; window.__demoExtra = ${extra}; window.__demoTalkPicks = ${JSON.stringify(process.env.DEMO_TALK_PICKS || '')}; window.__demoSwap = ${!!process.env.DEMO_SWAP}; 0`);
  await js(`${fs.readFileSync(process.env.DEMO_JS, 'utf8')}\n;0`);
  console.log('DEMO_PREPARE', JSON.stringify(await js('window.__demoPrepare()')));

  // Keep the window in front while it is filmed: a covered window is not repainted.
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  await sleep(400);
  const frames = [];
  // DEMO_NO_APP=1 skips filming the app (only the output is made): the frames are held in memory,
  // about 250 KB each at 20 a second, too much for a piece several minutes long.
  const filmApp = !process.env.DEMO_NO_APP;
  let capturing = filmApp;
  const grab = (async () => {
    while (capturing) {
      const t = Date.now();
      const img = await win.webContents.capturePage();
      frames.push({ t, jpg: img.toJPEG(90) });
      const wait = 50 - (Date.now() - t); // about 20 frames a second, light enough not to disturb playback
      if (wait > 0) await sleep(wait);
    }
  })();
  const res = await js('window.__demoRun()');
  capturing = false;
  await grab;
  console.log('DEMO_RUN', JSON.stringify(res), 'frames', frames.length);
  if (!res || !res.file) throw new Error('the performance produced no recording');

  const final = path.join(out, `${variant}-output.mp4`);
  fs.rmSync(final, { force: true });
  // Master the sound: every piece leaves at the same loudness (-14 LUFS, peaks under -1.5 dB), with
  // stabs and quiet passages evened toward it. The picture is copied untouched.
  await run(ffmpegPath, ['-y', '-v', 'error', '-i', res.file, '-c:v', 'copy',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=9', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final]);
  fs.rmSync(res.file, { force: true });
  if (!filmApp) { console.log('DEMO_DONE', JSON.stringify({ final })); return; }

  const dir = path.join(out, `frames-${variant}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const used = frames.filter((f) => f.t >= res.recStart - 250 && f.t <= res.recEnd + 250);
  let list = '';
  used.forEach((f, k) => {
    const name = `f${String(k).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), f.jpg);
    const next = used[k + 1] ? used[k + 1].t : f.t + 66;
    list += `file '${name}'\nduration ${((next - f.t) / 1000).toFixed(3)}\n`;
  });
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const offset = Math.max(0, (res.recStart - used[0].t) / 1000).toFixed(3);
  const app2 = path.join(out, `${variant}-app.mp4`);
  await run(ffmpegPath, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
    '-itsoffset', offset, '-i', final, '-map', '0:v', '-map', '1:a',
    '-vf', 'fps=30,scale=1280:-2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', app2]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('DEMO_DONE', JSON.stringify({ final, app: app2, framesUsed: used.length }));
}

function createWindow() {
  // Web MIDI needs an explicit grant in Electron.
  const allow = new Set(['midi', 'midiSysex']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allow.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow.has(permission));

  win = new BrowserWindow({
    width: 1500, height: 1000, minWidth: 1200, minHeight: 760,
    backgroundColor: '#101114', // shown even in smoke runs: a hidden window gets no animation frames
    title: 'Mixmage — the spellweaver of sound and vision',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (SMOKE) {
    let errors = 0;
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
      if (level >= 3) errors++;
    });
    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const summary = await win.webContents.executeJavaScript('window.__smoke ? window.__smoke() : "no smoke hook"');
      console.log('SMOKE', JSON.stringify(summary), 'errors', errors);
      if (process.env.DEMO_JS) {
        try { await runDemo(); } catch (e) { console.log('DEMO_ERROR', e.stack || e.message); return app.exit(1); }
        return app.exit(0);
      }
      if (process.env.SMOKE_JS) {
        // Ad-hoc scenario: run a script file in the page (with `src` set when SMOKE_SRC is given) and print its result.
        let src = null;
        if (process.env.SMOKE_SRC) {
          const file = path.join(libraryDir, '_smoke.mp4');
          if (!fs.existsSync(file)) fs.copyFileSync(process.env.SMOKE_SRC, file);
          src = { id: '_smoke', title: 'smoke', duration: 0, file, url: fileUrl(file) };
        }
        const body = fs.readFileSync(process.env.SMOKE_JS, 'utf8');
        const res = await win.webContents.executeJavaScript(`(async (src) => { ${body} })(${JSON.stringify(src)})`);
        console.log('SMOKE_JS', JSON.stringify(res));
        await new Promise((r) => setTimeout(r, 600));
        return app.exit(0);
      }
      if (process.env.SMOKE_SRC) {
        const file = path.join(libraryDir, '_smoke.mp4');
        fs.copyFileSync(process.env.SMOKE_SRC, file);
        const src = { id: '_smoke', title: 'smoke', duration: 6, file, url: fileUrl(file) };
        const cut = await win.webContents.executeJavaScript(`window.__smokeCut(${JSON.stringify(src)})`);
        console.log('SMOKE_CUT', JSON.stringify(cut));
        const auto = await win.webContents.executeJavaScript(`window.__smokeAuto(${JSON.stringify(src)})`);
        console.log('SMOKE_AUTO', JSON.stringify(auto));
        if (JSON.stringify(auto.midiPages.seen) !== '[2,1,1,1]' || !auto.midiPages.learningEnded) errors++;
        const dk = await win.webContents.executeJavaScript(`window.__smokeDecks(${JSON.stringify(src)})`);
        console.log('SMOKE_DECKS', JSON.stringify(dk));
        if (!dk.aPlaying || !dk.recLoaded || !(dk.recSeconds > 0.8) || Math.abs(dk.syncedBpm - dk.aBpmAfterSet) > 0.2
          || !dk.finalSaved || !(dk.deckAudioLevel > 0.01) || !dk.deleteKeyCleared
          || dk.blend.midLayers !== 2 || dk.blend.afterLayers !== 1 || !dk.blend.tailStillRunning || !dk.blend.tailEnded || dk.blend.hardCutLayers !== 1
          || auto.wholeSong.hintLoop.beats !== 4 || auto.wholeSong.hintLoop.bpm !== 120) errors++;
        const fxr = await win.webContents.executeJavaScript('window.__smokeFx()');
        console.log('SMOKE_FX', JSON.stringify(fxr));
        // Every effect and preset must paint without error, and change a still test frame (stutter
        // and trails only show on moving pictures); the strobe must stay at 3 flashes a second or fewer.
        const still = ['stutter', 'trails'];
        const unchanged = Object.entries(fxr.effects).filter(([k, v]) => !still.includes(k) && !(v > 1)).map(([k]) => k);
        if (fxr.errors.length || unchanged.length || !(fxr.text > 0.5) || !(fxr.flashesIn2s >= 4 && fxr.flashesIn2s <= 7) || !fxr.viewerCanvas) {
          console.log('SMOKE_FX_FAIL', JSON.stringify({ errors: fxr.errors, unchanged, flashes: fxr.flashesIn2s }));
          errors++;
        }
        const tb = await mediaBeats({ file: src.file, bpm: 118 });
        const gaps = tb.beats.slice(1).map((t, k) => t - tb.beats[k]);
        const spread = Math.max(...gaps.slice(2, -2)) - Math.min(...gaps.slice(2, -2));
        console.log('SMOKE_TRACK', JSON.stringify({ bpm: tb.bpm, beats: tb.beats.length, spread: +spread.toFixed(3), downbeat: tb.downbeat }));
        if (Math.abs(tb.bpm - 120) > 1 || tb.beats.length < 8 || spread > 0.03) errors++;
        const bt = await win.webContents.executeJavaScript('window.__smokeBeat()');
        console.log('SMOKE_BEAT', JSON.stringify(bt));
        if (!(bt.peak > 0.2) || !(bt.minDuck < 0.7) || !(bt.restored > 0.95)) errors++;
        const finals = fs.readdirSync(recordingsDir).filter((f) => f.endsWith('.mp4'));
        console.log('SMOKE_FILES', JSON.stringify(finals.map((f) => [f, fs.statSync(path.join(recordingsDir, f)).size])));
        const ws = auto.wholeSong;
        const ra = auto.rearrange;
        if (ws.pages !== 2 || ws.page1 !== 16 || ws.page2 !== 4 || !ra.swapped || !ra.movedToEmpty || !ra.movedPadPlays) errors++;
        const pg = auto.pages;
        if (!auto.hits.clips || !auto.equal.clips || pg.count !== 2 || pg.onPage2 !== 16 || !pg.page2PadStillPlaying || pg.afterRemove.pads !== 16) errors++;
        fs.rmSync(file, { force: true });
        if (!cut.cut || !cut.playing) errors++;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (process.env.SMOKE_SHOT) fs.writeFileSync(process.env.SMOKE_SHOT, (await win.webContents.capturePage()).toPNG());
      console.log('SMOKE_DONE errors', errors); // the verdict after every check (the SMOKE line comes before most of them)
      app.exit(errors ? 1 : 0);
    }, 2500));
  }
  // Smoke runs list MIDI devices without opening them (SMOKE_MIDI=1 opens them, to test port sharing),
  // so a test can never take a controller away from a running copy of the app.
  const query = SMOKE ? { smoke: '1', openMidi: process.env.SMOKE_MIDI ? '1' : '' } : {};
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
}

// Smoke runs keep their own browser profile so they never contend with a running copy of the app.
// Each run gets its own (pid-named) profile and data folder, removed again on exit.
// SMOKE_KEEP names a data folder to keep between runs (to test loading a big saved session).
const SMOKE_TAG = `video-sampler-smoke-${process.env.SMOKE_KEEP || process.pid}`;
if (SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), `video-sampler-smoke-${process.pid}-profile`));
  process.on('exit', () => {
    for (const d of [`video-sampler-smoke-${process.pid}-profile`, ...(process.env.SMOKE_KEEP ? [] : [SMOKE_TAG])]) try { fs.rmSync(path.join(app.getPath('temp'), d), { recursive: true, force: true }); } catch {}
  });
}

// MIDI pads are not "user gestures", so audio must be allowed to start without one.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Keep clips and animation running when another window covers this one (Chromium otherwise pauses
// muted video and animation frames in a covered window, which freezes the picture and loop sync).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Chromium allows about 75 media players per page; many pages of pads plus the decks can pass that.
app.commandLine.appendSwitch('max-web-media-player-count', '2000');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

app.whenReady().then(() => {
  initDirs();
  registerIpc();
  createWindow();
});
app.on('window-all-closed', () => app.quit());

module.exports = { cutClip, initDirs };
