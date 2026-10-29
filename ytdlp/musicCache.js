// ytdlp/musicCache.js
// 移植自 Mousebot handlers/musicplayer/musicCache.js
// 職責：快取資料夾管理、檔名產生、快取讀寫、大小控制、下載執行
//
// 與 Bot 版本的差異：
//   1. 這個服務「本身就是」共用音樂庫，所以快取直接放在 MUSIC_DIR 根目錄第一層（見 musicStore.CACHE_DIR），
//      不需要（也沒有）musicLibraryClient 的「向共用音樂庫查詢／上傳」——
//      下載完成的檔案就已經在共用音樂庫裡了，其他 Bot 下次 checkExists 就會命中。
//   2. 檔名格式 getCacheFilename() 與 Bot 完全相同，因此 Bot 與網頁彼此的快取會互相命中。
//   3. downloadAndCache 在發布（改名成快取檔名）之前先做響度正規化，見函式內的說明。

const { spawnTree, killTree } = require('./procTree');
const fs   = require('fs');
const path = require('path');
const logger = require('../logger');
const { isYouTubeUrl, YTDLP_PATH } = require('./musicAntiBot');
const { parseUrl, youtubeVideoId, bilibiliVideoId } = require('./urlUtils');
const { CACHE_DIR, MAX_CACHE_SIZE_MB, evictCacheIfNeeded, invalidateList, listAll } = require('../musicStore');
const normalizer = require('./musicNormalizer');

// 單一下載的最長時間；yt-dlp 卡死時強制終止，否則下載鎖（downloadingUrls）永遠不會釋放
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    logger.debug('Cache', `已建立快取資料夾: ${CACHE_DIR}`);
  }
}

// 快取檔名裡的影片 ID（BVxxx / avNNN / yt_xxx）；認不出平台 ID 時回傳 null
// 先依網域決定平台再取 ID：YouTube 的影片 ID 是隨機英數字，可能剛好含有「av1」「bv…」，
// 以前不分平台先比對 BV / av，會讓兩支不同的 YouTube 影片算出同一個快取檔（播到別首歌）。
// 🔒 [快取投毒] ID 只從網址的固定位置取（與 urlUtils.cleanUrl 相同的解析）：以前在整個網址裡找，
// 查詢參數裡的 &x=BV… 或 /shorts/<B>?v=<A> 都能讓快取檔名跟實際下載的影片不一致。
// ⚠️ Bot 端（unifiedQueue 的 musicCache.getCacheFilename）也要做同樣的修改，兩邊的快取才會互相命中。
function getCacheId(url) {
  const u = parseUrl(url);
  if (!u) return null;
  // 用網域判斷平台（與 Bot 的 getCacheId 相同）；isYouTubeUrl 是在整個網址裡找字串
  const host = u.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    const { id } = youtubeVideoId(u);
    return id ? `yt_${id}` : null;
  }
  return bilibiliVideoId(u);
}

