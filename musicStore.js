'use strict';
// musicStore.js
// 職責：音樂庫服務對「實體磁碟」的唯一存取層 —— 這個服務是共用音樂庫
// 的唯一擁有者（掛著 Volume），所有跨 Bot 共用的音樂檔案都經過這裡讀寫。
//
// filename 慣例：一律是相對於 MUSIC_DIR 的路徑，使用 '/' 分隔（不論平台）。
// ★ 本版本：自動下載／正規化的快取檔案「直接放在 MUSIC_DIR 根目錄」（沒有 cache 子資料夾）。
// 例如：自動下載＋正規化過的曲目 → '歌名 [BVxxxx].mp3'
//       手動放的分類子資料夾       → 'favorites/歌名.mp3'
//
// ⚠️ 注意：根目錄第一層的音訊檔都會被視為「快取」，超過 MAX_CACHE_SIZE_MB 時
//    會依修改時間由舊到新刪除。要長期保存的歌，請放進子資料夾（子資料夾不會被清理）。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream');

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, 'data', 'music');
const CACHE_SUBDIR = '';                 // 空字串 = 不使用子資料夾，快取直接放根目錄
const CACHE_DIR = CACHE_SUBDIR ? path.join(MUSIC_DIR, CACHE_SUBDIR) : MUSIC_DIR;
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10);

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
const RESERVED_TOP_DIR = '.web';        // 舊版播放清單資料夾：仍不對外提供讀寫、不列入清單
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '512', 10);
const LIST_TTL_MS = 3000;               // listAll 結果的短暫快取
const STALE_TMP_MS = 60 * 60 * 1000;    // 殘留暫存檔超過 1 小時視為垃圾

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

// 判斷某個相對路徑是否屬於「快取範圍」
//   有 CACHE_SUBDIR：位於該子資料夾內
//   無 CACHE_SUBDIR：位於根目錄第一層（不含子資料夾）
function isCachePath(relPath) {
  return CACHE_SUBDIR
    ? relPath.startsWith(`${CACHE_SUBDIR}/`)
    : !relPath.includes('/');
}

