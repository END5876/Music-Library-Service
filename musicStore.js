'use strict';
// musicStore.js
// 職責：音樂庫服務對「實體磁碟」的唯一存取層 —— 這個服務是共用音樂庫
// 的唯一擁有者（掛著 Volume），所有跨 Bot 共用的音樂檔案都經過這裡讀寫。
//
// filename 慣例：一律是相對於 MUSIC_DIR 的路徑，使用 '/' 分隔（不論平台），
// 跟 Mousebot 過去 localMusicHandler.js 的 walkFiles() 產生的 filename 是
// 同一套慣例，所以既有「已存在的本地音樂庫」搬過來後，filename 完全不會變。
// 例如：cache 資料夾內自動下載＋正規化過的曲目 → 'cache/歌名 [BVxxxx].mp3'
//       原本手動放的分類子資料夾           → 'favorites/歌名.mp3'

const fs = require('fs');
const path = require('path');

const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';
const CACHE_SUBDIR = 'cache';                       // 自動下載／正規化的快取放在這個子資料夾
const CACHE_DIR = path.join(MUSIC_DIR, CACHE_SUBDIR);
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10);

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

// ════════════════════════════════════════════════════════
//  基礎工具
// ════════════════════════════════════════════════════════
function ensureDirs() {
  if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function normalizeSlashes(p) {
  return String(p || '').replace(/\\/g, '/');
}

// ── 路徑安全檢查：拒絕任何跳出 MUSIC_DIR 範圍的相對路徑 ──────
// 所有 filename 都是外部（其他 Bot）傳進來的字串，一律視為不可信任輸入。
function toSafeRelPath(rawRelPath) {
  const cleaned = normalizeSlashes(rawRelPath).replace(/^\/+/, '');
  const normalized = path.posix.normalize(cleaned);

  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('不合法的檔案路徑');
  }

  const absPath = path.resolve(path.join(MUSIC_DIR, normalized));
  const rootPath = path.resolve(MUSIC_DIR);

  if (absPath !== rootPath && !absPath.startsWith(rootPath + path.sep)) {
    throw new Error('不合法的檔案路徑');
  }

  return { relPath: normalized, absPath };
}

// 與 Mousebot 過去 localMusicHandler.js 的 cleanLocalTitle() 完全相同的
// 清理規則，確保搬過來之後 /music local list 顯示出來的名稱不會改變。
function cleanDisplayName(raw) {
  let t = String(raw || '').trim();
  t = t.replace(/\.(mp3|wav|ogg|flac|m4a|aac)$/i, '');
  t = t.replace(/\s*\[(?:BV[\w]+|av\d+|yt_[A-Za-z0-9_-]{6,})\]\s*$/i, '');
  t = t.replace(/\s*\((?:BV[\w]+|av\d+|yt_[A-Za-z0-9_-]{6,})\)\s*$/i, '');
  t = t.replace(/^\[[^\]]+\]\s*/i, '');
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t || '未知標題';
}