// 格式：<清理後的標題> [<影片ID>].mp3
function getCacheFilename(url, title) {
  const safeTitle = (title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    // 🐛 [截斷 emoji] 與 Bot 端 getCacheFilename 相同：切在 emoji 中間時去掉半個代理字元，兩邊檔名才會一致
    .replace(/[\uD800-\uDBFF]$/, '');

  const idSuffix = getCacheId(url)
    || Buffer.from(url).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  return safeTitle ? `${safeTitle} [${idSuffix}].mp3` : `${idSuffix}.mp3`;
}

// 檢查快取是否存在，回傳路徑或 null（非同步 stat，不卡住同時進行的串流）
async function getCachedPath(url, title) {
  ensureCacheDir();
  const filename = getCacheFilename(url, title);
  const filePath = path.join(CACHE_DIR, filename);

  const st = await fs.promises.stat(filePath).catch(() => null);
  return st && st.isFile() ? filePath : null;
}

// 不知道標題時，只用影片 ID 找快取檔（播放前不必為了算檔名先跑一次 yt-dlp 取標題）。
// 只找快取範圍（根目錄第一層）；同一個 ID 有多個檔案（影片改過標題）時取最新的。
// Bilibili 分 P（網址帶 ?p=）各 P 共用同一個 BV 號，認不出是哪一 P，一律回傳 null 走原本流程。
// （只限 Bilibili：YouTube 網址帶 p 不代表分 P，以前也跳過的話，帶 p 就能強制重新下載、寫入新的快取檔）
async function findCachedById(url) {
  const id = getCacheId(url);
  if (!id) return null;
  if (!isYouTubeUrl(url)) {
    try { if (new URL(url).searchParams.has('p')) return null; } catch { return null; }
  }

  const suffix = ` [${id}].mp3`;
  let best = null;
  for (const f of await listAll()) {
    if (f.filename.includes('/')) continue;
    if (!f.filename.endsWith(suffix) && f.filename !== `${id}.mp3`) continue;
    // 🐛 [分 P 播錯首] 不帶 ?p= 的網址是第 1 P，但合集各 P 的快取檔都以同一個 [BV…] 結尾
    // （yt-dlp 會在標題後加「pNN 分P名」），只看 ID 會拿到最後快取的那一 P；
    // 只要有分 P 的檔案就交給完整流程（取得標題後用完整檔名比對）
    if (!isYouTubeUrl(url) && /(^|\s)p\d{2,}(\s|$)/.test(f.filename.slice(0, -suffix.length))) return null;
    if (!best || f.mtimeMs > best.mtimeMs) best = f;
  }
  return best ? path.join(CACHE_DIR, best.filename) : null;
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

    // -o 是 yt-dlp 的輸出範本：標題裡的 % 要寫成 %%，否則像「%(id)s」會被展開成別的檔名，下載完就找不到輸出檔
    const finalArgs = ytdlpArgs.map(a => a === '__OUTPUT__' ? tmpBase.replace(/%/g, '%%') : a);

    const platform = isYouTubeUrl(url) ? 'YouTube' : 'Bilibili';

    console.log(`⬇️ [${platform}] 開始下載: ${filename}`);
    const ytdlp = spawnTree(YTDLP_PATH, finalArgs, { windowsHide: true });

    let errorOutput = '';
    const appendErr = (line) => { errorOutput = (errorOutput + line).slice(-4000); }; // 只留尾端，避免長時間下載無限累積

    // yt-dlp 的下載進度印在 stdout；沒人讀的話 pipe 緩衝（64KB）滿了之後 yt-dlp 會卡死
    const onChunk = (data) => {
      const line = data.toString();
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m && onProgress) onProgress(parseFloat(m[1]));
      return line;
    };
    ytdlp.stdout.on('data', onChunk);
    ytdlp.stderr.on('data', data => appendErr(onChunk(data)));

    const timer = setTimeout(() => {
      console.warn(`⚠️ [${platform}] 下載逾時（${DOWNLOAD_TIMEOUT_MS / 60000} 分鐘），強制終止: ${filename}`);
      killTree(ytdlp, 'SIGKILL'); // 連同 yt-dlp 轉檔用的 ffmpeg 一起終止
    }, DOWNLOAD_TIMEOUT_MS);

    ytdlp.on('error', err => { clearTimeout(timer); reject(new Error('執行 yt-dlp 失敗: ' + err.message)); });

    ytdlp.on('close', code => {
      clearTimeout(timer);
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

      // 🐛 先在暫存檔上做響度正規化，再改名成快取檔名發布：以前是發布後才正規化、原地換掉檔案，
      // 已經開始播這個檔的瀏覽器接下來的 Range 請求會用舊檔的位移讀新檔（雜音或 416）。
      // 正規化失敗就照原檔發布（原檔仍可正常播放）
      normalizer.normalizeAudioFile(actualTmp)
        .then(
          () => console.log(`🎚️ [Normalizer] 響度正規化完成: ${filename}`),
          (err) => console.warn(`⚠️ [Normalizer] 正規化失敗（略過，原檔仍可正常播放）: ${err.message}`),
        )
        .then(() => {
          try {
            fs.renameSync(actualTmp, filePath);
            invalidateList();
            evictCacheIfNeeded(); // 新檔加入後再檢查一次容量（下載前的檢查看不到這一首）
            const sizeMB = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
            console.log(`✅ [${platform}] 下載完成: ${filename} (${sizeMB} MB)`);
            resolve(filePath);
          } catch (err) {
            reject(new Error('重新命名快取檔失敗: ' + err.message));
          }
        });
    });
  });
}

module.exports = {
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  ensureCacheDir,
  getCacheFilename,
  getCachedPath,
  findCachedById,
  evictCacheIfNeeded,
  downloadAndCache,
};
