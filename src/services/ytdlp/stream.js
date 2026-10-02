'use strict';
// ytdlp/stream.js — 播放流程（對應 Bot 的 playStream）
//   1. 查快取 → 命中：res.sendFile（支援 Range，可拖曳進度）
//   2. 未命中 → yt-dlp 即時串流（經 ffmpeg 轉 mp3 寫進 response；YouTube 走 client 輪換）
//   3. ≤ 7 分鐘 → 同時背景下載快取（見 backgroundCache.js）；否則只串流
//   4. 錯誤 → 連續錯誤計數 + 最多重試 3 次（間隔 3 秒）
//   ctx = { req, res, item, procs, closed, started }
const { spawn } = require('child_process');
const path = require('path');
const cache = require('./cache');
const antiBot = require('./antiBot');
const state = require('./state');
const { cleanupProcess } = require('./process');
const { startBackgroundDownload } = require('./backgroundCache');
const {
  ytdlpPath, WEB_KEY, MAX_RETRIES, RETRY_DELAY, MAX_CONSECUTIVE_ERRORS, MAX_CACHE_DURATION_SEC,
} = require('./constants');

async function playStream(ctx, retryCount = 0) {
  const { item } = ctx;
  cleanupProcess(ctx);

  const platform = antiBot.isYouTubeUrl(item.url) ? 'YouTube' : 'Bilibili';

  const tooLongToCache = !item.durationSec || item.durationSec > MAX_CACHE_DURATION_SEC;

  try {
    const cachedPath = await cache.getCachedPath(item.url, item.title);
    if (ctx.closed) return;

    if (cachedPath) {
      console.log(`✅ [Cache] 快取命中，直接播放: ${path.basename(cachedPath)}`);
      _playFromFile(ctx, cachedPath);
      return;
    }

    if (tooLongToCache) {
      const reason = !item.durationSec ? '未知長度/直播' : `長度超過 7 分鐘`;
      console.log(`⏭️ [${platform}] ${reason}，跳過背景下載，僅串流: ${item.title}`);
    } else {
      console.log(`🔄 [${platform}] 快取未命中，啟動即時串流播放: ${item.title}`);
    }

    _fallbackStream(ctx, retryCount);

    if (!tooLongToCache) startBackgroundDownload(item, platform);
  } catch (err) {
    console.error(`❌ [${platform}] 播放前發生錯誤: ${err.message}`);
    _handleStreamError(ctx, retryCount, err.message);
  }
}

// 對應 Bot 的 _playFromFile：Bot 是 createAudioResource(filePath)，這裡是 res.sendFile（含 Range）
function _playFromFile(ctx, filePath) {
  const { res } = ctx;
  ctx.started = true;
  res.sendFile(filePath, { headers: { 'Cache-Control': 'private, no-cache' } }, (err) => {
    if (!err) return;
    if (res.headersSent) return; // 瀏覽器中途取消（ECONNABORTED）等，不需處理
    console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    ctx.started = false;
    _handleStreamError(ctx, 0, err.message);
  });
  state.errorCount = 0;
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
  } else {
    streamArgs = antiBot.buildBilibiliArgs(item.url, true);
  }

  const ytdlp = spawn(ytdlpPath, streamArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Bot 把 stdout 交給 Discord（內部用 ffmpeg 解碼）；瀏覽器需要可直接播放的格式，這裡轉成 mp3
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
    '-f', 'mp3', 'pipe:1',
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
      errorOutput += err;
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
          setTimeout(() => { if (!ctx.closed && ctx.procs === mine) _fallbackStream(ctx, retryCount); }, 1000);
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
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      state.errorCount = 0; // 對應 Bot：player.play(resource) 後 errorCounts.set(guildId, 0)
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
      try { ytdlp.kill('SIGKILL'); } catch {}
      _handleStreamError(ctx, retryCount, `ffmpeg 轉檔失敗 (code ${code})`);
    }
    // 否則交給 yt-dlp 的 close 事件判斷（含 client 輪換）
  });

  ffmpeg.on('error', err => {
    if (stale() || mine.done) return;
    mine.done = true;
    try { ytdlp.kill('SIGKILL'); } catch {}
    _handleStreamError(ctx, retryCount, `執行 ffmpeg 失敗: ${err.message}`);
  });
}

// 對應 Bot 的 _handleStreamError：Bot 最後是 player.emit('error') 通知上層跳過，這裡是回應 502
function _handleStreamError(ctx, retryCount, errorMessage) {
  if (ctx.closed) return;

  state.errorCount += 1;
  console.error(`❌ 串流錯誤 (${state.errorCount}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);

  if (state.errorCount >= MAX_CONSECUTIVE_ERRORS) {
    console.error('❌ 連續錯誤過多，停止播放');
    state.errorCount = 0; // 對應 Bot：stopAll → clearErrorCount
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
  cleanupProcess(ctx);
  const { res } = ctx;
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.status(502).json({ error: message });
  } else {
    res.end();
  }
}

module.exports = { playStream };
