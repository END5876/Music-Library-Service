'use strict';
// musicStore/paths.js
// 路徑與常數：MUSIC_DIR / 快取範圍判斷 / 路徑安全檢查 / 暫存檔判斷。
//
// filename 慣例：一律是相對於 MUSIC_DIR 的路徑，使用 '/' 分隔（不論平台）。
// ★ 自動下載／正規化的快取檔案「直接放在 MUSIC_DIR 根目錄」（沒有 cache 子資料夾）。
// ⚠️ 根目錄第一層的音訊檔都會被視為「快取」，超過 MAX_CACHE_SIZE_MB 時會依修改時間由舊到新刪除。
//    要長期保存的歌，請放進子資料夾（子資料夾不會被清理）。

const fs = require('fs');
const path = require('path');
const ROOT_DIR = require('../../utils/rootDir');

const MUSIC_DIR = process.env.MUSIC_DIR || path.join(ROOT_DIR, 'data', 'music');
const CACHE_SUBDIR = '';                 // 空字串 = 不使用子資料夾，快取直接放根目錄
const CACHE_DIR = CACHE_SUBDIR ? path.join(MUSIC_DIR, CACHE_SUBDIR) : MUSIC_DIR;
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB || '2048', 10);

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];

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

// 下載中／正規化中／上傳中的暫存檔（例如 xxx.tmp.mp3、xxx.norm_123.tmp.mp3、xxx.upload_1_ab.tmp）
// 不能出現在清單裡，否則會被當成一首「壞掉的歌」。
function isTempName(name) {
  return /\.tmp(\.[A-Za-z0-9]+)?$/i.test(name);
}

module.exports = {
  MUSIC_DIR,
  CACHE_SUBDIR,
  CACHE_DIR,
  MAX_CACHE_SIZE_MB,
  SUPPORTED_EXTENSIONS,
  ensureDirs,
  normalizeSlashes,
  isCachePath,
  toSafeRelPath,
  isTempName,
};
