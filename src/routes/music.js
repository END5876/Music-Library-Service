'use strict';
// routes/music.js — 給各個 Bot 呼叫的內部 API：/api/music/*（金鑰驗證在掛載處）
const store = require('../services/musicStore');

function mountMusicRoutes(app) {
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

module.exports = { mountMusicRoutes };
