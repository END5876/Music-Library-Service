'use strict';
// ytdlp/ytdlpUpdater.js
// yt-dlp 自動更新：YouTube 常在幾週內就讓舊版 yt-dlp 失效，映像只在建置時抓一次 yt-dlp，
// 服務沒重建就會整個不能播。這裡在啟動後 1 分鐘跑一次 `yt-dlp -U`，之後每 YTDLP_UPDATE_HOURS 小時再跑一次。
//
// 環境變數：
//   YTDLP_AUTO_UPDATE   1＝開、0＝關；未設定時只在 NODE_ENV=production（Docker 映像）開啟，
//                       避免本機開發時改到開發者自己電腦上的 yt-dlp
//   YTDLP_UPDATE_HOURS  檢查間隔，預設 24
//
// 正在進行的 yt-dlp 不受影響：-U 是寫新檔再取代，已經在跑的行程用的是舊檔。
// 以 pip / 套件管理器安裝的 yt-dlp 不支援 -U，會記一次警告後停止嘗試。

const { execFile } = require('child_process');
const logger = require('../logger');

const YTDLP_PATH = 'yt-dlp';
const FIRST_DELAY_MS = 60 * 1000;
const UPDATE_TIMEOUT_MS = 2 * 60 * 1000;

const state = {
  enabled: false,
  version: null,
  lastCheckAt: null,
  lastResult: null,   // 'updated' | 'up-to-date' | 'unsupported' | 'error'
  lastError: null,
};
let timers = [];
let running = null;
let run = (args, timeout) => new Promise((resolve, reject) => {
  execFile(YTDLP_PATH, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
    const out = `${stdout || ''}\n${stderr || ''}`.trim();
    if (err) { err.output = out; return reject(err); }
    resolve(out);
  });
});

function isEnabled(env = process.env) {
  if (env.YTDLP_AUTO_UPDATE === '1') return true;
  if (env.YTDLP_AUTO_UPDATE === '0') return false;
  return env.NODE_ENV === 'production';
}

async function refreshVersion() {
  try { state.version = (await run(['--version'], 15000)).split('\n')[0].trim() || null; } catch {}
  return state.version;
}

// 依 yt-dlp -U 的輸出分類（各版本措辭略有不同，只抓關鍵字）
function classify(output) {
  const o = String(output || '');
  if (/Updated yt-dlp to|Updating to/i.test(o)) return 'updated';
  if (/up to date/i.test(o)) return 'up-to-date';
  if (/pip|package manager|not supported|cannot be updated|use that to update/i.test(o)) return 'unsupported';
  return 'error';
}

function checkNow() {
  if (running) return running;
  running = (async () => {
    const before = state.version;
    let output = '';
    try {
      output = await run(['-U'], UPDATE_TIMEOUT_MS);
      state.lastResult = classify(output);
    } catch (err) {
      output = err.output || err.message;
      const c = classify(output);
      state.lastResult = c === 'unsupported' ? c : 'error';
    }
    state.lastCheckAt = new Date().toISOString();
    state.lastError = state.lastResult === 'error' ? output.slice(-300) : null;
    await refreshVersion();

    if (state.lastResult === 'updated') {
      logger.info('yt-dlp', `已自動更新：${before || '?'} → ${state.version || '?'}`);
    } else if (state.lastResult === 'up-to-date') {
      logger.debug('yt-dlp', `已是最新版（${state.version}）`);
    } else if (state.lastResult === 'unsupported') {
      logger.warn('yt-dlp', '這個安裝方式不支援 yt-dlp -U（例如 pip），停用自動更新，請改用安裝方式本身更新');
      stop();
    } else {
      logger.warn('yt-dlp', `自動更新失敗（下次排程會再試）：${state.lastError}`);
    }
    return state.lastResult;
  })().finally(() => { running = null; });
  return running;
}

function start({ env = process.env } = {}) {
  state.enabled = isEnabled(env);
  refreshVersion();
  if (!state.enabled || timers.length) return;
  const hours = Math.max(1, parseFloat(env.YTDLP_UPDATE_HOURS || '24') || 24);
  const first = setTimeout(checkNow, FIRST_DELAY_MS);
  const every = setInterval(checkNow, hours * 3600 * 1000);
  first.unref(); every.unref();
  timers = [first, every];
  logger.info('yt-dlp', `自動更新已啟用：啟動 1 分鐘後檢查一次，之後每 ${hours} 小時檢查`);
}

function stop() {
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  timers = [];
}

function getStatus() { return { ...state }; }

module.exports = {
  start, stop, checkNow, refreshVersion, getStatus, isEnabled, classify,
  // 測試用
  _setRun(fn) { run = fn; },
};
