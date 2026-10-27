// ytdlp/streamPlayer.js
// 單一串流請求的播放流程（對應 Bot 的 playStream）：
//   查快取 → 命中直接送檔；未命中 → yt-dlp 即時串流（ffmpeg 轉 mp3）＋背景下載快取＋正規化；
//   錯誤 → 連續錯誤計數 + 重試。從 onlineStream.js 拆出，邏輯與常數不變（同 Bot）。
//
// 共用可變狀態（errorCounts / downloadingUrls / recentFailures）只在這個模組內讀寫。
// ctx = { req, res, item, procs, closed, started, copy, userKey, noCache }，由 onlineStream.js 的 handlePlayRequest 建立。
//
// 即時串流的輸出格式：
//   ctx.copy=true（瀏覽器支援 WebM/Opus，且是 YouTube）→ yt-dlp 優先挑 Opus 音軌，ffmpeg 只換封裝（-c:a copy），
//     不重新編碼：省 CPU，也少一次有損壓縮。來源不是 Opus（放不進 WebM）時，自動改回轉 mp3 重來一次，不算錯誤。
//   其餘 → ffmpeg 轉 mp3 192k（同以往）。

const { spawn } = require('child_process');
const { alert } = require('../alert');
const path = require('path');
const { spawnTree, isAlive, killTree } = require('./procTree');

const cache      = require('./musicCache');
const antiBot    = require('./musicAntiBot');
const normalizer = require('./musicNormalizer');
const potProvider = require('./potProvider');
const { touchCache } = require('../musicStore');

// ── 重試配置（同 Bot）────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 超過此秒數則只串流，不下載快取（同 Bot）──────────────
const MAX_CACHE_DURATION_SEC = 7 * 60; // 420 秒

// 背景下載同時數上限：連續跳歌時，串流會被砍掉，但各首的背景下載仍會繼續，不限制的話會堆出一堆 yt-dlp
const MAX_BG_DOWNLOADS = parseInt(process.env.WEB_MAX_DOWNLOADS || '2', 10);

const WEB_KEY = 'web'; // 取代 Bot 的 guildId：YouTube client 輪換（被擋是以 IP 為準，所以全站共用）

// ── 狀態 ──────────────────────────────────────────────────
// 連續錯誤計數：Bot 是每個伺服器（guild）一份；網頁版改成每個網址一份，
// 否則某個人播到壞掉的影片，會把其他人正常的串流也算進「連續錯誤」。
const errorCounts = new Map();      // url -> 連續錯誤次數
const ERROR_COUNTS_MAX = 500;
const downloadingUrls = new Set();  // 下載鎖（防止同一 URL 同時下載兩次）

// 最近一小時的串流失敗紀錄（狀態頁用；連續失敗通常代表 yt-dlp 需要更新或 IP 被擋）
const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const recentFailures = [];          // [{ at, platform, message }]
function recordFailure(platform, message) {
  const now = Date.now();
  recentFailures.push({ at: now, platform, message: String(message || '').slice(0, 200) });
  while (recentFailures.length && (now - recentFailures[0].at > FAILURE_WINDOW_MS || recentFailures.length > 100)) recentFailures.shift();
}

function resetErrorCount(url) { errorCounts.delete(url); }
function bumpErrorCount(url) {
  const n = (errorCounts.get(url) || 0) + 1;
  errorCounts.delete(url); // 重新插入到尾端，超過上限時從最舊的開始丟
  errorCounts.set(url, n);
  if (errorCounts.size > ERROR_COUNTS_MAX) errorCounts.delete(errorCounts.keys().next().value);
  return n;
}

function getStats() {
  const now = Date.now();
  const fails = recentFailures.filter((f) => now - f.at <= FAILURE_WINDOW_MS);
  const last = fails[fails.length - 1];
  return {
    backgroundDownloads: downloadingUrls.size,
    maxBackgroundDownloads: MAX_BG_DOWNLOADS,
    failuresLastHour: fails.length,
    lastFailure: last ? { ...last, at: new Date(last.at).toISOString() } : null,
  };
}

