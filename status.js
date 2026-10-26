'use strict';
// status.js
// 服務狀態彙整：GET /api/music/status（內部金鑰）與 GET /web/api/status（網頁登入）共用。
// 「為什麼不能播」不必再翻 log：快取用量、進行中的串流／背景下載、近一小時串流失敗、
// yt-dlp 版本與自動更新結果、PO Token 模式都在這裡。

const store = require('./musicStore');
const online = require('./ytdlp/onlineStream');
const { hub: botHub } = require('./botSync');

const startedAt = Date.now();

async function collect() {
  const mem = process.memoryUsage();
  let library;
  try { library = await store.summary(); } catch (err) { library = { error: err.message }; }
  // 剩餘空間：Volume 快滿時下載、上傳、播放清單存檔都會失敗（ENOSPC 回 507）
  const disk = await store.diskHealth();
  return {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    memory: { rssMB: Math.round(mem.rss / 1048576), heapUsedMB: Math.round(mem.heapUsed / 1048576) },
    library,
    disk: { freeMB: disk.freeMB, volume: disk.volume },
    online: online.getStats(),
    bots: botHub.snapshot().map((b) => ({ id: b.id, name: b.name, online: b.online, guilds: b.guilds.length })),
  };
}

module.exports = { collect };
