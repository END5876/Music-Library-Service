'use strict';
// webplayer/uploadRoutes.js
// 網頁播放器的音檔上傳（只限管理員，見 webPlayer.js；上傳面板在播放器裡，見 public/playerUpload.js）。
//
//   GET  /upload                    舊網址：導到 /player?panel=upload
//   GET  /web/api/upload/usage      用量：公開音樂庫、快取、自己的私人空間、磁碟剩餘、各項上限
//   POST /web/api/upload/preflight  { target, mode, files:[{ name, size }] } 批量上傳前的預估與檢查
//   GET  /web/api/upload/jobs       自己的上傳工作（排隊中／處理中／完成／失敗，保留 24 小時；存檔，服務重啟後接續處理）
//   POST /web/api/upload/jobs/clear 清掉自己已完成／失敗的紀錄
//   POST /web/api/upload            原檔寫進暫存後立刻回 202 { job }，由背景佇列一次一首處理。原始位元組 body，欄位放 header（URL 編碼）：
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

// 上傳工作紀錄存檔位置（跟播放清單同一個資料夾；Docker 內為 /app/data，要掛 Volume 才能跨部署保留）
const DEFAULT_JOBS_FILE = process.env.UPLOAD_JOBS_FILE || path.join(__dirname, '..', 'data', 'upload-jobs.json');

