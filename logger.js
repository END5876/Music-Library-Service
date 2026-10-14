'use strict';
// 精簡版 logger：介面對齊 Mousebot 的 utils/logger（debug / info / warn / error，第一個參數是模組標籤），
// 讓從 Bot 移植過來的 ytdlp/* 模組不必修改呼叫方式。
// debug 預設關閉，設定 LOG_DEBUG=1 才會輸出。
//
// 另外提供：
//   installConsoleTimestamps()  在所有 console 輸出前加上 ISO 時間（LOG_TIMESTAMPS=0 可關閉，
//                               例如部署平台本身已經會加時間時）
//   requestId()                 Express middleware：每個請求一個短 id（回應標頭 X-Request-Id），
//                               5xx 與慢請求會記一行存取 log，方便對照使用者回報與錯誤
const crypto = require('crypto');

const DEBUG = process.env.LOG_DEBUG === '1';
const logger = {
  debug: (tag, msg) => { if (DEBUG) console.log(`[${tag}] ${msg}`); },
  info:  (tag, msg) => console.log(`[${tag}] ${msg}`),
  warn:  (tag, msg) => console.warn(`[${tag}] ${msg}`),
  error: (tag, msg) => console.error(`[${tag}] ${msg}`),
};

let installed = false;
function installConsoleTimestamps(env = process.env) {
  if (installed || env.LOG_TIMESTAMPS === '0') return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(new Date().toISOString(), ...args);
  }
}

// 長時間傳輸是正常的路徑（音檔、串流），不算慢請求
// （Bot 的長輪詢與網頁的 SSE 本來就會掛著；送指令給 Bot 要等 Bot 回報結果）
const LONG_RUNNING = /^\/(web\/stream|web\/play|api\/music\/file|web\/api\/upload|api\/music\/bots\/[^/]+\/commands$|web\/api\/bots\/)/;
const SLOW_MS = 3000;

function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : crypto.randomBytes(4).toString('hex');
    res.set('X-Request-Id', req.id);
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const p = req.path;
      const slow = ms > SLOW_MS && !LONG_RUNNING.test(p);
      if (res.statusCode >= 500 || slow || DEBUG) {
        const line = `[HTTP] ${req.id} ${req.method} ${p} ${res.statusCode} ${ms}ms${slow ? '（慢）' : ''}`;
        (res.statusCode >= 500 ? console.error : slow ? console.warn : console.log)(line);
      }
    });
    next();
  };
}

module.exports = { ...logger, installConsoleTimestamps, requestId };
