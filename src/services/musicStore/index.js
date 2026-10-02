'use strict';
// musicStore — 音樂庫服務對「實體磁碟」的唯一存取層。
// 這個服務是共用音樂庫的唯一擁有者（掛著 Volume），所有跨 Bot 共用的音樂檔案都經過這裡讀寫。
// 對外介面與拆分前的 musicStore.js 完全相同。

const paths = require('./paths');
const { listAll, exists, resolveForRead } = require('./listing');
const { writeFileFromStream } = require('./writer');
const { evictCacheIfNeeded } = require('./evict');

module.exports = {
  MUSIC_DIR: paths.MUSIC_DIR,
  CACHE_SUBDIR: paths.CACHE_SUBDIR,
  CACHE_DIR: paths.CACHE_DIR,
  MAX_CACHE_SIZE_MB: paths.MAX_CACHE_SIZE_MB,
  evictCacheIfNeeded,
  listAll,
  exists,
  resolveForRead,
  writeFileFromStream,
};
