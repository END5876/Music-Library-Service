// ytdlp/potProvider.js
// 職責：YouTube PO Token 自動產生器（bgutil-ytdlp-pot-provider）的啟動與設定
//
// 運作方式：
//   - yt-dlp 裝了 bgutil plugin 後，需要 PO Token 時會自動向 bgutil HTTP server 要（預設 http://127.0.0.1:4416），
//     不必再手動填會過期的 YOUTUBE_PO_TOKEN
//   - Docker 映像把 server 裝在 /opt/bgutil/server、plugin 放在 /etc/yt-dlp/plugins/；
//     這裡負責把 server 當子行程啟動，掛掉時自動重啟（指數退避）
//
// 環境變數：
//   POT_PROVIDER=0       關閉（不啟動本機 server、不加任何參數）
//   POT_PROVIDER_URL     改用外部的 bgutil server（例如另開的 Docker 服務），設了就不啟動本機 server
//   BGUTIL_SERVER_DIR    本機 server 所在資料夾，預設 /opt/bgutil/server

const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');
const logger    = require('../logger');

const DISABLED     = process.env.POT_PROVIDER === '0';
const EXTERNAL_URL = (process.env.POT_PROVIDER_URL || '').trim().replace(/\/+$/, '') || null;
const SERVER_DIR   = process.env.BGUTIL_SERVER_DIR || '/opt/bgutil/server';
const SERVER_MAIN  = path.join(SERVER_DIR, 'build', 'main.js');
const LOCAL_PORT   = 4416; // plugin 預設連的埠，用預設值就不必另外傳 base_url

const RESTART_DELAY_MIN_MS = 5_000;
const RESTART_DELAY_MAX_MS = 60_000;
const STABLE_RUN_MS        = 60_000; // 跑超過這麼久才掛掉，視為偶發，退避時間歸零

let proc         = null;
let mode         = 'off';   // 'off' | 'local' | 'external'
let stopping     = false;
let restartDelay = RESTART_DELAY_MIN_MS;

function _pipeLines(stream, log) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) log('POT', line.trim());
  });
}

function _spawnLocal() {
  const startedAt = Date.now();
  proc = spawn(process.execPath, [SERVER_MAIN, '--port', String(LOCAL_PORT)], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _pipeLines(proc.stdout, logger.debug);
  _pipeLines(proc.stderr, logger.warn);

  proc.on('error', (err) => logger.error('POT', `bgutil server 啟動失敗: ${err.message}`));
  proc.on('exit', (code, signal) => {
    proc = null;
    if (stopping) return;
    if (Date.now() - startedAt > STABLE_RUN_MS) restartDelay = RESTART_DELAY_MIN_MS;
    logger.warn('POT', `bgutil server 結束（code=${code}, signal=${signal}），${restartDelay / 1000}s 後重啟`);
    setTimeout(() => { if (!stopping) _spawnLocal(); }, restartDelay).unref();
    restartDelay = Math.min(restartDelay * 2, RESTART_DELAY_MAX_MS);
  });
}

// 由 onlineStream.init() 呼叫一次
function start() {
  if (mode !== 'off' || DISABLED) return mode;
  if (EXTERNAL_URL) {
    mode = 'external';
    logger.debug('POT', `使用外部 bgutil server: ${EXTERNAL_URL}`);
  } else if (fs.existsSync(SERVER_MAIN)) {
    mode = 'local';
    _spawnLocal();
    logger.debug('POT', `已啟動本機 bgutil server（127.0.0.1:${LOCAL_PORT}）`);
  } else {
    logger.debug('POT', `找不到 ${SERVER_MAIN}，不啟用 PO Token 自動產生器`);
  }
  return mode;
}

// 附加到 YouTube yt-dlp 呼叫的參數；本機 server 用 plugin 預設位址，不需要額外參數
function extractorArgs() {
  if (mode !== 'external') return [];
  return ['--extractor-args', `youtubepot-bgutilhttp:base_url=${EXTERNAL_URL}`];
}

function getMode() { return mode; }

process.on('exit', () => {
  stopping = true;
  try { if (proc && !proc.killed) proc.kill(); } catch {}
});

module.exports = { start, extractorArgs, getMode };
