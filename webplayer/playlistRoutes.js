'use strict';
// webplayer/playlistRoutes.js
// 播放清單 API，全部走網頁播放器的登入驗證（Cookie 或內部金鑰）。
//
//   GET    /web/api/playlists                       全部播放清單
//   POST   /web/api/playlists                       { name, items? } 建立
//   PATCH  /web/api/playlists/:id                   { name } 重新命名
//   DELETE /web/api/playlists/:id                   刪除
//   POST   /web/api/playlists/:id/items             { items:[...] } 加入歌曲（重複的會略過）
//   DELETE /web/api/playlists/:id/items/:itemId     移除歌曲
//   PUT    /web/api/playlists/:id/order             { order:[itemId...] } 重新排序

const express = require('express');
const pl = require('./playlistStore');

function mountPlaylists(app, { requireWebAuth, online }) {
  const deps = { isAllowedUrl: online.isAllowedUrl, cleanUrl: online.cleanUrl };
  const json = express.json({ limit: '512kb' });
  const BASE = '/web/api/playlists';

  const handle = (fn) => async (req, res) => {
    try {
      const body = await fn(req);
      res.set('Cache-Control', 'no-store');
      res.json(body);
    } catch (err) {
      if (err instanceof pl.HttpError) return res.status(err.status).json({ error: err.message });
      console.error('❌ [Playlists] 失敗:', err);
      res.status(500).json({ error: '播放清單操作失敗' });
    }
  };

  app.get(BASE, requireWebAuth, handle(() => ({ playlists: pl.list() })));

  app.post(BASE, requireWebAuth, json, handle(async (req) => {
    const b = req.body || {};
    return { playlist: await pl.create(b.name, b.items, deps) };
  }));

  app.patch(`${BASE}/:id`, requireWebAuth, json, handle((req) => ({
    playlist: pl.rename(req.params.id, (req.body || {}).name),
  })));

  app.delete(`${BASE}/:id`, requireWebAuth, handle((req) => {
    pl.remove(req.params.id);
    return { ok: true };
  }));

  app.post(`${BASE}/:id/items`, requireWebAuth, json, handle((req) =>
    pl.addItems(req.params.id, (req.body || {}).items, deps)));

  app.delete(`${BASE}/:id/items/:itemId`, requireWebAuth, handle((req) => ({
    playlist: pl.removeItem(req.params.id, req.params.itemId),
  })));

  app.put(`${BASE}/:id/order`, requireWebAuth, json, handle((req) => ({
    playlist: pl.reorder(req.params.id, (req.body || {}).order),
  })));

  // express.json 解析失敗（壞掉的 JSON、超過大小）時回 JSON 而不是 HTML 錯誤頁
  app.use(BASE, (err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(err.status || 400).json({ error: '請求內容不合法' });
    }
    next(err);
  });
}

module.exports = { mountPlaylists };
