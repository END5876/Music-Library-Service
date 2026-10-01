// ytdlp/musicCache.js
// 移植自 Mousebot handlers/musicplayer/musicCache.js
// 職責：快取資料夾管理、檔名產生、快取讀寫、大小控制、下載執行
//
// 與 Bot 版本的差異（僅此兩點）：
//   1. 這個服務「本身就是」共用音樂庫，所以快取資料夾直接是 <MUSIC_DIR>/cache，
//      不需要（也沒有）musicLibraryClient 的「向共用音樂庫查詢／上傳」——
//      下載完成的檔案就已經在共用音樂庫裡了，其他 Bot 下次 checkExists 就會命中。
//   2. 檔名格式 getCacheFilename() 與 Bot 完全相同，因此 Bot 與網頁彼此的快取會互相命中。

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('../logger');
const { CACHE_DIR, MAX_CACHE_SIZE_MB, evictCacheIfNeeded } = require('../musicStore');

const ytdlpPath = 'yt-dlp';

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug('Cache', `已建立快取資料夾: ${CACHE_DIR}`);
  }
}

// 格式：<清理後的標題> [<影片ID>].mp3
function getCacheFilename(url, title) {
  const safeTitle = (title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);

  const bvMatch = url.match(/BV[\w]+/i);
  const avMatch = url.match(/av(\d+)/i);
  const ytMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);

  const idSuffix = bvMatch ? bvMatch[0]
    : avMatch              ? `av${avMatch[1]}`
    : ytMatch              ? `yt_${ytMatch[1]}`
    : Buffer.from(url).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  return safeTitle ? `${safeTitle} [${idSuffix}].mp3` : `${idSuffix}.mp3`;
}

// 檢查快取是否存在，回傳路徑或 null
async function getCachedPath(url, title) {
  ensureCacheDir();
  const filename = getCacheFilename(url, title);
  const filePath = path.join(CACHE_DIR, filename);

  if (fs.existsSync(filePath)) return filePath;
  return null;
}

// 快取大小管理：與 musicStore 共用同一份實作（只清 cache/、不碰暫存檔與策展資料夾）

// 下載並儲存到快取
function downloadAndCache(url, title, ytdlpArgs, onProgress) {
  return new Promise((resolve, reject) => {
    ensureCacheDir();
    evictCacheIfNeeded();

    const filename  = getCacheFilename(url, title);
    const filePath  = path.join(CACHE_DIR, filename);
    const tmpBase   = path.join(CACHE_DIR, filename.replace(/\.mp3$/, '.tmp'));
    const tmpActual = tmpBase + '.mp3'; // yt-dlp 轉檔後實際產生的路徑

    const finalArgs = ytdlpArgs.map(a => a === '__OUTPUT__' ? tmpBase : a);

    const platform = url.includes('youtube.com') || url.includes('youtu.be')
      ? 'YouTube' : 'Bilibili';

    console.log(`⬇️ [${platform}] 開始下載: ${filename}`);
    const ytdlp = spawn(ytdlpPath, finalArgs, { windowsHide: true });

    let errorOutput = '';

    ytdlp.stderr.on('data', data => {
      const line = data.toString();
      errorOutput += line;
      const progressMatch = line.match(/\[download\]\s+([\d.]+)%/);
      if (progressMatch && onProgress) {
        onProgress(parseFloat(progressMatch[1]));
      }
    });

    ytdlp.on('error', err => reject(new Error('執行 yt-dlp 失敗: ' + err.message)));

    ytdlp.on('close', code => {
      if (code !== 0) {
        try { if (fs.existsSync(tmpActual)) fs.unlinkSync(tmpActual); } catch {}
        try { if (fs.existsSync(tmpBase))   fs.unlinkSync(tmpBase);   } catch {}
        console.error(`❌ [${platform}] 下載失敗:`, errorOutput.slice(-300));
        reject(new Error(`下載失敗 (code: ${code}): ${errorOutput.slice(-200)}`));
        return;
      }

      const actualTmp = fs.existsSync(tmpActual) ? tmpActual
        : fs.existsSync(tmpBase)                 ? tmpBase
        : null;

      if (!actualTmp) {
        reject(new Error('下載完成但找不到輸出檔案'));
        return;
      }

      try {
        fs.renameSync(actualTmp, filePath);
        const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
        console.log(`✅ [${platform}] 下載完成: ${filename} (${sizeMB} MB)`);
        resolve(filePath);
      } catch (err) {
        reject(new Error('重新命名快取檔失敗: ' + err.message));
      }
    });
  });
}

module.exports = {
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  ensureCacheDir,
  getCacheFilename,
  getCachedPath,
  evictCacheIfNeeded,
  downloadAndCache,
};
