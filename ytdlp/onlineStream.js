// ytdlp/onlineStream.js
// 移植自 Mousebot handlers/musicplayer/onlineMusicHandler.js
//
// 播放流程與 Bot 完全相同（playStream）：
//   0. （網頁版新增）先用網址裡的影片 ID 找快取檔 → 命中就直接送檔，連 getInfo 都不跑
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
//   - 「guildId」換成固定 key 'web'（YouTube client 輪換）；連續錯誤計數改成每個網址一份
//   - ?fmt=webm（瀏覽器支援 WebM/Opus 時由前端帶上）：YouTube 即時串流只換封裝不重新編碼，見 streamPlayer.js
//   - 不註冊 process.on('uncaughtException')（會吞掉整個服務的未捕捉錯誤，不應由網頁模組決定）
//
// 檔案分工（本檔只負責環境檢查與 HTTP 入口，其餘拆在同資料夾）：
//   urlUtils.js      cleanUrl / isAllowedUrl
//   videoLookup.js   getInfo（含快取）/ searchMulti
//   streamPlayer.js  playStream、即時串流、背景下載、重試（errorCount / downloadingUrls 狀態在此）

const { exec }      = require('child_process');
const { promisify } = require('util');
const path          = require('path');

const cache      = require('./musicCache');
const antiBot    = require('./musicAntiBot');
const potProvider = require('./potProvider');
const logger     = require('../logger');
const { cleanUrl, isAllowedUrl } = require('./urlUtils');
const { getInfoCached, searchMulti } = require('./videoLookup');
const { playStream, cleanupProcess, getStats: getStreamStats, WEB_KEY } = require('./streamPlayer');
const { touchCache } = require('../musicStore');
const { killTree } = require('./procTree');
const ytdlpUpdater = require('./ytdlpUpdater');

const execAsync = promisify(exec);

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
    const { stdout } = await execAsync(`${antiBot.YTDLP_PATH} --version`);
    logger.info('OnlineMusic', `yt-dlp 版本: ${stdout.trim()}`);
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
    potProvider.start();
    cache.ensureCacheDir();
    const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);
    available = ytdlpOk && ffmpegOk;
    if (ytdlpOk) ytdlpUpdater.start();
    if (available) {
      const { bilibili, youtube, poToken, potProvider: pot } = antiBot.getCookieStatus();
      const potLabel = pot === 'local' ? '✓（bgutil 本機）' : pot === 'external' ? '✓（bgutil 外部）' : poToken ? '✓（固定）' : '✗';
      logger.info('OnlineMusic',
        `網頁線上串流已就緒｜Bilibili ${bilibili ? '✓' : '✗'}、YouTube ${youtube ? '✓' : '✗（無帳號模式）'}、PO Token ${potLabel}`);
    } else {
      logger.warn('OnlineMusic', 'yt-dlp 或 FFmpeg 未就緒，網頁的線上搜尋／串流功能停用（音樂庫播放不受影響）');
    }
    return available;
  })();
  return initPromise;
}

function isAvailable() { return available; }

function getStats() {
  return {
    available,
    activeStreams: activeCtxs.size,
    maxStreams: MAX_WEB_STREAMS,
    ...getStreamStats(),
    ytdlp: ytdlpUpdater.getStatus(),
    poToken: potProvider.getMode(),
  };
}

// ════════════════════════════════════════════════════════
//  HTTP 入口：GET /web/play?url=...
// ════════════════════════════════════════════════════════
// opts.cache：是否背景下載快取（快取就存在共用音樂庫根目錄，見 musicStore.js；網頁一般帳號為 false，只串流）
// opts.userKey / opts.maxPerUser：同一個使用者同時串流數上限（null＝不限，例如管理員）
async function handlePlayRequest(req, res, rawUrl, { cache: allowCache = true, userKey = null, maxPerUser = 0 } = {}) {
  if (!available) return res.status(503).json({ error: '伺服器未安裝 yt-dlp / ffmpeg，無法線上串流' });

  const url = cleanUrl(String(rawUrl || ''));
  if (!isAllowedUrl(url)) return res.status(400).json({ error: '只支援 YouTube / Bilibili 網址' });

  // 快取命中的快速路徑：用影片 ID 直接找快取檔，不必先跑 yt-dlp 取標題（省一個 yt-dlp 行程與等待時間）。
  // 只是送檔案，不佔即時串流名額；找不到或送檔失敗就走下面的完整流程。
  const cachedPath = await cache.findCachedById(url).catch(() => null);
  if (res.destroyed || req.aborted) return;
  if (cachedPath && await sendCachedFile(res, cachedPath)) return;

  // 每個使用者的同時串流數：一個人不能把全站名額（MAX_WEB_STREAMS）佔光
  const userBusy = () => {
    if (!userKey || !maxPerUser) return false;
    let n = 0;
    for (const c of activeCtxs) if (c.userKey === userKey) n += 1;
    return n >= maxPerUser;
  };
  const tooMany = () => {
    if (activeCtxs.size >= MAX_WEB_STREAMS) return '目前串流人數已滿，請稍後再試';
    if (userBusy()) return `同時最多 ${maxPerUser} 個線上串流，請先停止其他正在播放的線上歌曲`;
    return '';
  };
  if (tooMany()) return res.status(503).json({ error: tooMany() });

  let item;
  try {
    item = await getInfoCached(url);
  } catch (err) {
    return res.status(502).json({ error: `無法獲取影片資訊：${err.message}` });
  }
  if (res.destroyed || req.aborted) return;
  // 等待 getInfo 期間其他請求可能已佔滿名額，這裡再確認一次
  if (tooMany()) return res.status(503).json({ error: tooMany() });

  const ctx = {
    req, res, item, procs: null, closed: false, started: false, copy: req.query && req.query.fmt === 'webm',
    userKey, noCache: !allowCache,
  };
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

// 回傳 true = 已處理（送出或中途斷線）；false = 還沒送出任何東西（例如檔案剛被快取清理刪掉），呼叫端改走完整流程
function sendCachedFile(res, filePath) {
  console.log(`✅ [Cache] 依影片 ID 命中快取，直接播放: ${path.basename(filePath)}`);
  touchCache(filePath);
  return new Promise((resolve) => {
    res.sendFile(filePath, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, no-cache' } }, (err) => {
      resolve(!err || res.headersSent);
    });
  });
}

// ── 防殭屍進程保護（同 Bot）──
process.on('exit', () => {
  for (const ctx of activeCtxs) {
    const p = ctx.procs;
    if (!p) continue;
    killTree(p.ytdlp, 'SIGKILL');
    killTree(p.ffmpeg, 'SIGKILL');
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
  getStats,
};
