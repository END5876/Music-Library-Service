'use strict';
// antiBot/config.js — Proxy、Cookies 檔案路徑、偽裝用 Headers、PO Token（只讀取環境變數，無狀態）
const path = require('path');
const logger = require('../../../utils/logger');
const ROOT_DIR = require('../../../utils/rootDir');

const WARP_PROXY = process.env.WARP_PROXY_URL;

if (WARP_PROXY) {
  logger.debug('Proxy', `已設定 WARP_PROXY_URL，YouTube 請求將透過 Proxy 轉發: ${WARP_PROXY}`);
} else {
  logger.debug('Proxy', '未設定 WARP_PROXY_URL，YouTube 請求將直接使用本地網路連線');
}

const COOKIES_DIR     = process.env.YTDLP_COOKIES_DIR || path.join(ROOT_DIR, 'data');
const COOKIES_PATH    = path.join(COOKIES_DIR, 'cookies.txt');
const YT_COOKIES_PATH = path.join(COOKIES_DIR, 'www.youtube.com_cookies.txt');

const BILIBILI_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer'        : 'https://www.bilibili.com/',
  'Origin'         : 'https://www.bilibili.com',
  'Accept'         : '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection'     : 'keep-alive',
  'Sec-Fetch-Dest' : 'empty',
  'Sec-Fetch-Mode' : 'cors',
  'Sec-Fetch-Site' : 'same-site',
};

const YOUTUBE_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const YT_PO_TOKEN = process.env.YOUTUBE_PO_TOKEN || null;

module.exports = {
  WARP_PROXY, COOKIES_PATH, YT_COOKIES_PATH,
  BILIBILI_HEADERS, YOUTUBE_HEADERS, YT_PO_TOKEN,
};
