// ytdlp/videoLookup.js
// 影片資訊查詢（getInfo / getInfoCached）與 YouTube + Bilibili 搜尋（searchMulti）。
// 從 onlineStream.js 拆出，邏輯與常數不變（同 Bot）。

const { spawn } = require('child_process');

const antiBot = require('./musicAntiBot');
const { isAllowedUrl } = require('./urlUtils');

const ytdlpPath = 'yt-dlp';

// ── 搜尋／getInfo 逾時保護（同 Bot）──────────────────────
const SEARCH_TIMEOUT_MS_YT   = 15_000;
const SEARCH_TIMEOUT_MS_BILI = 25_000;
const GET_INFO_TIMEOUT_MS    = 15_000;

// ── 網頁版額外的資源保護（Bot 有 Discord 頻道人數天然限制，網頁沒有）──
const MAX_WEB_QUERIES       = parseInt(process.env.WEB_MAX_QUERIES || '4', 10);       // 同時搜尋／getInfo 數
const INFO_CACHE_TTL_MS     = 10 * 60_000;
const INFO_CACHE_MAX        = 200;

let activeQueries = 0;
const infoCache = new Map();        // url -> { info, ts }
const infoInflight = new Map();     // url -> Promise（同一網址同時多個請求只查一次）

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

  const pending = infoInflight.get(url);
  if (pending) return pending;

  if (activeQueries >= MAX_WEB_QUERIES) throw new Error('伺服器忙碌中，請稍後再試');
  activeQueries++;
  const p = getInfo(url)
    .then((info) => {
      if (infoCache.size >= INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
      infoCache.set(url, { info, ts: Date.now() });
      return info;
    })
    .finally(() => { activeQueries--; infoInflight.delete(url); });
  infoInflight.set(url, p);
  return p;
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

module.exports = { getInfoCached, searchMulti };
