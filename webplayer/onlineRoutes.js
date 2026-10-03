'use strict';
// webplayer/onlineRoutes.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的線上串流 API（YouTube / Bilibili，需要伺服器有 yt-dlp 與 ffmpeg；
// 沒有就自動停用，不影響音樂庫播放）。實際的串流／搜尋邏輯在 ../ytdlp/onlineStream.js。
//
//   GET  /web/api/capabilities   { online: true|false }
//   GET  /web/api/search?q=      同時搜尋 YouTube + Bilibili
//   GET  /web/api/info?url=      取得影片資訊（標題／時長）
//   GET  /web/play?url=          播放：快取命中→檔案（可拖曳）；否則 yt-dlp 即時串流＋背景下載快取
//   WEB_ONLINE=0 可強制關閉線上串流。

const online = require('../ytdlp/onlineStream');

function mountOnlineRoutes(app, { requireWebAuth }) {
  const ONLINE_ENABLED = process.env.WEB_ONLINE !== '0';
  if (ONLINE_ENABLED) online.init().catch((err) => console.error('❌ [OnlineMusic] 初始化失敗:', err));

  // ── 線上串流（YouTube / Bilibili，yt-dlp）─────────────────
  app.get('/web/api/capabilities', requireWebAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ online: ONLINE_ENABLED && online.isAvailable() });
  });

  function requireOnline(req, res, next) {
    if (ONLINE_ENABLED && online.isAvailable()) return next();
    res.status(503).json({ error: '伺服器未安裝 yt-dlp / ffmpeg，無法線上串流' });
  }

  app.get('/web/api/search', requireWebAuth, requireOnline, async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: '搜尋關鍵字不可為空' });
    try {
      const results = await online.searchMulti(q, 5);
      res.set('Cache-Control', 'no-store');
      res.json({ results });
    } catch (err) {
      res.status(503).json({ error: `搜尋失敗：${err.message}` });
    }
  });

  app.get('/web/api/info', requireWebAuth, requireOnline, async (req, res) => {
    const url = online.cleanUrl(String(req.query.url || ''));
    if (!online.isAllowedUrl(url)) return res.status(400).json({ error: '只支援 YouTube / Bilibili 網址' });
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await online.getInfo(url));
    } catch (err) {
      res.status(502).json({ error: `無法獲取影片資訊：${err.message}` });
    }
  });

  app.get('/web/play', requireWebAuth, requireOnline, (req, res) => {
    online.handlePlayRequest(req, res, req.query.url).catch((err) => {
      console.error('❌ [OnlineMusic] /web/play 失敗:', err);
      if (!res.headersSent) res.status(500).json({ error: '串流失敗' });
      else res.end();
    });
  });
}

module.exports = { mountOnlineRoutes };