function mountUploadRoutes(app, { store, requireWebAuth, requireWebPage = requireWebAuth, jobsFile = DEFAULT_JOBS_FILE }) {
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
      // 整批會先全部傳上來排隊：原檔＋處理後的檔案同時佔空間；還在排隊的工作也算進去
      const rawTotal = items.reduce((sum, it, i) => sum + (it.ok ? Math.max(0, Number(files[i].size) || 0) : 0), 0);
      const pending = pendingJobs();
      const pendingOut = pending.reduce((sum, j) => sum + j.estimate, 0);
      if (u.disk.freeBytes != null && u.disk.freeBytes - rawTotal - estimated - pendingOut < u.disk.minFreeBytes) {
        ok = false;
        warnings.push(`磁碟剩餘 ${fmtMB(u.disk.freeBytes)}，整批上傳（原檔＋處理後）會低於保留水位 ${fmtMB(u.disk.minFreeBytes)}`);
      }
      const pendingPrivate = target === 'private'
        ? pending.filter((j) => j.target === 'private' && j.uid === uidOf(req)).reduce((sum, j) => sum + j.estimate, 0) : 0;
      if (target === 'private' && u.private.quotaBytes > 0 && u.private.bytes + pendingPrivate + estimated > u.private.quotaBytes) {
        ok = false;
        warnings.push(`私人空間已用 ${fmtMB(u.private.bytes)} / ${fmtMB(u.private.quotaBytes)}，整批預估再用 ${fmtMB(estimated)}，會超過配額`);
      }
      if (pending.length) warnings.push(`伺服器目前還有 ${pending.length} 首在排隊處理，新上傳的會排在後面`);
      res.json({ ok, estimatedBytes: estimated, items, warnings, usage: u });
    } catch (err) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 400;
      res.status(status).json({ error: err.message || '預檢失敗' });
    }
  });

  // ── 背景處理佇列 ───────────────────────────────────────────
  // 上傳只負責把原檔寫進暫存檔就回 202；轉檔／調音量／發布交給這條佇列，一次一首（VPS CPU 不多，慢慢做）。
  // 工作紀錄寫進 jobsFile：關掉網頁、服務重啟（例如部署）後都還查得到進度；
  // 重啟時還沒處理完的工作，暫存原檔還在就重新排隊（原檔受 store.protectTemp 保護，啟動清理不會刪），不在就標成失敗。
  const jobs = new Map();       // id → job
  const waiting = [];           // 排隊中的 job id
  let working = false;
  let jobSeq = 0;
  const JOB_KEEP_MS = 24 * 60 * 60 * 1000; // 完成／失敗的工作保留 24 小時給前端查
  const MAX_JOBS_PER_USER = 500;

  // ── 存檔（寫入合併成 300ms 一次；先寫暫存檔再 rename，寫到一半當機也不會壞掉）──
  let saveTimer = null;
  function saveJobs() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(jobsFile), { recursive: true });
        const tmp = `${jobsFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, jobs: [...jobs.values()] }));
        fs.renameSync(tmp, jobsFile);
      } catch (err) {
        console.error('❌ [MusicLibrary] 上傳工作紀錄存檔失敗:', err.message);
      }
    }, 300);
    saveTimer.unref();
  }
  function loadJobs() {
    let data;
    try { data = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); } catch (err) {
      if (err.code !== 'ENOENT') console.error('⚠️ [MusicLibrary] 上傳工作紀錄讀取失敗，從空的開始:', err.message);
      return;
    }
    const cutoff = Date.now() - JOB_KEEP_MS;
    const list = (Array.isArray(data && data.jobs) ? data.jobs : [])
      .filter((j) => j && typeof j.id === 'string' && j.staged && typeof j.staged.tmpPath === 'string')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let resumed = 0, lost = 0;
    for (const j of list) {
      if (j.finishedAt && j.finishedAt < cutoff) continue;
      if (j.status === 'queued' || j.status === 'processing') {
        if (fs.existsSync(j.staged.tmpPath)) {
          j.status = 'queued';
          waiting.push(j.id);
          store.protectTemp(j.staged.tmpPath);
          resumed += 1;
        } else {
          j.status = 'error';
          j.error = '服務重新啟動時暫存檔已遺失，請重新上傳';
          j.finishedAt = Date.now();
          lost += 1;
        }
      }
      jobs.set(j.id, j);
    }
    if (resumed || lost) console.log(`📤 [MusicLibrary] 上傳佇列：接續 ${resumed} 首${lost ? `，${lost} 首暫存檔已遺失` : ''}`);
    if (lost) saveJobs();
  }

  const ownerKey = (req) => (req.webUser && req.webUser.id) || 'key';
  const pendingJobs = () => [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'processing');
  const publicJob = (j) => ({
    id: j.id, name: j.name, title: j.title, filename: j.filename, target: j.target, mode: j.mode,
    status: j.status, error: j.error, result: j.result, inputBytes: j.inputBytes,
    position: j.status === 'queued' ? waiting.indexOf(j.id) + 1 : 0,
    createdAt: j.createdAt, finishedAt: j.finishedAt,
  });

  const pruneTimer = setInterval(() => {
    const cutoff = Date.now() - JOB_KEEP_MS;
    let n = 0;
    for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) { jobs.delete(id); n += 1; }
    if (n) saveJobs();
  }, 10 * 60 * 1000);
  pruneTimer.unref();

  async function runJob(j) {
    let tempOutputPath = `${j.staged.absPath}.transcode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp${j.outExt}`;
    // 處理中的輸出檔也要保護：「保留原檔」用 copyFile，Windows 上會沿用原檔的修改時間，
    // 服務重啟後接續舊工作時，會被同時進行的啟動清理當成殘留暫存檔刪掉
    const outPath = tempOutputPath;
    store.protectTemp(outPath);
    try {
      const result = await normalizer.processUpload(j.staged.tmpPath, tempOutputPath, { mode: j.mode });
      // 處理後的實際大小再對一次私人配額（估算可能偏小）
      if (j.target === 'private') {
        const outSize = fs.statSync(tempOutputPath).size;
        const now = await store.usage(j.uid);
        if (now.private.quotaBytes > 0 && now.private.bytes + outSize > now.private.quotaBytes) {
          throw new StoreError(507, `私人空間不足（已用 ${fmtMB(now.private.bytes)} / ${fmtMB(now.private.quotaBytes)}）`);
        }
      }
      try {
        store.publishFile(tempOutputPath, j.staged, { overwrite: false });
      } catch (err) {
        if (err.status === 409) err.message = '已有同名檔案，請換一個標題或資料夾';
        throw err;
      }
      tempOutputPath = null;
      j.status = 'done';
      j.result = result;
      console.log(`✅ [MusicLibrary] 已上傳（${j.target}／${result.method}）: ${j.filename}`);
    } catch (err) {
      j.status = 'error';
      j.error = err.code === 'ENOSPC' ? '磁碟空間不足' : (err.message || '處理失敗');
      console.error(`❌ [MusicLibrary] 上傳處理失敗 ${j.filename}:`, err.message);
    } finally {
      for (const fp of [j.staged.tmpPath, tempOutputPath]) {
        if (fp) { try { fs.unlinkSync(fp); } catch {} }
      }
      store.unprotectTemp(j.staged.tmpPath);
      store.unprotectTemp(outPath);
      j.finishedAt = Date.now();
      saveJobs();
    }
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (waiting.length) {
        const j = jobs.get(waiting.shift());
        if (!j || j.status !== 'queued') continue;
        j.status = 'processing';
        saveJobs();
        await runJob(j);
      }
    } finally { working = false; }
  }

  // 自己的上傳工作（最近 24 小時；重新整理頁面、關掉重開後前端用它接回進度）
  app.get('/web/api/upload/jobs', requireWebAuth, (req, res) => {
    const me = ownerKey(req);
    res.set('Cache-Control', 'no-store');
    res.json({ jobs: [...jobs.values()].filter((j) => j.owner === me).map(publicJob) });
  });

  // 清掉自己已完成／失敗的工作紀錄
  app.post('/web/api/upload/jobs/clear', requireWebAuth, (req, res) => {
    const me = ownerKey(req);
    for (const [id, j] of jobs) if (j.owner === me && j.finishedAt) jobs.delete(id);
    saveJobs();
    res.json({ ok: true });
  });

  app.post('/web/api/upload', requireWebAuth, async (req, res) => {
    let staged = null;

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
      const finalRelPath = [root, folder, `${title}${outExt}`].filter(Boolean).join('/');
      const scope = { uid };
      const owner = ownerKey(req);

      if ([...jobs.values()].filter((j) => j.owner === owner).length >= MAX_JOBS_PER_USER) {
        throw new StoreError(429, '上傳工作太多，請先清除已完成的紀錄');
      }
      // 同名檔案已存在、或同名的歌還在排隊處理：先擋下（發布時還會再原子檢查一次）
      const pending = pendingJobs();
      if ((await store.exists(finalRelPath, scope)).exists
        || pending.some((j) => j.filename.toLowerCase() === finalRelPath.toLowerCase())) {
        throw new StoreError(409, '已有同名檔案，請換一個標題或資料夾');
      }

      // 空間檢查（傳輸前）：這個原檔＋處理後的檔案，加上還在排隊的工作之後會寫出的檔案
      // （排隊中工作的原檔已經寫在磁碟上，剩餘空間已經扣掉了）
      const declared = Number(req.get('content-length')) || 0;
      const u = await store.usage(uid);
      const estimated = estimateOutputBytes(originalName, declared, mode);
      const pendingOut = pending.reduce((sum, j) => sum + j.estimate, 0);
      if (u.disk.freeBytes != null && u.disk.freeBytes - declared - estimated - pendingOut < u.disk.minFreeBytes) {
        throw new StoreError(507, `磁碟空間不足（剩 ${fmtMB(u.disk.freeBytes)}，需保留 ${fmtMB(u.disk.minFreeBytes)}）`);
      }
      if (target === 'private' && u.private.quotaBytes > 0) {
        const pendingPrivate = pending.filter((j) => j.target === 'private' && j.uid === uid).reduce((sum, j) => sum + j.estimate, 0);
        if (u.private.bytes + pendingPrivate + estimated > u.private.quotaBytes) {
          throw new StoreError(507, `私人空間不足（已用 ${fmtMB(u.private.bytes)}，排隊中約 ${fmtMB(pendingPrivate)}，上限 ${fmtMB(u.private.quotaBytes)}）`);
        }
      }

      staged = await store.writeTempFileFromStream(finalRelPath, req, originalExtension, scope);
      const inputBytes = fs.statSync(staged.tmpPath).size;
      const job = {
        id: `${Date.now().toString(36)}${(++jobSeq).toString(36)}`,
        owner, uid, name: originalName, title, filename: finalRelPath, target, mode, outExt, staged,
        inputBytes, estimate: estimateOutputBytes(originalName, inputBytes, mode),
        status: 'queued', error: null, result: null, createdAt: Date.now(), finishedAt: null,
      };
      store.protectTemp(staged.tmpPath);
      jobs.set(job.id, job);
      waiting.push(job.id);
      saveJobs();
      staged = null; // 之後由佇列負責清理
      pump();
      return res.status(202).json({ ok: true, job: publicJob(job) });
    } catch (err) {
      if (staged) { try { fs.unlinkSync(staged.tmpPath); } catch {} }
      else req.resume(); // 還沒讀 body（或讀到一半失敗）：排掉，避免連線卡住
      console.error('❌ [MusicLibrary] 網頁上傳失敗:', err.message);
      const status = err.code === 'ENOSPC' ? 507 : err.status >= 400 && err.status < 600 ? err.status : 400;
      if (!res.headersSent) return res.status(status).json({ error: err.message || '上傳失敗' });
    }
  });

  loadJobs();
  pump();

  // 測試用：等佇列清空
  return { idle: async () => { while (working || waiting.length) await new Promise((r) => setTimeout(r, 10)); } };
}

module.exports = { mountUploadRoutes, estimateOutputBytes, sanitizeFilename, sanitizeFolder };
