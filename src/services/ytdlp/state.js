'use strict';
// ytdlp/state.js — 線上串流模組共用的可變狀態（集中放這裡，各檔以 state.xxx 讀寫，避免跨檔案的 let 重新賦值問題）
module.exports = {
  errorCount: 0,                  // 對應 Bot 的 errorCounts.get(guildId)
  downloadingUrls: new Set(),     // 下載鎖（防止同一 URL 同時下載兩次）
  activeCtxs: new Set(),          // 目前連線中的串流請求
  activeQueries: 0,               // 目前進行中的搜尋／getInfo 數
  infoCache: new Map(),           // url -> { info, ts }
  available: false,               // yt-dlp 與 ffmpeg 是否可用
  initPromise: null,
};
