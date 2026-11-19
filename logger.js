'use strict';
// 精簡版 logger：介面對齊 Mousebot 的 utils/logger（debug / info / warn / error，第一個參數是模組標籤），
// 讓從 Bot 移植過來的 ytdlp/* 模組不必修改呼叫方式。
// debug 預設關閉，設定 LOG_DEBUG=1 才會輸出。
//
// 另外提供：
//   installConsoleTimestamps()  在所有 console 輸出前加上「2026-11-20 14:03:05」格式的時間（時區用 TZ，
//                               沒設定就用 Asia/Taipei；LOG_TIMESTAMPS=0 可關閉，
//                               例如部署平台本身已經會加時間時），並把字串參數裡的控制字元換成看得見的形式
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

// 🔒 [日誌注入] 使用者能控制的字串（歌名、網址、檔名）會被寫進 log：換行可以偽造一整行看起來
// 正常的紀錄，ESC 序列可以在終端機裡清除或改寫前面的輸出。把控制字元（Tab 以外的 C0、DEL、C1）
// 換成 \n、\x1b 這種看得見的形式。Error 物件不處理（堆疊本來就是多行），只處理字串參數。
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
const ESCAPES = { '\n': '\\n', '\r': '\\r' };
function escapeControlChars(s) {
  return String(s).replace(CONTROL_CHARS, (c) => ESCAPES[c] || `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
const cleanArg = (a) => (typeof a === 'string' ? escapeControlChars(a) : a);

function makeStampFormat(tz) {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || 'Asia/Taipei' });
  } catch {
    return new Intl.DateTimeFormat('en-US', opts); // TZ 寫錯就退回系統時區
  }
}

/** 「YYYY-MM-DD HH:mm:ss」（和 Mousebot 的 logger 同格式） */
function formatStamp(date = new Date(), fmt = makeStampFormat(process.env.TZ)) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

let installed = false;
function installConsoleTimestamps(env = process.env) {
  if (installed) return;
  installed = true;
  // LOG_TIMESTAMPS=0 只關掉時間，控制字元照樣處理
  const stamp = env.LOG_TIMESTAMPS !== '0';
  const fmt = makeStampFormat(env.TZ);
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = stamp
      ? (...args) => orig(formatStamp(new Date(), fmt), ...args.map(cleanArg))
      : (...args) => orig(...args.map(cleanArg));
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

module.exports = { ...logger, installConsoleTimestamps, formatStamp, requestId, escapeControlChars, CONTROL_CHARS };
