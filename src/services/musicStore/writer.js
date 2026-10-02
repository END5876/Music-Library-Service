'use strict';
// musicStore/writer.js
// 寫入（上傳）── 暫存檔 + rename，確保不會有寫到一半就被讀到的半成品檔案。

const fs = require('fs');
const path = require('path');
const { toSafeRelPath, isCachePath } = require('./paths');
const { evictCacheIfNeeded } = require('./evict');

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
      if (isCachePath(relPath)) {
        evictCacheIfNeeded();
      }
      resolve({ relPath, absPath });
    });

    readableStream.pipe(writer);
  });
}

module.exports = { writeFileFromStream };
