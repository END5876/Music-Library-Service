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
//   GET  /api/music/list                           列出整個音樂庫
//   GET  /api/music/exists?filename=                檢查指定 filename 是否已存在
//   GET  /api/music/file/*                          下載檔案內容
//   PUT  /api/music/file/*                          上傳／覆寫檔案內容（原始位元組）

function createLibraryKeyMiddleware(secret) {
  return function libraryKeyMiddleware(req, res, next) {
    if (!secret) return next(); // 未設定金鑰時不驗證（僅建議在完全信任的內網環境這樣用）
    const provided = req.get('x-music-lib-key');
    if (provided !== secret) {
      return res.status(401).json({ error: '缺少或錯誤的音樂庫金鑰' });
    }
    next();
  };
}

function mountLibraryRoutes(app, { store, secret }) {
  app.use('/api/music', createLibraryKeyMiddleware(secret));

  // ── 清單 ──────────────────────────────────────────────────
  app.get('/api/music/list', async (req, res) => {
    try {
      const files = await store.listAll();
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
      res.sendFile(absPath, (err) => {
        if (err && !res.headersSent) {
          console.error('❌ [MusicLibrary] 下載檔案失敗:', err.message);
          res.status(500).json({ error: '下載檔案失敗' });
        }
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 上傳（原始位元組 body，不用 body-parser，直接串流寫檔）────
  app.put('/api/music/file/*', (req, res) => {
    store.writeFileFromStream(req.params[0], req)
      .then(({ relPath }) => res.json({ ok: true, filename: relPath }))
      .catch((err) => {
        console.error('❌ [MusicLibrary] 寫入檔案失敗:', err.message);
        if (!res.headersSent) res.status(400).json({ error: err.message });
      });
  });
}

module.exports = { mountLibraryRoutes };