function cleanupProcess(ctx) {
  const procs = ctx.procs;
  if (!procs) return;
  ctx.procs = null; // 先解除關聯，讓舊進程的 close/data 事件全部失效
  console.log('🧹 清理舊的 yt-dlp 進程');
  // yt-dlp（含它自己開的 ffmpeg）先 SIGTERM，1 秒後還活著就 SIGKILL；轉檔用的 ffmpeg 直接 SIGKILL
  const { ytdlp, ffmpeg } = procs;
  if (isAlive(ytdlp)) {
    killTree(ytdlp, 'SIGTERM');
    setTimeout(() => killTree(ytdlp, 'SIGKILL'), 1000).unref();
  }
  if (isAlive(ffmpeg)) { try { ffmpeg.kill('SIGKILL'); } catch {} }
}

// ════════════════════════════════════════════════════════
//  playStream（對應 Bot 的 playStream(guildId, item, player, ...)）
//  ctx = { req, res, item, procs, closed, started }
// ════════════════════════════════════════════════════════
async function playStream(ctx, retryCount = 0) {
  const { item } = ctx;
  cleanupProcess(ctx);

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  const tooLongToCache = !item.durationSec || item.durationSec > MAX_CACHE_DURATION_SEC;
  // ctx.noCache：呼叫端不允許寫入共用音樂庫（網頁的一般帳號，見 onlineRoutes.js），只串流
  const skipCache = tooLongToCache || !!ctx.noCache;

  try {
    const cachedPath = await cache.getCachedPath(item.url, item.title);
    if (ctx.closed) return;

    if (cachedPath) {
      console.log(`✅ [Cache] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(ctx, cachedPath);
      return;
    }

    if (skipCache) {
      const reason = ctx.noCache ? '不寫入共用音樂庫' : !item.durationSec ? '未知長度/直播' : `長度超過 7 分鐘`;
      console.log(`⏭️ [${platform}] ${reason}，跳過背景下載，僅串流: ${item.title}`);
    } else {
      console.log(`🔄 [${platform}] 快取未命中，啟動即時串流播放: ${item.title}`);
    }

    // 串流與背景下載都是 YouTube 的 yt-dlp：先確保 PO Token server 在跑（按需啟動，見 potProvider.js）
    if (platform === 'YouTube') {
      await potProvider.ensureReady();
      if (ctx.closed) return;
    }

    _fallbackStream(ctx, retryCount);

    if (!skipCache) {
      if (downloadingUrls.has(item.url)) {
        console.log(`⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
      } else if (downloadingUrls.size >= MAX_BG_DOWNLOADS) {
        console.log(`⏭️ [${platform}] 背景下載已達上限 (${MAX_BG_DOWNLOADS})，這首只串流，不下載快取`);
      } else {
        downloadingUrls.add(item.url);

        console.log(`⬇️ [${platform}] 背景開始下載快取...`);

        const dlArgs = antiBot.isYouTubeUrl(item.url)
          ? antiBot.buildYouTubeArgs(item.url, antiBot.DEFAULT_YT_STRATEGY, false)
          : antiBot.buildBilibiliArgs(item.url, false);

        let lastProgress = 0;

        cache.downloadAndCache(
          item.url,
          item.title,
          dlArgs,
          (progress) => {
            if (progress - lastProgress >= 20) {
              lastProgress = progress;
              console.log(`⬇️ [${platform}] 背景下載進度: ${progress.toFixed(1)}%`);
            }
          },
        )
        .then((filePath) => {
          console.log(`✅ [Cache] 背景下載完成，已儲存至: ${path.basename(filePath)}`);

          // 下載完成後，背景自動進行響度正規化（不阻塞任何播放邏輯）
          // ※ Bot 版在正規化後會 pushToSharedLibrary；這個服務本身就是共用音樂庫，檔案已在庫內。
          normalizer.normalizeAudioFile(filePath)
            .then(() => {
              console.log(`🎚️ [Normalizer] 響度正規化完成: ${path.basename(filePath)}`);
            })
            .catch((err) => {
              console.warn(`⚠️ [Normalizer] 正規化失敗（略過，原檔仍可正常播放）: ${err.message}`);
            });
        })
        .catch((err) => {
          console.error(`⚠️ [Cache] 背景下載失敗: ${err.message}`);
        })
        .finally(() => {
          downloadingUrls.delete(item.url);
        });

      }
    }

  } catch (err) {
    console.error(`❌ [${platform}] 播放前發生錯誤: ${err.message}`);
    _handleStreamError(ctx, retryCount, err.message);
  }
}