// 下載中／正規化中／上傳中的暫存檔（例如 xxx.tmp.mp3、xxx.norm_123.tmp.mp3、xxx.upload_1_ab.tmp）
// 不能出現在清單裡，否則會被當成一首「壞掉的歌」。
function isTempName(name) {
  return /\.tmp(\.[A-Za-z0-9]+)?$/i.test(name);
}

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkFiles(fullPath));
    } else if (!isTempName(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════
//  清單 / 存在檢查 / 讀取
//  ★ 不含播放次數：每台呼叫端 Bot 各自計算自己的播放次數，
//    這個服務只負責檔案本身，不記錄、不回傳播放次數。
// ════════════════════════════════════════════════════════
async function listAll() {
  ensureDirs();

  const allFiles = walkFiles(MUSIC_DIR);

  return allFiles
    .filter(fp => SUPPORTED_EXTENSIONS.includes(path.extname(fp).toLowerCase()))
    .map(fp => {
      const relPath = normalizeSlashes(path.relative(MUSIC_DIR, fp));
      const ext = path.extname(fp);
      const baseName = path.basename(fp, ext);
      const sourcePrefix = relPath.includes('/') ? `[${relPath.split('/')[0]}] ` : '';
      const stat = fs.statSync(fp);

      return {
        filename: relPath,
        name: cleanDisplayName(`${sourcePrefix}${baseName}`),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
}

async function exists(rawRelPath) {
  const { relPath, absPath } = toSafeRelPath(rawRelPath);
  if (!fs.existsSync(absPath)) return { exists: false, filename: relPath };
  const stat = fs.statSync(absPath);
  return { exists: true, filename: relPath, size: stat.size, mtimeMs: stat.mtimeMs };
}

function resolveForRead(rawRelPath) {
  const { absPath } = toSafeRelPath(rawRelPath);
  return fs.existsSync(absPath) ? absPath : null;
}

// ════════════════════════════════════════════════════════
//  寫入（上傳）── 暫存檔 + rename，確保不會有寫到一半就被讀到
//  的半成品檔案。
// ════════════════════════════════════════════════════════
function writeFileFromStream(rawRelPath, readableStream) {
  return new Promise((resolve, reject) => {
    let relPath, absPath;
    try {
      ({ relPath, absPath } = toSafeRelPath(rawRelPath));
    } catch (err) {
      readableStream.resume(); // 把請求 body 排掉，避免連線卡住
      return reject(err);
    }

    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = `${absPath}.upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`;
    const writer = fs.createWriteStream(tmpPath);
    let settled = false;

    const cleanupTmp = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} };

    readableStream.on('error', (err) => {
      if (settled) return;
      settled = true;
      writer.destroy();
      cleanupTmp();
      reject(err);
    });

    writer.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanupTmp();
      reject(err);
    });

    writer.on('finish', () => {
      if (settled) return;
      settled = true;
      try {
        fs.renameSync(tmpPath, absPath);
      } catch (err) {
        cleanupTmp();
        return reject(err);
      }
      console.log(`✅ [MusicLibrary] 已寫入音樂庫: ${relPath}`);
      if (relPath.startsWith(`${CACHE_SUBDIR}/`)) {
        evictCacheIfNeeded();
      }
      resolve({ relPath, absPath });
    });

    readableStream.pipe(writer);
  });
}

// ════════════════════════════════════════════════════════
//  快取容量控制 —— 只清 cache/ 子資料夾，絕不動到手動放進去的
//  「策展音樂庫」檔案（例如 favorites/ 這類使用者自行分類的資料夾）。
// ════════════════════════════════════════════════════════
function evictCacheIfNeeded() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    // 只算「檔案」且排除暫存檔（xxx.tmp.mp3 / xxx.norm_123.tmp.mp3 / xxx.upload_*.tmp），
    // 避免把正在下載／正規化／上傳的檔案當成舊檔刪掉
    const files = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
      .filter(d => d.isFile() && !isTempName(d.name))
      .map(d => {
        const fp = path.join(CACHE_DIR, d.name);
        const stat = fs.statSync(fp);
        return { fp, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => a.mtime - b.mtime); // 最舊排前面

    let totalMB = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;

    while (totalMB > MAX_CACHE_SIZE_MB && files.length > 0) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.fp);
      totalMB -= oldest.size / 1024 / 1024;
      console.log(`🗑️ [MusicLibrary] 快取已滿，刪除舊檔: ${path.basename(oldest.fp)}`);
    }
  } catch (err) {
    console.error('❌ [MusicLibrary] 快取清理失敗:', err);
  }
}

module.exports = {
  MUSIC_DIR,
  CACHE_SUBDIR,
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  evictCacheIfNeeded,
  listAll,
  exists,
  resolveForRead,
  writeFileFromStream,
};
