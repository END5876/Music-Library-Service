'use strict';
// webplayer/playlistRoutes.js
// 播放清單 API，全部走網頁播放器的登入驗證。每個 Discord 帳號各自一份：擁有者一律取自登入 Cookie
// （requireWebAuth 設定的 req.webUser.id），請求內容裡的任何 id 都不能拿來存取別人的清單。
// 只帶內部金鑰（沒有 Discord 帳號）的呼叫端回 403。
//
//   GET    /web/api/playlists                       自己的全部播放清單
//   POST   /web/api/playlists                       { name, items? } 建立
//   PATCH  /web/api/playlists/:id                   { name } 重新命名
//   DELETE /web/api/playlists/:id                   刪除
//   POST   /web/api/playlists/:id/items             { items:[...] } 加入歌曲（重複的會略過）
//   DELETE /web/api/playlists/:id/items/:itemId     移除歌曲
//   POST   /web/api/playlists/:id/items/remove      { ids:[itemId...] } 一次移除多首
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

  const owner = (req) => (req.webUser && req.webUser.id) || '';

  // 修改次數上限（每個帳號每分鐘 WRITES_PER_MINUTE 次）：每次修改都會整份重寫播放清單檔，不能讓一個人一直灌
  const WRITES_PER_MINUTE = 120;
  const writes = new Map(); // uid → { count, resetAt }
  setInterval(() => {
    const t = Date.now();
    for (const [k, w] of writes) if (w.resetAt <= t) writes.delete(k);
  }, 60 * 1000).unref();
  app.use(BASE, (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    // 驗證要在這之前：沒登入的請求不計次數（交給後面的 requireWebAuth 回 401）
    requireWebAuth(req, res, () => {
      const uid = owner(req);
      if (!uid) return next();
      const t = Date.now();
      let w = writes.get(uid);
      if (!w || w.resetAt <= t) { w = { count: 0, resetAt: t + 60 * 1000 }; writes.set(uid, w); }
      if (++w.count > WRITES_PER_MINUTE) {
        res.set('Retry-After', String(Math.ceil((w.resetAt - t) / 1000)));
        return res.status(429).json({ error: '播放清單修改太頻繁，請稍後再試' });
      }
      next();
    });
  });

  app.get(BASE, requireWebAuth, handle((req) => ({ playlists: pl.list(owner(req)) })));

  app.post(BASE, requireWebAuth, json, handle(async (req) => {
    const b = req.body || {};
    return { playlist: await pl.create(owner(req), b.name, b.items, deps) };
  }));

  app.patch(`${BASE}/:id`, requireWebAuth, json, handle((req) => ({
    playlist: pl.rename(owner(req), req.params.id, (req.body || {}).name),
  })));

  app.delete(`${BASE}/:id`, requireWebAuth, handle((req) => {
    pl.remove(owner(req), req.params.id);
    return { ok: true };
  }));

  app.post(`${BASE}/:id/items`, requireWebAuth, json, handle((req) =>
    pl.addItems(owner(req), req.params.id, (req.body || {}).items, deps)));

  app.post(`${BASE}/:id/items/remove`, requireWebAuth, json, handle((req) =>
    pl.removeItems(owner(req), req.params.id, (req.body || {}).ids)));

  app.delete(`${BASE}/:id/items/:itemId`, requireWebAuth, handle((req) => ({
    playlist: pl.removeItem(owner(req), req.params.id, req.params.itemId),
  })));

  app.put(`${BASE}/:id/order`, requireWebAuth, json, handle((req) => ({
    playlist: pl.reorder(owner(req), req.params.id, (req.body || {}).order),
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
