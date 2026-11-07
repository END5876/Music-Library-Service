'use strict';
// webplayer/uploadRoutes.js
// 網頁播放器的音檔上傳（只限管理員，見 webPlayer.js；上傳面板在播放器裡，見 public/playerUpload.js）。
//
//   GET  /upload                    舊網址：導到 /player?panel=upload
//   GET  /web/api/upload/usage      用量：公開音樂庫、快取、自己的私人空間、磁碟剩餘、各項上限
//   POST /web/api/upload/preflight  { target, mode, files:[{ name, size }] } 批量上傳前的預估與檢查
//   POST /web/api/upload            原始位元組 body，欄位放 header（URL 編碼）：
//        x-upload-filename  原始檔名（判斷格式）
//        x-upload-title     曲名（可省略，預設用原始檔名）
//        x-upload-folder    子資料夾（可省略）
//        x-upload-target    library（預設，放進共用音樂庫）| private（只有自己看得到：.private/<uid>/）
//        x-upload-mode      transcode（預設）| original（不轉檔、原檔照存；只限 private）
//
// 處理方式（見 ytdlp/musicNormalizer.js 的 processUpload）：
//   一般音檔 → MP3 q2 + 雙通道響度正規化；≤200kbps 的 MP3 → 不重新編碼，mp3gain 無損調音量；original → 原檔。
// 空間控管：磁碟剩餘低於 MIN_FREE_MB 一律拒絕；私人空間超過 PRIVATE_QUOTA_MB 拒絕（都回 507）。

const fs = require('fs');
const path = require('path');
const express = require('express');
const normalizer = require('../ytdlp/musicNormalizer');
const { SUPPORTED_EXTENSIONS, StoreError } = require('../musicStore');

const TARGETS = ['library', 'private'];
const MODES = ['transcode', 'original'];
const MAX_BATCH = 200;

function decodeUploadHeader(value) {
  try { return decodeURIComponent(String(value || '')); } catch { throw new StoreError(400, '上傳欄位編碼不合法'); }
}

// 🐛 [曲名被截斷] 這裡處理的是管理員輸入的曲名，不是路徑：以前先 path.basename 再刪掉最後一個「.」之後的字，
// 「Mr. Brightside」變成「Mr」、「AC/DC - X」變成「DC - X」。現在 / 和 \ 跟其他保留字元一樣換成空白，
// 只去掉已知的音檔副檔名（曲名沒填、改用原始檔名時才會有）
function sanitizeFilename(value) {
  const base = decodeUploadHeader(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').trim();
  const stem = (audioExtension(base) ? base.slice(0, -path.extname(base).length) : base).replace(/\s+/g, ' ').trim();
  if (!stem || /^\.+$/.test(stem)) throw new StoreError(400, '請提供有效的檔案名稱');
  return stem.slice(0, 180);
}

function sanitizeFolder(value) {
  const raw = decodeUploadHeader(value).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return '';
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f<>:"\\|?*]/.test(part))) {
    throw new StoreError(400, '資料夾名稱不合法');
  }
  return parts.map((part) => part.trim().replace(/\s+/g, ' ').slice(0, 80)).join('/');
}

function audioExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext) ? ext : '';
}

function pickOption(value, allowed, name) {
  const v = String(value || '').trim().toLowerCase() || allowed[0];
  if (!allowed.includes(v)) throw new StoreError(400, `${name} 不合法`);
  return v;
}

// 處理後大概多大（預檢、空間檢查用；寧可估大一點）
const RATIO = { '.mp3': 1, '.wav': 0.16, '.flac': 0.3, '.m4a': 0.85, '.aac': 0.85, '.ogg': 0.85 };
function estimateOutputBytes(name, size, mode) {
  const n = Math.max(0, Number(size) || 0);
  if (mode === 'original') return n;
  return Math.ceil(n * (RATIO[audioExtension(name)] || 1));
}

const fmtMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;

