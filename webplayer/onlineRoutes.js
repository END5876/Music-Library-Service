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
//
// 任何 Discord 帳號都能登入，所以一般帳號（非管理員、非內部金鑰）另外受限：
//   - 背景下載快取只替管理員做：快取存在共用音樂庫根目錄、會擠掉別人的快取歌曲；一般帳號只串流（快取命中照樣播檔案）
//   - 同時線上串流 WEB_MAX_STREAMS_PER_USER（預設 2，播放器會預載下一首），不能一個人佔光全站名額
//   - 搜尋／取得影片資訊每分鐘 WEB_QUERIES_PER_MINUTE 次（預設 30；每次搜尋會跑 2 個 yt-dlp）

const online = require('../ytdlp/onlineStream');

const MAX_STREAMS_PER_USER = Math.max(1, parseInt(process.env.WEB_MAX_STREAMS_PER_USER || '2', 10) || 2);
const QUERIES_PER_MINUTE = Math.max(1, parseInt(process.env.WEB_QUERIES_PER_MINUTE || '30', 10) || 30);

function mountOnlineRoutes(app, { requireWebAuth }) {
  const ONLINE_ENABLED = process.env.WEB_ONLINE !== '0';
  if (ONLINE_ENABLED) online.init().catch((err) => console.error('❌ [OnlineMusic] 初始化失敗:', err));

  const limited = (req) => !(req.webUser && req.webUser.admin);

  // 一般帳號的搜尋／影片資訊次數（每個 Discord 帳號、每分鐘）
  const queries = new Map(); // uid → { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [k, q] of queries) if (q.resetAt <= now) queries.delete(k);
  }, 60 * 1000).unref();
  function queryLimit(req, res, next) {
    if (!limited(req)) return next();
    const now = Date.now();
    let q = queries.get(req.webUser.id);
    if (!q || q.resetAt <= now) { q = { count: 0, resetAt: now + 60 * 1000 }; queries.set(req.webUser.id, q); }
    if (++q.count > QUERIES_PER_MINUTE) {
      res.set('Retry-After', String(Math.ceil((q.resetAt - now) / 1000)));
      return res.status(429).json({ error: '搜尋太頻繁，請稍後再試' });
    }
    next();
  }

  // ── 線上串流（YouTube / Bilibili，yt-dlp）─────────────────
  app.get('/web/api/capabilities', requireWebAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ online: ONLINE_ENABLED && online.isAvailable() });
  });

  function requireOnline(req, res, next) {
    if (ONLINE_ENABLED && online.isAvailable()) return next();
    res.status(503).json({ error: '伺服器未安裝 yt-dlp / ffmpeg，無法線上串流' });
  }

  app.get('/web/api/search', requireWebAuth, requireOnline, queryLimit, async (req, res) => {
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

  app.get('/web/api/info', requireWebAuth, requireOnline, queryLimit, async (req, res) => {
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
    const opts = limited(req)
      ? { cache: false, userKey: req.webUser.id, maxPerUser: MAX_STREAMS_PER_USER }
      : { cache: true };
    online.handlePlayRequest(req, res, req.query.url, opts).catch((err) => {
      console.error('❌ [OnlineMusic] /web/play 失敗:', err);
      if (!res.headersSent) res.status(500).json({ error: '串流失敗' });
      else res.end();
    });
  });
}

module.exports = { mountOnlineRoutes };