// 對應 Bot 的 _playFromFile：Bot 是 createAudioResource(filePath)，這裡是 res.sendFile（含 Range）
function _playFromFile(ctx, filePath) {
  const { res } = ctx;
  ctx.started = true;
  touchCache(filePath);
  res.sendFile(filePath, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, no-cache' } }, (err) => {
    if (!err) return;
    if (res.headersSent) return; // 瀏覽器中途取消（ECONNABORTED）等，不需處理
    console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    ctx.started = false;
    _handleStreamError(ctx, 0, err.message);
  });
  resetErrorCount(ctx.item.url);
  console.log(`🎵 [OnlineMusic] 本地播放: ${path.basename(filePath)}`);
}

// 對應 Bot 的 _fallbackStream
function _fallbackStream(ctx, retryCount) {
  const { item, res } = ctx;
  const isYT     = antiBot.isYouTubeUrl(item.url);
  const platform = isYT ? 'YouTube' : 'Bilibili';

  console.log(`🔄 [${platform}] 切換串流模式: ${item.title}`);

  let streamArgs;

  if (isYT) {
    const { strategy } = antiBot.getYtClientStrategy(WEB_KEY);
    console.log(`🎯 [YouTube] 使用 client: ${strategy.name} (${strategy.desc})`);
    streamArgs = antiBot.buildYouTubeArgs(item.url, strategy, true);
    if (ctx.copy) streamArgs = preferOpus(streamArgs);
  } else {
    streamArgs = antiBot.buildBilibiliArgs(item.url, true);
  }

  const ytdlp = spawnTree(antiBot.YTDLP_PATH, streamArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Bot 把 stdout 交給 Discord（內部用 ffmpeg 解碼）；瀏覽器需要可直接播放的格式：
  // 支援 WebM 的瀏覽器＋YouTube → 只換封裝（不重新編碼）；否則轉成 mp3
  const copy = !!(ctx.copy && isYT);
  const output = copy
    ? { args: ['-vn', '-c:a', 'copy', '-f', 'webm'], type: 'audio/webm' }
    : { args: ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'], type: 'audio/mpeg' };
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'pipe', // 輸入只會是 yt-dlp 的 stdout：不讓媒體內容引用本機檔案或其他網址
    '-i', 'pipe:0',
    ...output.args, 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  const mine = { ytdlp, ffmpeg, done: false };
  ctx.procs = mine;
  const stale = () => ctx.procs !== mine || ctx.closed;

  let hasError = false, errorOutput = '', dataReceived = false;

  // ── yt-dlp → ffmpeg ──
  ytdlp.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => {}); // ffmpeg 提早結束／被砍時的 EPIPE，忽略
  ytdlp.stdout.on('data', () => { dataReceived = true; });

  ytdlp.stderr.on('data', data => {
    const err = data.toString();
    if (!err.includes('Deleting original file')) {
      console.error(`[${platform}] yt-dlp stderr:`, err);
      errorOutput = (errorOutput + err).slice(-8000); // 只留尾端（錯誤分類只看關鍵字），長時間串流不會一直累積
      if (!err.includes('unable to write data') &&
          !err.includes('Broken pipe') &&
          !err.includes('Invalid argument')) {
        hasError = true;
      }
    }
  });

  ytdlp.on('error', err => { hasError = true; errorOutput = err.message; });

  ytdlp.on('close', (code, signal) => {
    console.log(`[${platform}] yt-dlp 進程結束 (code: ${code}, signal: ${signal})`);
    if (stale() || mine.done) return;

    if (code !== 0 && !dataReceived && hasError) {
      mine.done = true;
      try { ffmpeg.kill('SIGKILL'); } catch {}

      if (isYT) {
        const classified = antiBot.classifyYouTubeError(errorOutput);
        console.warn(`⚠️ [YouTube] ${classified.msg}`);

        if (classified.rotate && antiBot.rotateYtClient(WEB_KEY)) {
          console.log('🔄 [YouTube] 使用備用 client 重試...');
          setTimeout(() => {
            potProvider.ensureReady().then(() => {
              if (!ctx.closed && ctx.procs === mine) _fallbackStream(ctx, retryCount);
            });
          }, 1000);
          return;
        }
      }
      _handleStreamError(ctx, retryCount, errorOutput);
    }
  });

  // ── ffmpeg → HTTP response ──
  ffmpeg.stderr.on('data', d => {
    if (!mine.done) console.error(`[ffmpeg] ${d.toString().trim().slice(-200)}`);
  });

  ffmpeg.stdout.on('data', chunk => {
    if (stale()) return;
    if (!ctx.started) {
      ctx.started = true;
      res.status(200);
      res.set({
        'Content-Type': output.type,
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      resetErrorCount(item.url); // 對應 Bot：player.play(resource) 後 errorCounts.set(guildId, 0)
    }
    if (!res.write(chunk)) {
      ffmpeg.stdout.pause();
      res.once('drain', () => { try { ffmpeg.stdout.resume(); } catch {} });
    }
  });

  ffmpeg.on('close', (code) => {
    if (stale() || mine.done) return;
    if (ctx.started) {
      // 已經有資料送出：正常播完或中途中斷都直接結束 response
      mine.done = true;
      if (!res.writableEnded) res.end();
    } else if (dataReceived || code !== 0) {
      // yt-dlp 有輸出資料但 ffmpeg 一個位元組都沒產出（格式無法解碼等）
      mine.done = true;
      killTree(ytdlp, 'SIGKILL');
      if (copy && dataReceived) {
        // 來源音軌放不進 WebM（例如拿到的是 AAC）：改回轉 mp3 立刻重來，不算一次錯誤
        console.warn(`⚠️ [${platform}] 音軌無法直接封裝成 WebM，改為轉 mp3: ${item.title}`);
        ctx.copy = false;
        cleanupProcess(ctx);
        _fallbackStream(ctx, retryCount);
        return;
      }
      _handleStreamError(ctx, retryCount, `ffmpeg 轉檔失敗 (code ${code})`);
    }
    // 否則交給 yt-dlp 的 close 事件判斷（含 client 輪換）
  });

  ffmpeg.on('error', err => {
    if (stale() || mine.done) return;
    mine.done = true;
    killTree(ytdlp, 'SIGKILL');
    _handleStreamError(ctx, retryCount, `執行 ffmpeg 失敗: ${err.message}`);
  });
}

// 對應 Bot 的 _handleStreamError：Bot 最後是 player.emit('error') 通知上層跳過，這裡是回應 502
function _handleStreamError(ctx, retryCount, errorMessage) {
  if (ctx.closed) return;

  const url = ctx.item.url;
  const errorCount = bumpErrorCount(url);
  console.error(`❌ 串流錯誤 (${errorCount}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);

  if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
    console.error('❌ 連續錯誤過多，停止播放');
    resetErrorCount(url); // 對應 Bot：stopAll → clearErrorCount
    _failResponse(ctx, `連續發生 ${MAX_CONSECUTIVE_ERRORS} 次錯誤，已停止播放`);
    return;
  }

  if (retryCount < MAX_RETRIES) {
    console.log(`⏳ ${RETRY_DELAY / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
    cleanupProcess(ctx);
    setTimeout(() => { if (!ctx.closed) playStream(ctx, retryCount + 1); }, RETRY_DELAY);
  } else {
    console.error('❌ 重試次數已用盡，通知上層跳過');
    _failResponse(ctx, `播放失敗（已重試 ${MAX_RETRIES} 次）：${String(errorMessage).substring(0, 100)}`);
  }
}

function _failResponse(ctx, message) {
  recordFailure(antiBot.isYouTubeUrl(ctx.item.url) ? 'YouTube' : 'Bilibili', message);
  if (getStats().failuresLastHour === 5) {
    console.warn('⚠️ [OnlineMusic] 最近一小時串流失敗已達 5 次：常見原因是 yt-dlp 過舊（見 ytdlpUpdater.js）或 IP 被 YouTube 擋（需要 cookies／WARP_PROXY_URL）');
    alert('stream-failures', `網頁播放器最近一小時串流失敗已達 5 次（最後一次：${message.slice(0, 200)}）。常見原因是 yt-dlp 過舊或 IP 被 YouTube 擋`);
  }
  cleanupProcess(ctx);
  const { res } = ctx;
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.status(502).json({ error: message });
  } else {
    res.end();
  }
}

// 直接封裝模式：讓 yt-dlp 優先挑 Opus 音軌（YouTube 的 251/250），沒有才退回原本的 bestaudio/best
function preferOpus(args) {
  const out = args.slice();
  const i = out.indexOf('-f');
  if (i >= 0 && out[i + 1] === 'bestaudio/best') out[i + 1] = 'bestaudio[acodec=opus]/bestaudio/best';
  return out;
}

module.exports = { playStream, cleanupProcess, getStats, preferOpus, WEB_KEY };
