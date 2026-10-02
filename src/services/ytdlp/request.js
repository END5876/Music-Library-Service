'use strict';
// ytdlp/request.js — HTTP 入口：GET /web/play?url=...
const antiBot = require('./antiBot');
const state = require('./state');
const { getInfoCached } = require('./info');
const { playStream } = require('./stream');
const { cleanupProcess } = require('./process');
const { cleanUrl, isAllowedUrl } = require('../../utils/urlUtils');
const { MAX_WEB_STREAMS, WEB_KEY } = require('./constants');

async function handlePlayRequest(req, res, rawUrl) {
  if (!state.available) return res.status(503).json({ error: '伺服器未安裝 yt-dlp / ffmpeg，無法線上串流' });

  const url = cleanUrl(String(rawUrl || ''));
  if (!isAllowedUrl(url)) return res.status(400).json({ error: '只支援 YouTube / Bilibili 網址' });

  if (state.activeCtxs.size >= MAX_WEB_STREAMS) {
    return res.status(503).json({ error: '目前串流人數已滿，請稍後再試' });
  }

  let item;
  try {
    item = await getInfoCached(url);
  } catch (err) {
    return res.status(502).json({ error: `無法獲取影片資訊：${err.message}` });
  }
  if (res.destroyed || req.aborted) return;

  const ctx = { req, res, item, procs: null, closed: false, started: false };
  state.activeCtxs.add(ctx);

  res.on('close', () => {
    if (ctx.closed) return;
    ctx.closed = true;
    state.activeCtxs.delete(ctx);
    cleanupProcess(ctx);
    // 對應 Bot 的 stopAll → resetYtClient：沒有任何串流了，client 輪換狀態重置
    if (state.activeCtxs.size === 0) antiBot.resetYtClient(WEB_KEY);
  });

  await playStream(ctx, 0);
}

// ── 防殭屍進程保護（同 Bot）──
process.on('exit', () => {
  for (const ctx of state.activeCtxs) {
    const p = ctx.procs;
    if (!p) continue;
    for (const proc of [p.ytdlp, p.ffmpeg]) {
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {}
    }
  }
});

module.exports = { handlePlayRequest };
