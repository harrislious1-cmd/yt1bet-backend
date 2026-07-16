const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const helmet = require('helmet');
const pLimit = require('p-limit');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Overall response timeout safety net (separate from yt-dlp's own timeout)
app.use((req, res, next) => {
  res.setTimeout(150000, () => {
    if (!res.headersSent) res.status(503).json({ error: 'Request timed out' });
  });
  next();
});

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

// Separate, more generous limiter for thumbnails since they're cheap (no yt-dlp/ffmpeg work)
const thumbnailLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please wait a moment.' }
});

// Transcript fetching is also cheap (no video/audio processing), similar limit to thumbnails
const transcriptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please wait a moment.' }
});

const YT_CLIENTS = ['android_vr', 'android', 'mweb'];

const URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be|instagram\.com)\//i;
const YT_URL_PATTERN = /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i;

// Reject videos longer than this (seconds) before download starts
const MAX_DURATION_SECONDS = 3600; // 1 hour

function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

function isInstagram(url) {
  return url.includes('instagram.com');
}

// Extracts an 11-character YouTube video ID from any standard YouTube URL format
function extractYouTubeId(url) {
  const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Parses a WebVTT caption file into an array of { time, text } lines,
// stripping HTML-ish tags and removing duplicate lines auto-captions often produce
function parseVtt(raw) {
  const lines = raw.split('\n');
  const result = [];
  let currentTime = null;
  const seenText = new Set();

  for (const line of lines) {
    const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})\.\d{3}\s-->/);
    if (timeMatch) {
      currentTime = timeMatch[1];
      continue;
    }
    const clean = line.replace(/<[^>]*>/g, '').trim();
    if (clean && currentTime && !clean.startsWith('WEBVTT') && !clean.match(/^\d+$/)) {
      const key = currentTime + clean;
      if (!seenText.has(key)) {
        seenText.add(key);
        result.push({ time: currentTime, text: clean });
      }
    }
  }
  return result;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'yt-dlp server running' });
});

// ── THUMBNAIL DOWNLOAD (YouTube only, no yt-dlp needed) ──────────────
app.get('/thumbnail', thumbnailLimiter, async (req, res) => {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (url.length > 500) return res.status(400).json({ error: 'Invalid URL' });
  if (!YT_URL_PATTERN.test(url)) {
    return res.status(400).json({ error: 'Only YouTube URLs are supported for thumbnails' });
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not find a video ID in that URL' });

  // Try highest quality first, fall back if YouTube doesn't have it for this video
  const sizesToTry = ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', 'default'];

  for (const size of sizesToTry) {
    const imgUrl = `https://img.youtube.com/vi/${videoId}/${size}.jpg`;
    try {
      const response = await fetch(imgUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        // YouTube returns a tiny grey placeholder image (under ~1.5KB) when a
        // given size doesn't actually exist for this video — skip those.
        if (buffer.length > 1500) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'image/jpeg');
          return res.send(buffer);
        }
      }
    } catch (e) {
      continue;
    }
  }

  return res.status(404).json({ error: 'Thumbnail not available for this video' });
});

// ── TRANSCRIPT DOWNLOAD (YouTube only) ────────────────────────────────
// format=plain      -> plain text, no timestamps
// format=timestamped -> each line prefixed with [HH:MM:SS]
app.get('/transcript', transcriptLimiter, async (req, res) => {
  const { url, format } = req.query;

  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (url.length > 500) return res.status(400).json({ error: 'Invalid URL' });
  if (!YT_URL_PATTERN.test(url)) {
    return res.status(400).json({ error: 'Only YouTube URLs are supported for transcripts' });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytsub-'));

  try {
    const outputTemplate = path.join(tmpDir, 'sub');
    const args = [
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'en',
      '--sub-format', 'vtt',
      '--no-playlist', '-q',
      '-o', outputTemplate,
      url
    ];
    await runYtDlp(args);

    const files = fs.readdirSync(tmpDir);
    const vttFile = files.find(f => f.endsWith('.vtt'));
    if (!vttFile) throw new Error('No captions available for this video');

    const raw = fs.readFileSync(path.join(tmpDir, vttFile), 'utf-8');
    const parsed = parseVtt(raw);

    if (parsed.length === 0) throw new Error('No captions available for this video');

    const output = format === 'timestamped'
      ? parsed.map(l => `[${l.time}] ${l.text}`).join('\n')
      : parsed.map(l => l.text).join(' ');

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="transcript.txt"');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(output);

  } catch (err) {
    console.error('Transcript error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Transcript not available for this video.' });
    }
  } finally {
    cleanup(tmpDir);
  }
});