// ── 路徑安全檢查：拒絕任何跳出 MUSIC_DIR 範圍的相對路徑 ──────
// 所有 filename 都是外部（其他 Bot）傳進來的字串，一律視為不可信任輸入。
function toSafeRelPath(rawRelPath) {
  const raw = normalizeSlashes(rawRelPath);
  if (raw.includes('\0')) throw new Error('不合法的檔案路徑');
  const cleaned = raw.replace(/^\/+/, '');
  const normalized = path.posix.normalize(cleaned);

  if (!normalized || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('不合法的檔案路徑');
  }
  // 內部資料夾（播放清單 JSON 等）不可經由 API 讀寫
  if (normalized.split('/')[0] === RESERVED_TOP_DIR) throw new Error('不合法的檔案路徑');

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

async function walkFiles(dir, depth = 0) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth === 0 && entry.name === RESERVED_TOP_DIR) continue;
      out.push(...await walkFiles(fullPath, depth + 1));
    } else if (entry.isFile() && !isTempName(entry.name)) {
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
let listCache = null;     // { at, files }
let listInflight = null;  // 同時多個請求共用同一次掃描

// 檔案有異動（上傳／下載完成／正規化／清理）時呼叫，讓下一次 listAll 重新掃描
function invalidateList() { listCache = null; }

async function scanLibrary() {
  ensureDirs();
  const allFiles = (await walkFiles(MUSIC_DIR))
    .filter(fp => SUPPORTED_EXTENSIONS.includes(path.extname(fp).toLowerCase()));

  const out = [];
  // 分批並行 stat，避免數千首時一次開太多 fd，也不再同步卡住 event loop
  for (let i = 0; i < allFiles.length; i += 64) {
    const batch = allFiles.slice(i, i + 64);
    const stats = await Promise.all(batch.map(fp => fsp.stat(fp).catch(() => null)));
    batch.forEach((fp, k) => {
      const stat = stats[k];
      if (!stat) return; // 掃描途中被刪除（快取清理）
      const relPath = normalizeSlashes(path.relative(MUSIC_DIR, fp));
      const baseName = path.basename(fp, path.extname(fp));
      const sourcePrefix = relPath.includes('/') ? `[${relPath.split('/')[0]}] ` : '';
      out.push({
        filename: relPath,
        name: cleanDisplayName(`${sourcePrefix}${baseName}`),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    });
  }
  const collator = new Intl.Collator('zh-Hant');
  return out.sort((a, b) => collator.compare(a.name, b.name));
}

async function listAll() {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.files;
  if (!listInflight) {
    listInflight = scanLibrary()
      .then((files) => { listCache = { at: Date.now(), files }; return files; })
      .finally(() => { listInflight = null; });
  }
  return listInflight;
}

// 只有「音訊檔」才會經由 API 讀取／覆寫：暫存檔、JSON、其他任意檔案一律不碰
function isServableName(relPath) {
  const base = path.posix.basename(relPath);
  return SUPPORTED_EXTENSIONS.includes(path.extname(base).toLowerCase()) && !isTempName(base);
}

async function exists(rawRelPath) {
  const { relPath, absPath } = toSafeRelPath(rawRelPath);
  if (!isServableName(relPath)) return { exists: false, filename: relPath };
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) return { exists: false, filename: relPath };
    return { exists: true, filename: relPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, filename: relPath };
  }
}

function resolveForRead(rawRelPath) {
  const { relPath, absPath } = toSafeRelPath(rawRelPath);
  if (!isServableName(relPath)) return null;
  try {
    return fs.statSync(absPath).isFile() ? absPath : null;
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════
//  寫入（上傳）── 暫存檔 + rename，確保不會有寫到一半就被讀到
//  的半成品檔案。
// ════════════════════════════════════════════════════════
// 將原始上傳內容先寫到不可見暫存檔。呼叫端必須在後續處理成功後才發布它，
// 因此轉檔／正規化期間不會有半成品出現在音樂庫清單或被播放器讀取。
function writeTempFileFromStream(rawRelPath, readableStream, tempExtension = '') {
  return new Promise((resolve, reject) => {
    let relPath, absPath;
    try {
      ({ relPath, absPath } = toSafeRelPath(rawRelPath));
      if (!isServableName(relPath)) throw new Error('只允許上傳音訊檔（' + SUPPORTED_EXTENSIONS.join(' ') + '）');
      if (tempExtension && !SUPPORTED_EXTENSIONS.includes(String(tempExtension).toLowerCase())) {
        throw new Error('不支援的音訊格式');
      }
    } catch (err) {
      readableStream.resume(); // 把請求 body 排掉，避免連線卡住
      return reject(err);
    }

    const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
    const declared = Number(readableStream.headers && readableStream.headers['content-length']);
    if (declared > maxBytes) {
      readableStream.resume();
      return reject(new Error(`檔案過大（上限 ${MAX_UPLOAD_MB} MB）`));
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const tmpPath = `${absPath}.upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp${tempExtension}`;
    const writer = fs.createWriteStream(tmpPath);
    const cleanupTmp = () => { try { fs.unlinkSync(tmpPath); } catch {} };

    // 傳輸中再計一次實際大小（Content-Length 可能缺席或說謊，chunked 也沒有）
    let received = 0;
    readableStream.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) readableStream.destroy(new Error(`檔案過大（上限 ${MAX_UPLOAD_MB} MB）`));
    });

    // pipeline：來源中斷（客戶端斷線）、寫入失敗時都會關閉另一端並回呼，不會留下卡住的 Promise 或 fd
    pipeline(readableStream, writer, (err) => {
      if (err) {
        cleanupTmp();
        return reject(err);
      }
      resolve({ relPath, absPath, tmpPath });
    });
  });
}

function writeFileFromStream(rawRelPath, readableStream) {
  return writeTempFileFromStream(rawRelPath, readableStream)
    .then(({ relPath, absPath, tmpPath }) => {
      try {
        fs.renameSync(tmpPath, absPath);
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw err;
      }
      invalidateList();
      console.log(`✅ [MusicLibrary] 已寫入音樂庫: ${relPath}`);
      if (isCachePath(relPath)) scheduleEvict();
      return { relPath, absPath };
    });
}

// ════════════════════════════════════════════════════════
//  快取容量控制
//  - 不遞迴：只處理 CACHE_DIR 第一層的檔案，子資料夾（例如 favorites/）完全不碰
//  - 只處理音訊副檔名：.gitkeep、說明文件、.part 殘留檔等不會被刪
//  - 排除暫存檔：避免把正在下載／正規化／上傳的檔案當成舊檔刪掉
// ════════════════════════════════════════════════════════
function evictCacheIfNeeded() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = [];
    for (const d of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (!d.isFile() || isTempName(d.name)
          || !SUPPORTED_EXTENSIONS.includes(path.extname(d.name).toLowerCase())) continue;
      const fp = path.join(CACHE_DIR, d.name);
      try {
        const stat = fs.statSync(fp);
        files.push({ fp, mtime: stat.mtimeMs, size: stat.size });
      } catch { /* 掃描途中被刪除，略過 */ }
    }
    files.sort((a, b) => a.mtime - b.mtime); // 最舊排前面

    let totalMB = files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;
    let removed = 0;

    while (totalMB > MAX_CACHE_SIZE_MB && files.length > 0) {
      const oldest = files.shift();
      try { fs.unlinkSync(oldest.fp); } catch (err) {
        if (err.code !== 'ENOENT') console.error('❌ [MusicLibrary] 刪除舊檔失敗:', err.message);
      }
      totalMB -= oldest.size / 1024 / 1024;
      removed++;
      console.log(`🗑️ [MusicLibrary] 快取已滿，刪除舊檔: ${path.basename(oldest.fp)}`);
    }
    if (removed) invalidateList();
  } catch (err) {
    console.error('❌ [MusicLibrary] 快取清理失敗:', err);
  }
}

