// ytdlp/potProvider.js
// 職責：YouTube PO Token 自動產生器（bgutil-ytdlp-pot-provider）的啟動與設定
//
// 運作方式：
//   - yt-dlp 裝了 bgutil plugin 後，需要 PO Token 時會自動向 bgutil HTTP server 要（預設 http://127.0.0.1:4416），
//     不必再手動填會過期的 YOUTUBE_PO_TOKEN
//   - Docker 映像把 server 裝在 /opt/bgutil/server、plugin 放在 /etc/yt-dlp/plugins/；
//     這裡負責把 server 當子行程啟動
//   - 按需啟動：server 常駐要 100～200 MB 記憶體，所以不在服務啟動時就開，而是第一次要跑 YouTube 的 yt-dlp
//     之前（ensureReady）才啟動、等它能連線；閒置超過 POT_IDLE_MINUTES 就關掉，下次需要時再開。
//     掛掉時不立刻重啟，等下一次 ensureReady 再開（連續掛掉時以指數退避拉長間隔，期間 yt-dlp 不帶 PO Token 照跑）。
//
// 環境變數：
//   POT_PROVIDER=0       關閉（不啟動本機 server、不加任何參數）
//   POT_PROVIDER_URL     改用外部的 bgutil server（例如另開的 Docker 服務），設了就不啟動本機 server
//   BGUTIL_SERVER_DIR    本機 server 所在資料夾，預設 /opt/bgutil/server
//   POT_IDLE_MINUTES     本機 server 閒置多久後關閉，預設 15

const fs        = require('fs');
const net       = require('net');
const path      = require('path');
const { spawn } = require('child_process');
const logger    = require('../logger');

const DISABLED     = process.env.POT_PROVIDER === '0';
const EXTERNAL_URL = (process.env.POT_PROVIDER_URL || '').trim().replace(/\/+$/, '') || null;
const SERVER_DIR   = process.env.BGUTIL_SERVER_DIR || '/opt/bgutil/server';
const SERVER_MAIN  = path.join(SERVER_DIR, 'build', 'main.js');
const LOCAL_PORT   = 4416; // plugin 預設連的埠，用預設值就不必另外傳 base_url

const IDLE_MS              = (parseFloat(process.env.POT_IDLE_MINUTES) > 0 ? parseFloat(process.env.POT_IDLE_MINUTES) : 15) * 60_000;
const READY_TIMEOUT_MS     = 15_000; // 等 server 開始監聽的上限；逾時就讓 yt-dlp 不帶 PO Token 先跑
const READY_POLL_MS        = 250;
const RESTART_DELAY_MIN_MS = 5_000;
const RESTART_DELAY_MAX_MS = 60_000;
const STABLE_RUN_MS        = 60_000; // 跑超過這麼久才掛掉，視為偶發，退避時間歸零

let proc         = null;
let mode         = 'off';   // 'off' | 'local' | 'external'
let stopping     = false;   // 行程結束中：不再啟動
let ready        = null;    // Promise：目前這個 server 行程可連線（或等待逾時）
let lastUsed     = 0;
let idleTimer    = null;
let nextSpawnAt  = 0;       // 異常結束後的退避：這個時間之前不重新啟動
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

function _canConnect() {
  return new Promise((resolve) => {
    const sock = net.connect(LOCAL_PORT, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

async function _waitListening(child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (proc === child && Date.now() < deadline) {
    if (await _canConnect()) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  if (proc === child) logger.warn('POT', `bgutil server ${READY_TIMEOUT_MS / 1000}s 內沒有開始監聽，這次 yt-dlp 不帶 PO Token`);
  return false;
}

function _spawnLocal() {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [SERVER_MAIN, '--port', String(LOCAL_PORT)], {
    cwd: SERVER_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc = child;
  child.idleStop = false;
  _pipeLines(child.stdout, logger.debug);
  _pipeLines(child.stderr, logger.warn);

  child.on('error', (err) => logger.error('POT', `bgutil server 啟動失敗: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (proc === child) { proc = null; ready = null; }
    if (stopping || child.idleStop) return;
    if (Date.now() - startedAt > STABLE_RUN_MS) restartDelay = RESTART_DELAY_MIN_MS;
    nextSpawnAt = Date.now() + restartDelay;
    logger.warn('POT', `bgutil server 結束（code=${code}, signal=${signal}），下次需要時再啟動（最快 ${restartDelay / 1000}s 後）`);
    restartDelay = Math.min(restartDelay * 2, RESTART_DELAY_MAX_MS);
  });

  logger.debug('POT', `已啟動本機 bgutil server（127.0.0.1:${LOCAL_PORT}）`);
  ready = _waitListening(child);
}

function _scheduleIdleCheck() {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!proc) return;
    if (Date.now() - lastUsed >= IDLE_MS) {
      logger.debug('POT', `bgutil server 閒置超過 ${IDLE_MS / 60_000} 分鐘，關閉以釋放記憶體`);
      proc.idleStop = true;
      try { proc.kill(); } catch {}
      proc = null;
      ready = null;
      return;
    }
    _scheduleIdleCheck();
  }, Math.max(100, lastUsed + IDLE_MS - Date.now()));
  idleTimer.unref();
}

// 由 onlineStream.init() 呼叫一次：只決定模式，本機 server 等到真的需要時才啟動
function start() {
  if (mode !== 'off' || DISABLED) return mode;
  if (EXTERNAL_URL) {
    mode = 'external';
    logger.debug('POT', `使用外部 bgutil server: ${EXTERNAL_URL}`);
  } else if (fs.existsSync(SERVER_MAIN)) {
    mode = 'local';
    logger.debug('POT', `本機 bgutil server 已就緒，第一次需要 YouTube PO Token 時才啟動（閒置 ${IDLE_MS / 60_000} 分鐘後關閉）`);
  } else {
    logger.debug('POT', `找不到 ${SERVER_MAIN}，不啟用 PO Token 自動產生器`);
  }
  return mode;
}

// 每次要跑 YouTube 的 yt-dlp（getInfo / 串流 / 下載）之前呼叫：確保本機 server 在跑並可連線。
// 不會 reject；server 起不來時直接 resolve，讓 yt-dlp 不帶 PO Token 照跑（與沒有 bgutil 時相同）。
function ensureReady() {
  if (mode !== 'local' || stopping) return Promise.resolve();
  lastUsed = Date.now();
  _scheduleIdleCheck();
  if (!proc) {
    if (Date.now() < nextSpawnAt) return Promise.resolve();
    _spawnLocal();
  }
  return ready ? ready.then(() => {}, () => {}) : Promise.resolve();
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

module.exports = {
  start, ensureReady, extractorArgs, getMode,
  // 測試用
  _pid: () => (proc ? proc.pid : null),
  LOCAL_PORT,
};
