'use strict';
// musicStore/listing.js
// 清單 / 存在檢查 / 讀取。
// ★ 不含播放次數：每台呼叫端 Bot 各自計算自己的播放次數，這個服務只負責檔案本身。

const fs = require('fs');
const path = require('path');
const {
  MUSIC_DIR, SUPPORTED_EXTENSIONS,
  ensureDirs, normalizeSlashes, toSafeRelPath, isTempName,
} = require('./paths');

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

module.exports = { listAll, exists, resolveForRead };
