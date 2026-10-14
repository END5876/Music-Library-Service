'use strict';
// server.js
// ─────────────────────────────────────────────────────────────
// 共用音樂庫服務（Music Library Service）
//
// 獨立部署、獨立維護的服務，不含任何 Discord 邏輯，只做一件事：
// 掛著唯一一顆「音樂庫 Volume」，透過內部 HTTP API 讓多個 Bot（不同
// repo、不同服務）都能讀取／寫入同一份音樂庫。
//
// 環境變數：
//   PORT               監聽埠，會自動注入
//   MUSIC_DIR          音樂庫掛載路徑，預設 <repo root>/data/music
//   MUSIC_LIB_SECRET   保護 API 的共用金鑰，呼叫端要帶相同的值
//   MAX_CACHE_SIZE_MB  cache/ 子資料夾的容量上限，預設 2048
//   WEB_PLAYER_PASSWORD  網頁播放器登入密碼（不設定＝不啟用網頁播放器）
//   ALLOW_INSECURE_LIBRARY_API  設 1 才允許「啟用網頁播放器卻沒設 MUSIC_LIB_SECRET」時開放 /api/music/*
//   LOG_TIMESTAMPS     設 0 關閉 log 前面的時間（部署平台已經會加時間時）
//
// API：
//   GET  /health                                   健康檢查（不驗證金鑰）
//   GET  /api/music/list                           列出整個音樂庫（filename / name / size）
//   GET  /api/music/exists?filename=                檢查指定 filename 是否已存在
//   GET  /api/music/file/*                          下載檔案內容（* 是相對於音樂庫根目錄的路徑）
//   PUT  /api/music/file/*                          上傳／覆寫檔案內容（原始位元組，不做任何解析）
//   GET  /api/music/status                          服務狀態（快取用量、串流、yt-dlp 版本…，見 status.js）
//   PUT  /api/music/bots/:botId/state 等             Bot ↔ 網頁「正在播放」同步（見 botSync/routes.js）
//
// 網頁播放器（設定 WEB_PLAYER_PASSWORD 才啟用）：路由完整清單見 README，
// 各組路由的實作分在 webplayer/ 底下（入口是 webplayer/webPlayer.js）。
//
// 這個服務刻意不提供播放次數功能：每個呼叫端 Bot 各自計算、各自
// 記錄自己的播放次數，不透過這裡同步或集中管理。
//
// filename 的路徑分隔一律使用 '/'。

require('dotenv').config();
const logger = require('./logger');
logger.installConsoleTimestamps();
const express = require('express');
const store = require('./musicStore');
const status = require('./status');
const { mountLibraryRoutes, isInsecureLocked } = require('./libraryRoutes');
const { mountWebPlayer } = require('./webplayer/webPlayer');
const botSync = require('./botSync');

const PORT = process.env.PORT || 4100;
const SECRET = process.env.MUSIC_LIB_SECRET || '';

const app = express();
app.disable('x-powered-by');
app.use(logger.requestId());

// 基本安全標頭（播放器為純自家資源：腳本／樣式／音訊都來自同源或 blob:）
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
      "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  next();
});

// 健康檢查放在金鑰驗證之前 —— 部署平台的健康檢查探針不會帶金鑰，
// 這條路由本身也不洩漏任何音樂庫內容。
app.get('/health', (req, res) => res.json({ ok: true }));

// Bot 用的內部 API（/api/music/*，需帶 x-music-lib-key）
mountLibraryRoutes(app, { store, secret: SECRET, status });
// Bot 推送「正在播放」、拿網頁送來的控制指令（/api/music/bots/*，同樣受上面的金鑰保護）
botSync.mountBotApi(app, { hub: botSync.hub });

// 網頁播放器：走自己的 Cookie 驗證，不影響上面 Bot 用的 /api/music/*
const webPlayerEnabled = mountWebPlayer(app, { store, libSecret: SECRET, status, botHub: botSync.hub });

// 統一錯誤處理：不把堆疊或 HTML 錯誤頁回給客戶端
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = err && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600
    ? (err.status || err.statusCode) : 500;
  if (code >= 500) console.error(`❌ [Server] 未處理的錯誤（${req.id}）:`, err);
  res.status(code).json({ error: code >= 500 ? '伺服器錯誤' : '請求不合法' });
});

store.cleanupStaleTemps().catch(() => {});

app.listen(PORT, () => {
  console.log(`✅ [MusicLibrary] 共用音樂庫服務已啟動，監聽埠 ${PORT}（音樂庫路徑: ${store.MUSIC_DIR}）`);
  if (isInsecureLocked({ secret: SECRET })) {
    console.error('🔒 [MusicLibrary] 網頁播放器已啟用（服務有公開網域）但沒有設定 MUSIC_LIB_SECRET：/api/music/* 已停用（回 503）。'
      + '請設定 MUSIC_LIB_SECRET；確定要在沒有金鑰的情況下開放，才設 ALLOW_INSECURE_LIBRARY_API=1');
  } else if (!SECRET) {
    console.warn('⚠️ [MusicLibrary] 尚未設定 MUSIC_LIB_SECRET，任何連得到這個服務的請求都能讀寫音樂庫，僅建議在完全信任的內網環境這樣使用');
  }
  if (webPlayerEnabled) console.log('🎧 [MusicLibrary] 網頁播放器已啟用: /player');
});

// 部署平台重新部署會送 SIGTERM：立即結束，由各模組的 'exit' 處理器砍掉殘留的 yt-dlp / ffmpeg 子行程。
// 刻意不等進行中的請求：播放清單是同步寫檔、上傳是暫存檔＋rename，中斷不會留下半成品（暫存檔下次啟動清除）。
function shutdown(signal) {
  console.log(`🛑 [MusicLibrary] 收到 ${signal}，關閉服務`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
