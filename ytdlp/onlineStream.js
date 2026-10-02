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

const { spawn, exec } = require('child_process');
const { promisify }   = require('util');
const path = require('path');

const cache      = require('./musicCache');
const antiBot    = require('./musicAntiBot');
const normalizer = require('./musicNormalizer');
const logger     = require('../logger');

const execAsync = promisify(exec);
const ytdlpPath = 'yt-dlp';

// ── 重試配置（同 Bot）────────────────────────────────────
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 超過此秒數則只串流，不下載快取（同 Bot）──────────────
const MAX_CACHE_DURATION_SEC = 7 * 60; // 420 秒

// ── 搜尋／getInfo 逾時保護（同 Bot）──────────────────────
const SEARCH_TIMEOUT_MS_YT   = 15_000;
const SEARCH_TIMEOUT_MS_BILI = 25_000;
const GET_INFO_TIMEOUT_MS    = 15_000;

// ── 網頁版額外的資源保護（Bot 有 Discord 頻道人數天然限制，網頁沒有）──
const MAX_WEB_STREAMS       = parseInt(process.env.WEB_MAX_STREAMS || '4', 10);       // 同時即時串流數
const MAX_WEB_QUERIES       = parseInt(process.env.WEB_MAX_QUERIES || '4', 10);       // 同時搜尋／getInfo 數
const INFO_CACHE_TTL_MS     = 10 * 60_000;
const INFO_CACHE_MAX        = 200;

const WEB_KEY = 'web'; // 取代 Bot 的 guildId：YouTube client 輪換 & 連續錯誤計數

// ── 狀態 ──────────────────────────────────────────────────
let errorCount = 0;                 // 對應 Bot 的 errorCounts.get(guildId)
const downloadingUrls = new Set();  // 下載鎖（防止同一 URL 同時下載兩次）
const activeCtxs = new Set();       // 目前連線中的串流請求
let activeQueries = 0;
const infoCache = new Map();        // url -> { info, ts }

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
//  工具
// ════════════════════════════════════════════════════════
function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

// 與 Bot 的 unifiedQueue/search/urlUtils.js 的 cleanUrl 相同
function cleanUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);

    if (urlObj.hostname.includes('bilibili.com')) {
      const p = urlObj.searchParams.get('p');
      urlObj.search = '';
      if (p) urlObj.searchParams.set('p', p);
      return urlObj.toString();
    }

    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname === 'youtu.be') {
      urlObj.searchParams.delete('list');
      urlObj.searchParams.delete('index');
      urlObj.searchParams.delete('start_radio');
      urlObj.searchParams.delete('rv');
      urlObj.searchParams.delete('feature');
      return urlObj.toString();
    }

    return rawUrl;
  } catch (error) {
    return rawUrl;
  }
}

// 網頁版新增：只允許 YouTube / Bilibili 網域。
// Bot 的入口是 Discord 使用者，這裡是任何拿到網頁密碼的人，
// 不能讓 yt-dlp 被拿去抓任意網址（它支援上千個網站，也能讀 file:// 等）。
const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com'];
function isAllowedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function cleanupProcess(ctx) {
  const procs = ctx.procs;
  if (!procs) return;
  ctx.procs = null; // 先解除關聯，讓舊進程的 close/data 事件全部失效
  console.log('🧹 清理舊的 yt-dlp 進程');
  for (const [proc, force] of [[procs.ytdlp, true], [procs.ffmpeg, false]]) {
    if (!proc || proc.killed) continue;
    try {
      proc.kill(force ? 'SIGTERM' : 'SIGKILL');
      if (force) setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 1000);
    } catch {}
  }
}

// ════════════════════════════════════════════════════════
//  getInfo（取得影片資訊）— YouTube + Bilibili（同 Bot）
// ════════════════════════════════════════════════════════
async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [getInfo] 逾時（超過 ${GET_INFO_TIMEOUT_MS / 1000}s），強制終止: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得影片資訊逾時，請確認網址是否正確或稍後再試'));
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if (antiBot.isYouTubeUrl(url)) {
          const classified = antiBot.classifyYouTubeError(errorData);
          reject(new Error(`[YouTube] ${classified.msg}`));
        } else {
          const classified = antiBot.classifyBilibiliError(errorData);
          reject(new Error(`[Bilibili] ${classified.msg}`));
        }
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title      : info.title    || '未知標題',
          author     : info.uploader || info.channel || info.creator || '未知作者',
          duration   : formatDuration(info.duration),
          durationSec: info.duration || 0,   // 保留原始秒數，供快取判斷使用
          thumbnail  : info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('執行 yt-dlp 失敗: ' + err.message));
    });
  });
}

