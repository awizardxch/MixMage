// Fetches the yt-dlp binary into bin/ (official GitHub release). ffmpeg comes from the ffmpeg-static package.
const fs = require('fs');
const path = require('path');
const https = require('https');

const exe = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${exe}`;
const binDir = path.join(__dirname, '..', 'bin');
const dest = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function get(u, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': 'video-sampler-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, u).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      resolve(res);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(dest) && !process.argv.includes('--force')) {
    console.log('yt-dlp already present:', dest);
    return;
  }
  fs.mkdirSync(binDir, { recursive: true });
  console.log('Downloading', url);
  const res = await get(url);
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  fs.renameSync(tmp, dest);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  console.log('Saved', dest);
})().catch((e) => {
  console.error('yt-dlp download failed:', e.message, '\nRun "npm run setup" to retry.');
});
