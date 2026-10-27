'use strict';
// webplayer/libraryManageRoutes.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的音樂庫管理：移動／重新命名／刪除（只限管理員：音樂庫是所有人與 Bot 共用的，見 webPlayer.js）。
// 最主要的用途是「收藏」：根目錄第一層的歌是快取，會被容量清理刪掉；移進子資料夾後就會長期保留。
//
//   POST   /web/api/library/move       { from, to }  to 為新的相對路徑（可省略副檔名，沿用原本的）
//                                       → { ok, from, to, playlists }；playlists = 跟著改路徑的播放清單數
//   DELETE /web/api/library/file/*     刪除檔案 → { ok, filename }
//
// 錯誤：400 路徑不合法、404 找不到、409 目標已存在。

const express = require('express');
const pl = require('./playlistStore');

function mountLibraryManageRoutes(app, { store, requireWebAuth }) {
  const json = express.json({ limit: '4kb' });

  const fail = (res, err, what) => {
    if (err && err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(`❌ [MusicLibrary] ${what}失敗:`, err);
    res.status(500).json({ error: `${what}失敗` });
  };

  app.post('/web/api/library/move', requireWebAuth, json, async (req, res) => {
    const b = req.body || {};
    if (typeof b.from !== 'string' || typeof b.to !== 'string' || !b.to.trim()) {
      return res.status(400).json({ error: '缺少 from / to' });
    }
    try {
      const { from, to } = await store.moveFile(b.from, b.to);
      let playlists = 0;
      try { playlists = pl.renameLibFile(from, to); } catch (err) {
        console.error('❌ [Playlists] 更新播放清單路徑失敗:', err.message);
      }
      res.json({ ok: true, from, to, playlists });
    } catch (err) {
      fail(res, err, '移動檔案');
    }
  });

  app.delete('/web/api/library/file/*', requireWebAuth, async (req, res) => {
    try {
      const { filename } = await store.deleteFile(req.params[0]);
      res.json({ ok: true, filename });
    } catch (err) {
      fail(res, err, '刪除檔案');
    }
  });
}

module.exports = { mountLibraryManageRoutes };
