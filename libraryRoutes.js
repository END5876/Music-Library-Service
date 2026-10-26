'use strict';
// libraryRoutes.js
// ─────────────────────────────────────────────────────────────
// 提供給各個 Bot 使用的音樂庫內部 API（/api/music/*）與其金鑰驗證。
//
// 這個服務預期只透過Private Networking（同一個 Project 內的
// xxx.internal）被各個 Bot 服務呼叫，本來就不會曝露在公網上，
// 但仍建議設定 MUSIC_LIB_SECRET，避免同專案內其他服務、或設定失誤時
// 被誤用。（原 auth.js 的內容，只被這裡使用，所以併入此檔）
//
//   GET  /api/music/list                           列出整個音樂庫（支援 ETag / If-None-Match → 304）
//   GET  /api/music/exists?filename=                檢查指定 filename 是否已存在
//   GET  /api/music/file/*                          下載檔案內容
//   PUT  /api/music/file/*                          上傳檔案內容（原始位元組）；已有同名檔案回 409，
//                                                   確定要取代時帶 ?overwrite=1
//   GET  /api/music/status                          服務狀態（見 status.js）

const crypto = require('crypto');

// 固定長度雜湊後再 timingSafeEqual，避免用回應時間逐字猜金鑰
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const keyEquals = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// 🔒 沒有設定 MUSIC_LIB_SECRET 時預設鎖住 /api/music/*（回 503），不論有沒有啟用網頁播放器；
// 只有明確設定 ALLOW_INSECURE_LIBRARY_API=1（完全信任的內網）才在沒有金鑰的情況下開放。
// 以前「沒金鑰、沒播放器」視為純內網而直接開放：服務一旦被誤設成對外連得到，
// 任何人都能讀取整個音樂庫、以同名上傳蓋掉 Bot 會播放的歌、上傳大檔塞滿 Volume。
function isInsecureLocked({ secret, env = process.env }) {
  return !secret && env.ALLOW_INSECURE_LIBRARY_API !== '1';
}

function createLibraryKeyMiddleware(secret, { locked = false } = {}) {
  return function libraryKeyMiddleware(req, res, next) {
    if (locked) {
      return res.status(503).json({ error: '未設定 MUSIC_LIB_SECRET，內部 API 已停用' });
    }
    if (!secret) return next(); // ALLOW_INSECURE_LIBRARY_API=1：未設定金鑰時不驗證（僅限完全信任的內網環境）
    const provided = req.get('x-music-lib-key');
    if (!provided || !keyEquals(provided, secret)) {
      return res.status(401).json({ error: '缺少或錯誤的音樂庫金鑰' });
    }
    next();
  };
}

function mountLibraryRoutes(app, { store, secret, status }) {
  const locked = isInsecureLocked({ secret });
  app.use('/api/music', createLibraryKeyMiddleware(secret, { locked }));

  // ── 服務狀態（快取用量、串流／下載數、yt-dlp 版本…，見 status.js）──
  if (status) {
    app.get('/api/music/status', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await status.collect());
    });
  }

  // ── 清單 ──────────────────────────────────────────────────
  // 帶 If-None-Match 且清單沒變 → 304（Bot 定期輪詢時大多只拿到空回應）
  app.get('/api/music/list', async (req, res) => {
    try {
      const files = await store.listAll();
      const etag = store.listEtag(files);
      res.set('ETag', etag);
      const inm = req.get('if-none-match');
      if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) return res.status(304).end();
      res.json({ files });
    } catch (err) {
      console.error('❌ [MusicLibrary] /list 失敗:', err);
      res.status(500).json({ error: '讀取音樂庫清單失敗' });
    }
  });

  // ── 存在檢查 ──────────────────────────────────────────────
  app.get('/api/music/exists', async (req, res) => {
    try {
      const info = await store.exists(req.query.filename);
      res.json(info);
    } catch (err) {
      res.status(400).json({ exists: false, error: err.message });
    }
  });

  // ── 下載 ──────────────────────────────────────────────────
  app.get('/api/music/file/*', (req, res) => {
    try {
      const absPath = store.resolveForRead(req.params[0]);
      if (!absPath) return res.status(404).json({ error: '找不到檔案' });
      store.touchCache(absPath); // Bot 拿快取檔去播＝使用中，延後被快取清理
      // 路徑已由 resolveForRead 驗證；dotfiles: 'allow' 讓以 . 開頭的檔名（例如標題本身以 . 開頭）也能下載，不會只回 404
      res.sendFile(absPath, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) {
          if (store.isNotFoundError(err)) return res.status(404).json({ error: '找不到檔案' });
          console.error('❌ [MusicLibrary] 下載檔案失敗:', err.message);
          res.status(500).json({ error: '下載檔案失敗' });
        }
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 上傳（原始位元組 body，不用 body-parser，直接串流寫檔）────
  // 🔒 預設不覆寫：同名檔案已存在就回 409（快取檔名由影片 ID 決定，同一首歌本來就不必重傳）。
  // 以前一律覆寫，算錯快取檔名的上傳就能把別首歌整個換掉；確定要取代時帶 ?overwrite=1。
  app.put('/api/music/file/*', (req, res) => {
    const overwrite = req.query.overwrite === '1';
    store.writeFileFromStream(req.params[0], req, { overwrite })
      .then(({ relPath }) => res.json({ ok: true, filename: relPath }))
      .catch((err) => {
        console.error('❌ [MusicLibrary] 寫入檔案失敗:', err.message);
        if (!res.headersSent) res.status(store.writeErrorStatus(err)).json({ error: err.message });
      });
  });
}

module.exports = { mountLibraryRoutes, isInsecureLocked };