function mountUploadRoutes(app, { store, requireWebAuth, requireWebPage = requireWebAuth }) {
  const uidOf = (req) => (req.webUser && req.webUser.id) || null;

  // 舊的獨立上傳頁：面板已經搬進播放器
  app.get('/upload', requireWebPage, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.redirect(302, '/player?panel=upload');
  });

  app.get('/web/api/upload/usage', requireWebAuth, async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await store.usage(uidOf(req)));
    } catch (err) {
      console.error('❌ [MusicLibrary] 讀取用量失敗:', err);
      res.status(500).json({ error: '讀取用量失敗' });
    }
  });

  // 批量上傳前先整批估算：哪些格式不支援、哪些太大、整批會不會超過私人配額或磁碟水位
  app.post('/web/api/upload/preflight', requireWebAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const b = req.body || {};
      const target = pickOption(b.target, TARGETS, 'target');
      const mode = pickOption(b.mode, MODES, 'mode');
      if (mode === 'original' && target !== 'private') throw new StoreError(400, '只有私人上傳可以保留原檔');
      if (target === 'private') store.privatePrefix(uidOf(req));
      const files = Array.isArray(b.files) ? b.files.slice(0, MAX_BATCH) : [];
      const u = await store.usage(target === 'private' ? uidOf(req) : null);

      let estimated = 0;
      const items = files.map((f) => {
        const name = String((f && f.name) || '');
        const size = Math.max(0, Number(f && f.size) || 0);
        if (!audioExtension(name)) return { name, ok: false, error: '不支援的格式' };
        if (size > u.maxUploadBytes) return { name, ok: false, error: `超過單檔上限 ${fmtMB(u.maxUploadBytes)}` };
        const est = estimateOutputBytes(name, size, mode);
        estimated += est;
        return { name, ok: true, estimatedBytes: est };
      });

      const warnings = [];
      let ok = true;
      if (u.disk.freeBytes != null && u.disk.freeBytes - estimated < u.disk.minFreeBytes) {
        ok = false;
        warnings.push(`磁碟剩餘 ${fmtMB(u.disk.freeBytes)}，整批上傳後會低於保留水位 ${fmtMB(u.disk.minFreeBytes)}`);
      }
      if (target === 'private' && u.private.quotaBytes > 0 && u.private.bytes + estimated > u.private.quotaBytes) {
        ok = false;
        warnings.push(`私人空間已用 ${fmtMB(u.private.bytes)} / ${fmtMB(u.private.quotaBytes)}，整批預估再用 ${fmtMB(estimated)}，會超過配額`);
      }
      res.json({ ok, estimatedBytes: estimated, items, warnings, usage: u });
    } catch (err) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 400;
      res.status(status).json({ error: err.message || '預檢失敗' });
    }
  });

  app.post('/web/api/upload', requireWebAuth, async (req, res) => {
    let finalRelPath;
    let tempInputPath;
    let tempOutputPath;

    // 解碼也要在 try 裡：這是 async 函式，丟出去的例外會變成沒人處理的 rejection，讓整個服務行程結束
    try {
      const originalName = decodeUploadHeader(req.get('x-upload-filename'));
      const originalExtension = audioExtension(originalName);
      if (!originalExtension) throw new StoreError(400, '只允許上傳 MP3、WAV、OGG、FLAC、M4A 或 AAC 音檔');
      const target = pickOption(req.get('x-upload-target'), TARGETS, 'x-upload-target');
      const mode = pickOption(req.get('x-upload-mode'), MODES, 'x-upload-mode');
      if (mode === 'original' && target !== 'private') throw new StoreError(400, '只有私人上傳可以保留原檔');
      const title = sanitizeFilename(req.get('x-upload-title') || originalName);
      const folder = sanitizeFolder(req.get('x-upload-folder'));
      const uid = target === 'private' ? uidOf(req) : null;
      const root = target === 'private' ? store.privatePrefix(uid) : '';
      const outExt = mode === 'original' ? originalExtension : '.mp3';
      finalRelPath = [root, folder, `${title}${outExt}`].filter(Boolean).join('/');
      const scope = { uid };

      // 同名檔案已存在就先擋下，不必等整個檔案傳完、轉檔完才失敗（發布時還會再原子檢查一次）
      if ((await store.exists(finalRelPath, scope)).exists) {
        throw new StoreError(409, '已有同名檔案，請換一個標題或資料夾');
      }

      // 空間檢查（傳輸前）：原檔＋處理後的檔案都會暫時佔空間
      const declared = Number(req.get('content-length')) || 0;
      const u = await store.usage(uid);
      const estimated = estimateOutputBytes(originalName, declared, mode);
      if (u.disk.freeBytes != null && u.disk.freeBytes - declared - estimated < u.disk.minFreeBytes) {
        throw new StoreError(507, `磁碟空間不足（剩 ${fmtMB(u.disk.freeBytes)}，需保留 ${fmtMB(u.disk.minFreeBytes)}）`);
      }
      if (target === 'private' && u.private.quotaBytes > 0 && u.private.bytes + estimated > u.private.quotaBytes) {
        throw new StoreError(507, `私人空間不足（已用 ${fmtMB(u.private.bytes)} / ${fmtMB(u.private.quotaBytes)}）`);
      }

      const staged = await store.writeTempFileFromStream(finalRelPath, req, originalExtension, scope);
      tempInputPath = staged.tmpPath;
      tempOutputPath = `${staged.absPath}.transcode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp${outExt}`;

      const result = await normalizer.processUpload(tempInputPath, tempOutputPath, { mode });

      // 處理後的實際大小再對一次私人配額（估算可能偏小）
      if (target === 'private' && u.private.quotaBytes > 0) {
        const outSize = fs.statSync(tempOutputPath).size;
        const now = await store.usage(uid);
        if (now.private.bytes + outSize > now.private.quotaBytes) {
          throw new StoreError(507, `私人空間不足（已用 ${fmtMB(now.private.bytes)} / ${fmtMB(now.private.quotaBytes)}）`);
        }
      }

      try {
        store.publishFile(tempOutputPath, staged, { overwrite: false });
      } catch (err) {
        if (err.status === 409) err.message = '已有同名檔案，請換一個標題或資料夾';
        throw err;
      }
      tempOutputPath = null;
      try { fs.unlinkSync(tempInputPath); } catch {}

      console.log(`✅ [MusicLibrary] 已上傳（${target}／${result.method}）: ${finalRelPath}`);
      return res.status(201).json({ ok: true, filename: finalRelPath, target, ...result });
    } catch (err) {
      if (!tempInputPath) req.resume(); // 還沒開始讀 body：排掉，避免連線卡住
      for (const filePath of [tempInputPath, tempOutputPath]) {
        if (filePath) { try { fs.unlinkSync(filePath); } catch {} }
      }
      console.error('❌ [MusicLibrary] 網頁上傳失敗:', err.message);
      const status = err.code === 'ENOSPC' ? 507 : err.status >= 400 && err.status < 600 ? err.status : 400;
      if (!res.headersSent) return res.status(status).json({ error: err.message || '上傳失敗' });
    }
  });
}

module.exports = { mountUploadRoutes, estimateOutputBytes, sanitizeFilename, sanitizeFolder };