// 批次上傳（例如搬移音樂庫）時每個檔案都掃一次整個資料夾是 O(n²)，合併成一次
let evictTimer = null;
function scheduleEvict() {
  if (evictTimer) return;
  evictTimer = setTimeout(() => { evictTimer = null; evictCacheIfNeeded(); }, 1500);
  evictTimer.unref();
}

// 啟動時清掉當機／重啟遺留的暫存檔（.tmp / .upload_*.tmp / .norm_*.tmp.mp3），
// 這些檔案不會出現在清單、也不會被快取清理刪掉，會一直佔用 Volume。
// 只刪超過 STALE_TMP_MS 沒更新的，避免誤刪正在進行中的工作。
async function cleanupStaleTemps(dir = MUSIC_DIR, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  let n = 0;
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth === 0 && e.name === RESERVED_TOP_DIR) continue;
      n += await cleanupStaleTemps(fp, depth + 1);
    } else if (e.isFile() && isTempName(e.name)) {
      try {
        const st = await fsp.stat(fp);
        if (Date.now() - st.mtimeMs > STALE_TMP_MS) { await fsp.unlink(fp); n++; }
      } catch {}
    }
  }
  if (n && depth === 0) console.log(`🧹 [MusicLibrary] 已清除 ${n} 個殘留暫存檔`);
  return n;
}

module.exports = {
  MUSIC_DIR,
  CACHE_SUBDIR,
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  evictCacheIfNeeded,
  invalidateList,
  cleanupStaleTemps,
  listAll,
  exists,
  resolveForRead,
  writeTempFileFromStream,
  writeFileFromStream,
};
