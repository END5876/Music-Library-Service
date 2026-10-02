// core/debug.js — 除錯開關（localStorage.ml_debug=1）與 dbg()

// 除錯:在 DevTools 執行 localStorage.ml_debug='1' 後重新整理即可開啟
let DEBUG = false;

try { DEBUG = localStorage.getItem('ml_debug') === '1'; } catch {}

const t0 = Date.now();

export const dbg = (...a) => { if (DEBUG) console.log('[player +' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...a); };
