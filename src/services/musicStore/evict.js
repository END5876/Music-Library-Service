'use strict';
// musicStore/evict.js
// 快取容量控制
//  - 不遞迴：只處理 CACHE_DIR 第一層的檔案，子資料夾（例如 favorites/）完全不碰
//  - 只處理音訊副檔名：.gitkeep、說明文件、.part 殘留檔等不會被刪
//  - 排除暫存檔：避免把正在下載／正規化／上傳的檔案當成舊檔刪掉

const fs = require('fs');
const path = require('path');
const { CACHE_DIR, MAX_CACHE_SIZE_MB, SUPPORTED_EXTENSIONS, isTempName } = require('./paths');

function evictCacheIfNeeded() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;

    const files = fs.readdirSync(CACHE_DIR, { withFileTypes: true })
      .filter(d => d.isFile()
                && !isTempName(d.name)
                && SUPPORTED_EXTENSIONS.includes(path.extname(d.name).toLowerCase()))
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

module.exports = { evictCacheIfNeeded };
