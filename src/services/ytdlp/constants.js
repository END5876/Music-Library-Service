'use strict';
// ytdlp/constants.js — 重試／逾時／資源上限（Bot 部分與 Bot 相同，網頁版額外的保護另外標示）

const ytdlpPath = 'yt-dlp';

// ── 重試配置（同 Bot）
const MAX_RETRIES            = 3;
const RETRY_DELAY            = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;

// ── 超過此秒數則只串流，不下載快取（同 Bot）
const MAX_CACHE_DURATION_SEC = 7 * 60; // 420 秒

// ── 搜尋／getInfo 逾時保護（同 Bot）
const SEARCH_TIMEOUT_MS_YT   = 15_000;
const SEARCH_TIMEOUT_MS_BILI = 25_000;
const GET_INFO_TIMEOUT_MS    = 15_000;

// ── 網頁版額外的資源保護（Bot 有 Discord 頻道人數天然限制，網頁沒有）
const MAX_WEB_STREAMS   = parseInt(process.env.WEB_MAX_STREAMS || '4', 10); // 同時即時串流數
const MAX_WEB_QUERIES   = parseInt(process.env.WEB_MAX_QUERIES || '4', 10); // 同時搜尋／getInfo 數
const INFO_CACHE_TTL_MS = 10 * 60_000;
const INFO_CACHE_MAX    = 200;

const WEB_KEY = 'web'; // 取代 Bot 的 guildId：YouTube client 輪換 & 連續錯誤計數

module.exports = {
  ytdlpPath,
  MAX_RETRIES, RETRY_DELAY, MAX_CONSECUTIVE_ERRORS, MAX_CACHE_DURATION_SEC,
  SEARCH_TIMEOUT_MS_YT, SEARCH_TIMEOUT_MS_BILI, GET_INFO_TIMEOUT_MS,
  MAX_WEB_STREAMS, MAX_WEB_QUERIES, INFO_CACHE_TTL_MS, INFO_CACHE_MAX,
  WEB_KEY,
};
