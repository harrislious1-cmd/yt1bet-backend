const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const helmet = require('helmet');
const pLimit = require('p-limit');
const rateLimit = require('express-rate-limit');

const app = express();
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(helmet());

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://yt1bet.vercel.app',
  'https://dlmate.site',
  'https://www.dlmate.site'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const limit = pLimit(3);

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many requests, please wait a moment.' }
});

const YT_CLIENTS = ['android_vr', 'android', 'mweb'];

const URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|instagram\.com)\//i;

function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

function isInstagram(url) {
  return url.includes('instagram.com');
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp server running' });
});

app.get('/download', downloadLimiter, async (req, res) => {
  const { url, format, quality } = req.query;
  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (!URL_PATTERN.test(url)) {
    return res.status(400).json({ error: 'Only YouTube or Instagram URLs are supported' });
  }

  try {
    await limit(() => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
      return isInstagram(url)
        ? downloadInstagram(url, format, quality, tmpDir, res)
        : downloadYouTube(url, format, quality, tmpDir, res);
    });
  } catch (err) {
    console.error('Download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed. Please try again.' });
    }
  }
});

async function downloadInstagram(url, format, quality, tmpDir, res) {
  if (format === 'mp3') {
    const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
    const args = ['--no-playlist', '-q', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, url];
    await runYtDlp(args);

    const files = fs.readdirSync(tmpDir);
    const mp3File = files.find(f => f.endsWith('.mp3'));
    if (!mp3File) throw new Error('Audio extraction failed');

    const filePath = path.join(tmpDir, mp3File);
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));

  } else {
    const outputPath = path.join(tmpDir, 'output.mp4');
    const args = ['--no-playlist', '-q', '-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', outputPath, url];
    await runYtDlp(args);

    let finalFile = outputPath;
    if (!fs.existsSync(finalFile)) {
      const files = fs.readdirSync(tmpDir);
      const mp4File = files.find(f => f.endsWith('.mp4'));
      if (mp4File) finalFile = path.join(tmpDir, mp4File);
      else throw new Error('Video download failed');
    }

    const stat = fs.statSync(finalFile);
    res.setHeader('Content-Disposition', 'attachment; filename="reel.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(finalFile);
    stream.pipe(res);
    stream.on('end', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));
  }
}

async function downloadYouTube(url, format, quality, tmpDir, res) {
  let lastError = null;

  for (const client of YT_CLIENTS) {
    try {
      console.log(`Trying client: ${client}`);
      const clientArgs = ['--extractor-args', `youtube:player_client=${client}`, '--no-playlist', '-q'];

      if (format === 'mp3') {
        const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
        const args = [...clientArgs, '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, url];
        await runYtDlp(args);

        const files = fs.readdirSync(tmpDir);
        const mp3File = files.find(f => f.endsWith('.mp3'));
        if (!mp3File) throw new Error('MP3 conversion failed');

        const filePath = path.join(tmpDir, mp3File);
        res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
        res.setHeader('Content-Type', 'audio/mpeg');
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('end', () => cleanup(tmpDir));
        stream.on('error', () => cleanup(tmpDir));
        return;

      } else {
        const outputPath = path.join(tmpDir, 'output.mp4');

        let formatSelector;
        if (quality === '1080p') {
          formatSelector = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]';
        } else if (quality === '720p') {
          formatSelector = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]';
        } else if (quality === '480p') {
          formatSelector = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]';
        } else {
          formatSelector = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
        }

        const args = [...clientArgs, '-f', formatSelector, '--merge-output-format', 'mp4', '-o', outputPath, url];
        await runYtDlp(args);

        let finalFile = outputPath;
        if (!fs.existsSync(finalFile)) {
          const files = fs.readdirSync(tmpDir);
          const mp4File = files.find(f => f.endsWith('.mp4'));
          if (mp4File) finalFile = path.join(tmpDir, mp4File);
          else throw new Error('Video download failed');
        }

        const stat = fs.statSync(finalFile);
        res.setHeader('Content-Disposition', `attachment; filename="video_${quality || '720p'}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(finalFile);
        stream.pipe(res);
        stream.on('end', () => cleanup(tmpDir));
        stream.on('error', () => cleanup(tmpDir));
        return;
      }

    } catch (err) {
      console.error(`Client ${client} failed:`, err.message);
      lastError = err;
      try { fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f))); } catch {}
      continue;
    }
  }

  throw new Error(lastError?.message || 'All download methods failed');
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    console.log('Running yt-dlp with args:', args);
    execFile('yt-dlp', args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('stderr:', stderr);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