app.get('/download', downloadLimiter, async (req, res) => {
  const { url, format, quality } = req.query;

  if (!url) return res.status(400).json({ error: 'No URL provided' });
  if (url.length > 500) return res.status(400).json({ error: 'Invalid URL' });
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
  const durationFilter = ['--match-filter', `duration < ${MAX_DURATION_SECONDS}`];

  if (format === 'mp3') {
    const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
    const args = ['--no-playlist', '-q', ...durationFilter, '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, url];
    await runYtDlp(args);

    const files = fs.readdirSync(tmpDir);
    const mp3File = files.find(f => f.endsWith('.mp3'));
    if (!mp3File) throw new Error('Audio extraction failed');

    const filePath = path.join(tmpDir, mp3File);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.setHeader('Content-Type', 'audio/mpeg');
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('end', () => cleanup(tmpDir));
    stream.on('error', () => cleanup(tmpDir));

  } else {
    const outputPath = path.join(tmpDir, 'output.mp4');
    const args = ['--no-playlist', '-q', ...durationFilter, '-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best', '--merge-output-format', 'mp4', '-o', outputPath, url];
    await runYtDlp(args);

    let finalFile = outputPath;
    if (!fs.existsSync(finalFile)) {
      const files = fs.readdirSync(tmpDir);
      const mp4File = files.find(f => f.endsWith('.mp4'));
      if (mp4File) finalFile = path.join(tmpDir, mp4File);
      else throw new Error('Video download failed');
    }

    const stat = fs.statSync(finalFile);
    res.setHeader('Cache-Control', 'no-store');
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
  const durationFilter = ['--match-filter', `duration < ${MAX_DURATION_SECONDS}`];

  for (const client of YT_CLIENTS) {
    try {
      console.log(`Trying client: ${client}`);
      const clientArgs = ['--extractor-args', `youtube:player_client=${client}`, '--no-playlist', '-q', ...durationFilter];

      if (format === 'mp3') {
        const outputTemplate = path.join(tmpDir, 'output.%(ext)s');
        const args = [...clientArgs, '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outputTemplate, url];
        await runYtDlp(args);

        const files = fs.readdirSync(tmpDir);
        const mp3File = files.find(f => f.endsWith('.mp3'));
        if (!mp3File) throw new Error('MP3 conversion failed');

        const filePath = path.join(tmpDir, mp3File);
        res.setHeader('Cache-Control', 'no-store');
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
        res.setHeader('Cache-Control', 'no-store');
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

// Periodic sweep: removes any leftover temp folders older than 10 minutes
// (safety net in case a crash/error skips the normal cleanup() call)
setInterval(() => {
  const tmpBase = os.tmpdir();
  fs.readdir(tmpBase, (err, files) => {
    if (err) return;
    files.filter(f => f.startsWith('ytdl-') || f.startsWith('ytsub-')).forEach(f => {
      const fullPath = path.join(tmpBase, f);
      fs.stat(fullPath, (err, stats) => {
        if (err) return;
        const ageMinutes = (Date.now() - stats.mtimeMs) / 60000;
        if (ageMinutes > 10) fs.rm(fullPath, { recursive: true, force: true }, () => {});
      });
    });
  });
}, 5 * 60 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
