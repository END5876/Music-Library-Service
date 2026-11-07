'use strict';
// webplayer/libraryManageRoutes.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的音樂庫管理：移動／重新命名／刪除（只限管理員：音樂庫是所有人與 Bot 共用的，見 webPlayer.js）。
// 最主要的用途是「收藏」：根目錄第一層的歌是快取，會被容量清理刪掉；移進子資料夾後就會長期保留。
//
//   POST   /web/api/library/move       { from, to }  to 為新的相對路徑（可省略副檔名，沿用原本的）
//                                       → { ok, from, to, playlists }；playlists = 跟著改路徑的播放清單數
//   DELETE /web/api/library/file/*     刪除檔案 → { ok, filename }
//   POST   /web/api/library/delete     { files:[...] } 多選刪除（最多 500 首）→ { ok, deleted, failed }
//   POST   /web/api/library/move-batch { moves:[{ from, to }] } 多選移動（例如設為私人；最多 500 首）→ { ok, moved, failed }
//
// 錯誤：400 路徑不合法、404 找不到、409 目標已存在。

const express = require('express');
const pl = require('./playlistStore');

function mountLibraryManageRoutes(app, { store, requireWebAuth, privateScope = () => ({}) }) {
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
      res.json({ ok: true, ...await moveOne(req, b.from, b.to) });
    } catch (err) {
      fail(res, err, '移動檔案');
    }
  });

  // 移動一首並更新播放清單路徑。
  // 搬進私人資料夾：只改自己的播放清單（別人的清單不能指向私人路徑，那些項目會顯示為找不到）
  async function moveOne(req, rawFrom, rawTo) {
    const { from, to } = await store.moveFile(rawFrom, rawTo, privateScope(req));
    let playlists = 0;
    const intoPrivate = store.isPrivatePath(to) && !store.isPrivatePath(from);
    try { playlists = pl.renameLibFile(from, to, intoPrivate ? { onlyOwner: req.webUser.id } : {}); } catch (err) {
      console.error('❌ [Playlists] 更新播放清單路徑失敗:', err.message);
    }
    return { from, to, playlists };
  }

  // 多選移動（例如一次設為私人）：{ moves:[{ from, to }] }（最多 MAX_BATCH 首）
  //   → { ok, moved:[{ from, to }], failed:[{ from, error }] }；一首失敗不影響其他首
  const MAX_BATCH = 500;
  app.post('/web/api/library/move-batch', requireWebAuth, express.json({ limit: '512kb' }), async (req, res) => {
    const moves = (req.body || {}).moves;
    if (!Array.isArray(moves) || !moves.length
      || moves.some((m) => !m || typeof m.from !== 'string' || typeof m.to !== 'string' || !m.to.trim())) {
      return res.status(400).json({ error: '缺少 moves' });
    }
    if (moves.length > MAX_BATCH) return res.status(400).json({ error: `一次最多 ${MAX_BATCH} 首` });
    const moved = [], failed = [];
    for (const m of moves) {
      try {
        const { from, to } = await moveOne(req, m.from, m.to);
        moved.push({ from, to });
      } catch (err) {
        if (!(err && err.status >= 400 && err.status < 500)) console.error('❌ [MusicLibrary] 批次移動失敗:', err);
        failed.push({ from: m.from, error: err && err.status < 500 ? err.message : '移動失敗' });
      }
    }
    res.json({ ok: failed.length === 0, moved, failed });
  });

  // 多選刪除：{ files:[filename...] }（最多 MAX_BATCH 首）→ { ok, deleted:[...], failed:[{ filename, error }] }
  // 一首失敗不影響其他首；私人歌曲只能刪自己的（privateScope）
  app.post('/web/api/library/delete', requireWebAuth, express.json({ limit: '256kb' }), async (req, res) => {
    const files = (req.body || {}).files;
    if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string')) {
      return res.status(400).json({ error: '缺少 files' });
    }
    if (files.length > MAX_BATCH) return res.status(400).json({ error: `一次最多刪除 ${MAX_BATCH} 首` });
    const deleted = [], failed = [];
    for (const f of [...new Set(files)]) {
      try {
        deleted.push((await store.deleteFile(f, privateScope(req))).filename);
      } catch (err) {
        if (!(err && err.status >= 400 && err.status < 500)) console.error('❌ [MusicLibrary] 批次刪除失敗:', err);
        failed.push({ filename: f, error: err && err.status < 500 ? err.message : '刪除失敗' });
      }
    }
    res.json({ ok: failed.length === 0, deleted, failed });
  });

  app.delete('/web/api/library/file/*', requireWebAuth, async (req, res) => {
    try {
      const { filename } = await store.deleteFile(req.params[0], privateScope(req));
      res.json({ ok: true, filename });
    } catch (err) {
      fail(res, err, '刪除檔案');
    }
  });
}

module.exports = { mountLibraryManageRoutes };
