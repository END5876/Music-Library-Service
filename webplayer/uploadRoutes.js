'use strict';
// webplayer/uploadRoutes.js
// 僅供已登入網頁使用的手動音檔上傳。入口及 API 都必須帶 ?upload=1，
// 並將檔案統一壓縮成 MP3，接著沿用 musicNormalizer 的雙通道 loudnorm。

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const normalizer = require('../ytdlp/musicNormalizer');

const OUTPUT_EXTENSION = '.mp3';
const UPLOAD_FLAG = 'upload';
const UPLOAD_VALUE = '1';

function isUploadEnabled(req) {
  return req.query && req.query[UPLOAD_FLAG] === UPLOAD_VALUE;
}

function decodeUploadHeader(value) {
  try { return decodeURIComponent(String(value || '')); } catch { throw new Error('上傳欄位編碼不合法'); }
}

function sanitizeFilename(value) {
  const base = path.basename(decodeUploadHeader(value)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').trim();
  const stem = base.replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim();
  if (!stem) throw new Error('請提供有效的檔案名稱');
  return stem.slice(0, 180);
}

function sanitizeFolder(value) {
  const raw = decodeUploadHeader(value).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return ''; 
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f<>:"\\|?*]/.test(part))) {
    throw new Error('資料夾名稱不合法');
  }
  return parts.map((part) => part.trim().replace(/\s+/g, ' ').slice(0, 80)).join('/');
}

function audioExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(ext) ? ext : '';
}

function transcodeToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-nostats', '-y',
      '-i', inputPath,
      '-map', '0:a:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-q:a', '2',
      outputPath,
    ]);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    ff.on('error', (err) => reject(new Error('無法啟動音訊轉檔：' + err.message)));
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`音訊壓縮失敗 (code ${code})：${stderr.slice(-500)}`));
    });
  });
}

function mountUploadRoutes(app, { store, requireWebAuth }) {
  app.get('/upload', (req, res, next) => {
    if (!isUploadEnabled(req)) return next();
    return requireWebAuth(req, res, () => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(path.join(__dirname, '..', 'public', 'upload.html'));
    });
  });

  app.post('/web/api/upload', (req, res, next) => {
    if (!isUploadEnabled(req)) return next();
    return requireWebAuth(req, res, async () => {
      const originalName = decodeUploadHeader(req.get('x-upload-filename'));
      const originalExtension = audioExtension(originalName);
      let finalRelPath;
      let tempInputPath;
      let tempOutputPath;

      try {
        if (!originalExtension) throw new Error('只允許上傳 MP3、WAV、OGG、FLAC、M4A 或 AAC 音檔');
        const title = sanitizeFilename(req.get('x-upload-title') || originalName);
        const folder = sanitizeFolder(req.get('x-upload-folder'));
        finalRelPath = folder ? `${folder}/${title}${OUTPUT_EXTENSION}` : `${title}${OUTPUT_EXTENSION}`;

        const staged = await store.writeTempFileFromStream(finalRelPath, req, originalExtension);
        tempInputPath = staged.tmpPath;
        tempOutputPath = `${staged.absPath}.transcode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp${OUTPUT_EXTENSION}`;

        await transcodeToMp3(tempInputPath, tempOutputPath);
        await normalizer.normalizeAudioFile(tempOutputPath);
        fs.renameSync(tempOutputPath, staged.absPath);
        fs.unlinkSync(tempInputPath);
        store.invalidateList();

        console.log(`✅ [MusicLibrary] 已上傳、壓縮與正規化: ${finalRelPath}`);
        return res.status(201).json({ ok: true, filename: finalRelPath });
      } catch (err) {
        for (const filePath of [tempInputPath, tempOutputPath]) {
          if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
        }
        console.error('❌ [MusicLibrary] 網頁上傳失敗:', err.message);
        if (!res.headersSent) return res.status(400).json({ error: err.message || '上傳失敗' });
      }
    });
  });
}

module.exports = { mountUploadRoutes, isUploadEnabled };