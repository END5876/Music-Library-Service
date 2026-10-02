'use strict';
// 精簡版 logger：介面對齊 Mousebot 的 utils/logger（debug / info / warn / error，第一個參數是模組標籤），
// 讓從 Bot 移植過來的 ytdlp/* 模組不必修改呼叫方式。
// debug 預設關閉，設定 LOG_DEBUG=1 才會輸出。
const DEBUG = process.env.LOG_DEBUG === '1';
module.exports = {
  debug: (tag, msg) => { if (DEBUG) console.log(`[${tag}] ${msg}`); },
  info:  (tag, msg) => console.log(`[${tag}] ${msg}`),
  warn:  (tag, msg) => console.warn(`[${tag}] ${msg}`),
  error: (tag, msg) => console.error(`[${tag}] ${msg}`),
};
