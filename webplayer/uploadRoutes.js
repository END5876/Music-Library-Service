'use strict';
// webplayer/uploadRoutes.js
// 僅供已登入網頁使用的手動音檔上傳。入口及 API 都必須帶 ?upload=1，
// 並沿用 musicNormalizer 的雙通道 loudnorm，在套用正規化的同一次統一編碼成 MP3。

const fs = require('fs');
const path = require('path');
const normalizer = require('../ytdlp/musicNormalizer');
const { SUPPORTED_EXTENSIONS } = require('../musicStore');

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
  return SUPPORTED_EXTENSIONS.includes(ext) ? ext : '';
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
      let finalRelPath;
      let tempInputPath;
      let tempOutputPath;

      // 解碼也要在 try 裡：這是 async 函式，丟出去的例外會變成沒人處理的 rejection，讓整個服務行程結束
      try {
        const originalName = decodeUploadHeader(req.get('x-upload-filename'));
        const originalExtension = audioExtension(originalName);
        if (!originalExtension) throw new Error('只允許上傳 MP3、WAV、OGG、FLAC、M4A 或 AAC 音檔');
        const title = sanitizeFilename(req.get('x-upload-title') || originalName);
        const folder = sanitizeFolder(req.get('x-upload-folder'));
        finalRelPath = folder ? `${folder}/${title}${OUTPUT_EXTENSION}` : `${title}${OUTPUT_EXTENSION}`;

        // 同名檔案已存在就先擋下，不必等整個檔案傳完、轉檔完才失敗（發布時還會再原子檢查一次）
        if ((await store.exists(finalRelPath)).exists) {
          req.resume();
          throw Object.assign(new Error('音樂庫已有同名檔案，請換一個標題或資料夾'), { status: 409 });
        }

        const staged = await store.writeTempFileFromStream(finalRelPath, req, originalExtension);
        tempInputPath = staged.tmpPath;
        tempOutputPath = `${staged.absPath}.transcode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp${OUTPUT_EXTENSION}`;

        await normalizer.normalizeToMp3(tempInputPath, tempOutputPath);
        try {
          store.publishFile(tempOutputPath, staged, { overwrite: false });
        } catch (err) {
          if (err.status === 409) err.message = '音樂庫已有同名檔案，請換一個標題或資料夾';
          throw err;
        }
        tempOutputPath = null;
        try { fs.unlinkSync(tempInputPath); } catch {}

        console.log(`✅ [MusicLibrary] 已上傳、壓縮與正規化: ${finalRelPath}`);
        return res.status(201).json({ ok: true, filename: finalRelPath });
      } catch (err) {
        for (const filePath of [tempInputPath, tempOutputPath]) {
          if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
        }
        console.error('❌ [MusicLibrary] 網頁上傳失敗:', err.message);
        const status = err.status >= 400 && err.status < 500 ? err.status : 400;
        if (!res.headersSent) return res.status(status).json({ error: err.message || '上傳失敗' });
      }
    });
  });
}

module.exports = { mountUploadRoutes, isUploadEnabled };