// ytdlp/onlineStream.js
// 移植自 Mousebot handlers/musicplayer/onlineMusicHandler.js
//
// 播放流程與 Bot 完全相同（playStream）：
//   1. 查快取（getCachedPath）→ 命中：直接播放快取檔（_playFromFile）
//   2. 未命中 → _fallbackStream：yt-dlp 即時串流（YouTube 走 client 輪換策略）
//   3. 長度 ≤ 7 分鐘 → 同時背景下載快取（downloadingUrls 防重複）→ 下載完成後自動響度正規化
//      長度 > 7 分鐘 / 未知長度 / 直播 → 只串流，不下載
//   4. 錯誤 → _handleStreamError：連續錯誤計數 + 最多重試 3 次（間隔 3 秒）
// 常數（MAX_RETRIES / RETRY_DELAY / MAX_CONSECUTIVE_ERRORS / 7 分鐘 / 各種逾時）與 Bot 相同。
//
// 與 Bot 版本必要的差異（因為輸出對象從 Discord AudioPlayer 變成瀏覽器的 HTTP response）：
//   - 「送給播放器」改成「寫進 HTTP response」：
//       快取命中 → res.sendFile（支援 Range，可拖曳進度）
//       即時串流 → yt-dlp stdout 經 ffmpeg 轉成 mp3 後寫進 response
//                 （Bot 是把 stdout 交給 Discord 語音，由 ffmpeg 解碼；瀏覽器沒辦法直接播
//                   yt-dlp 吐出的原始 webm/m4a 管線串流，所以在這裡先用 ffmpeg 轉成 mp3）
//   - 第一個位元組送出前才寫 response header，因此串流一開始就失敗時，重試／輪換 client
//     的行為和 Bot 一樣，對瀏覽器來說只是「等比較久」
//   - 此服務本身就是共用音樂庫，下載＋正規化完的檔案已在庫內，沒有 pushToSharedLibrary 這一步
//   - 「guildId」換成固定 key 'web'（YouTube client 輪換與連續錯誤計數）
//   - 不註冊 process.on('uncaughtException')（會吞掉整個服務的未捕捉錯誤，不應由網頁模組決定）
//
// 檔案分工（本檔只負責環境檢查與 HTTP 入口，其餘拆在同資料夾）：
//   urlUtils.js      cleanUrl / isAllowedUrl
//   videoLookup.js   getInfo（含快取）/ searchMulti
//   streamPlayer.js  playStream、即時串流、背景下載、重試（errorCount / downloadingUrls 狀態在此）

const { exec }      = require('child_process');
const { promisify } = require('util');

const cache      = require('./musicCache');
const antiBot    = require('./musicAntiBot');
const logger     = require('../logger');
const { cleanUrl, isAllowedUrl } = require('./urlUtils');
const { getInfoCached, searchMulti } = require('./videoLookup');
const { playStream, cleanupProcess, WEB_KEY } = require('./streamPlayer');

const execAsync = promisify(exec);
const ytdlpPath = 'yt-dlp';

// ── 網頁版額外的資源保護（Bot 有 Discord 頻道人數天然限制，網頁沒有）──
const MAX_WEB_STREAMS       = parseInt(process.env.WEB_MAX_STREAMS || '4', 10);       // 同時即時串流數

// ── 狀態 ──────────────────────────────────────────────────
const activeCtxs = new Set();       // 目前連線中的串流請求

let available = false;
let initPromise = null;

// ════════════════════════════════════════════════════════
//  環境檢查（同 Bot）
// ════════════════════════════════════════════════════════
async function checkYtDlp() {
  try {
    const { stdout } = await execAsync(`${ytdlpPath} --version`);
    logger.debug('OnlineMusic', `yt-dlp 版本: ${stdout.trim()}`);
    return true;
  } catch {
    logger.error('OnlineMusic', 'yt-dlp 未安裝');
    return false;
  }
}

async function checkFFmpeg() {
  for (const p of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { await execAsync(`${p} -version`); logger.debug('OnlineMusic', `FFmpeg: ${p}`); return true; }
    catch {}
  }
  logger.error('OnlineMusic', 'FFmpeg 未找到');
  return false;
}

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    antiBot.initCookies();
    cache.ensureCacheDir();
    const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);
    available = ytdlpOk && ffmpegOk;
    if (available) {
      const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
      logger.info('OnlineMusic',
        `網頁線上串流已就緒｜Bilibili ${bilibili ? '✓' : '✗'}、YouTube ${youtube ? '✓' : '✗（無帳號模式）'}、PO Token ${poToken ? '✓' : '✗'}`);
    } else {
      logger.warn('OnlineMusic', 'yt-dlp 或 FFmpeg 未就緒，網頁的線上搜尋／串流功能停用（音樂庫播放不受影響）');
    }
    return available;
  })();
  return initPromise;
}

function isAvailable() { return available; }

// ════════════════════════════════════════════════════════
//  HTTP 入口：GET /web/play?url=...
// ════════════════════════════════════════════════════════
async function handlePlayRequest(req, res, rawUrl) {
  if (!available) return res.status(503).json({ error: '伺服器未安裝 yt-dlp / ffmpeg，無法線上串流' });

  const url = cleanUrl(String(rawUrl || ''));
  if (!isAllowedUrl(url)) return res.status(400).json({ error: '只支援 YouTube / Bilibili 網址' });

  if (activeCtxs.size >= MAX_WEB_STREAMS) {
    return res.status(503).json({ error: '目前串流人數已滿，請稍後再試' });
  }

  let item;
  try {
    item = await getInfoCached(url);
  } catch (err) {
    return res.status(502).json({ error: `無法獲取影片資訊：${err.message}` });
  }
  if (res.destroyed || req.aborted) return;

  const ctx = { req, res, item, procs: null, closed: false, started: false };
  activeCtxs.add(ctx);

  res.on('close', () => {
    if (ctx.closed) return;
    ctx.closed = true;
    activeCtxs.delete(ctx);
    cleanupProcess(ctx);
    // 對應 Bot 的 stopAll → resetYtClient：沒有任何串流了，client 輪換狀態重置
    if (activeCtxs.size === 0) antiBot.resetYtClient(WEB_KEY);
  });

  await playStream(ctx, 0);
}

// ── 防殭屍進程保護（同 Bot）──
process.on('exit', () => {
  for (const ctx of activeCtxs) {
    const p = ctx.procs;
    if (!p) continue;
    for (const proc of [p.ytdlp, p.ffmpeg]) {
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch {}
    }
  }
});

module.exports = {
  init,
  isAvailable,
  isAllowedUrl,
  cleanUrl,
  getInfo: getInfoCached,
  searchMulti,
  handlePlayRequest,
};