// 網頁版新增：getInfo 結果短暫快取。
// 網頁流程是「先 /info 顯示標題 → 再 /play 串流」兩次請求，
// 第二次不該再花一次 yt-dlp（durationSec 一律由伺服器自己取得，不信任瀏覽器傳來的數值）。
async function getInfoCached(url) {
  const hit = infoCache.get(url);
  if (hit && Date.now() - hit.ts < INFO_CACHE_TTL_MS) return hit.info;

  if (activeQueries >= MAX_WEB_QUERIES) throw new Error('伺服器忙碌中，請稍後再試');
  activeQueries++;
  try {
    const info = await getInfo(url);
    if (infoCache.size >= INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
    infoCache.set(url, { info, ts: Date.now() });
    return info;
  } finally {
    activeQueries--;
  }
}

// ════════════════════════════════════════════════════════
//  _searchOnePlatform — 搜尋單一平台（同 Bot）
// ════════════════════════════════════════════════════════
function _searchOnePlatform(searchPrefix, keyword, limit, fast = false) {
  return new Promise((resolve) => {
    const query = `${searchPrefix}${limit}:${keyword}`;
    const isYT  = searchPrefix === 'ytsearch';

    const args = [
      '--dump-json',
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    if (isYT) {
      args.push('--flat-playlist');
      args.push(...antiBot.buildYouTubeSearchArgs());
    } else {
      if (fast) args.push('--flat-playlist');
      args.push(...antiBot.buildBilibiliSearchArgs());
    }

    args.push(query);

    const timeoutMs = isYT ? SEARCH_TIMEOUT_MS_YT : SEARCH_TIMEOUT_MS_BILI;
    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [Search] ${searchPrefix} 搜尋逾時（超過 ${timeoutMs / 1000}s），強制終止`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, timeoutMs);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        const classified = isYT
          ? antiBot.classifyYouTubeError(errorData)
          : antiBot.classifyBilibiliError(errorData);
        console.warn(`⚠️ [Search] ${searchPrefix} 搜尋失敗 (code=${code}): ${classified.msg}`);
        resolve([]);
        return;
      }

      const lines = data.trim().split('\n').filter(Boolean);
      const results = [];

      for (const line of lines) {
        try {
          const info = JSON.parse(line);

          const url = info.webpage_url
            || info.url
            || (isYT  && info.id ? `https://www.youtube.com/watch?v=${info.id}` : null)
            || (!isYT && info.id ? `https://www.bilibili.com/video/${info.id}`   : null);

          if (!url) continue;

          const thumb = info.thumbnail
            || (Array.isArray(info.thumbnails) && info.thumbnails.length
                  ? info.thumbnails[info.thumbnails.length - 1].url
                  : null);

          results.push({
            platform : isYT ? 'YouTube' : 'Bilibili',
            title    : info.title    || '未知標題',
            author   : info.uploader || info.channel || info.creator || '未知作者',
            duration : formatDuration(info.duration),
            url,
            thumbnail: thumb,
          });
        } catch {
          // 忽略單行解析錯誤，不影響其他結果
        }
      }
      resolve(results);
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.warn(`⚠️ [Search] ${searchPrefix} 執行 yt-dlp 失敗: ${err.message}`);
      resolve([]);
    });
  });
}

// searchMulti — 同時搜尋 YouTube + Bilibili（同 Bot）
async function searchMulti(keyword, limit = 5, fast = false, platforms = ['youtube', 'bilibili']) {
  if (activeQueries >= MAX_WEB_QUERIES) throw new Error('伺服器忙碌中，請稍後再試');
  activeQueries++;
  try {
    const tasks = [
      platforms.includes('youtube')
        ? _searchOnePlatform('ytsearch', keyword, limit, fast)
        : Promise.resolve([]),
      platforms.includes('bilibili')
        ? _searchOnePlatform('bilisearch', keyword, limit, fast)
        : Promise.resolve([]),
    ];
    const [ytResults, biliResults] = await Promise.all(tasks);
    return [...ytResults, ...biliResults].filter(r => isAllowedUrl(r.url));
  } finally {
    activeQueries--;
  }
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

    if (!tooLongToCache) {
      if (!downloadingUrls.has(item.url)) {
        downloadingUrls.add(item.url);

        console.log(`⬇️ [${platform}] 背景開始下載快取...`);

        const dlArgs = antiBot.isYouTubeUrl(item.url)
          ? antiBot.buildYouTubeArgs(
              item.url,
              antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || antiBot.YT_CLIENT_STRATEGIES[0],
              false,
            )
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

      } else {
        console.log(`⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
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
  res.sendFile(filePath, { headers: { 'Cache-Control': 'private, no-cache' } }, (err) => {
    if (!err) return;
    if (res.headersSent) return; // 瀏覽器中途取消（ECONNABORTED）等，不需處理
    console.error('❌ [OnlineMusic] 本地播放失敗:', err);
    ctx.started = false;
    _handleStreamError(ctx, 0, err.message);
  });
  errorCount = 0;
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
      errorCount = 0; // 對應 Bot：player.play(resource) 後 errorCounts.set(guildId, 0)
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

  errorCount += 1;
  console.error(`❌ 串流錯誤 (${errorCount}/${MAX_CONSECUTIVE_ERRORS}): ${errorMessage}`);

  if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
    console.error('❌ 連續錯誤過多，停止播放');
    errorCount = 0; // 對應 Bot：stopAll → clearErrorCount
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
