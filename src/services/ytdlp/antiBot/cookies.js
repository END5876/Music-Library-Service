'use strict';
// antiBot/cookies.js — Bilibili / YouTube cookies 準備與附加到 yt-dlp 參數
// （cookies 狀態只存在這個模組內，其他模組透過 append*/getCookieStatus 取用）
const fs = require('fs');
const logger = require('../../../utils/logger');
const { COOKIES_PATH, YT_COOKIES_PATH, YT_PO_TOKEN } = require('./config');

let BILIBILI_COOKIES_FILE   = null;
let BILIBILI_COOKIE_HEADER  = null;
let YT_COOKIES_FILE   = null;
let YT_COOKIE_HEADER  = null;

function prepareBilibiliCookies() {
  if (fs.existsSync(COOKIES_PATH)) {
    logger.debug('Bilibili', '找到 cookies.txt');
    BILIBILI_COOKIES_FILE  = COOKIES_PATH;
    BILIBILI_COOKIE_HEADER = null;
    return;
  }
  const sessdata   = process.env.BILIBILI_SESSDATA;
  const biliJct    = process.env.BILIBILI_BILI_JCT;
  const dedeUserId = process.env.BILIBILI_DEDEUSERID;
  if (sessdata) {
    logger.debug('Bilibili', '從環境變數載入 Cookies（記憶體模式）');
    const parts = [`SESSDATA=${sessdata}`];
    if (biliJct)    parts.push(`bili_jct=${biliJct}`);
    if (dedeUserId) parts.push(`DedeUserID=${dedeUserId}`);
    BILIBILI_COOKIES_FILE  = null;
    BILIBILI_COOKIE_HEADER = parts.join('; ');
    return;
  }
  logger.debug('Bilibili', '未找到 Cookies，播放可能失敗');
  BILIBILI_COOKIES_FILE  = null;
  BILIBILI_COOKIE_HEADER = null;
}

function prepareYouTubeCookies() {
  if (fs.existsSync(YT_COOKIES_PATH)) {
    logger.debug('YouTube', '找到 yt_cookies.txt');
    YT_COOKIES_FILE   = YT_COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  if (fs.existsSync(COOKIES_PATH)) {
    logger.debug('YouTube', '使用共用 cookies.txt');
    YT_COOKIES_FILE   = COOKIES_PATH;
    YT_COOKIE_HEADER  = null;
    return;
  }
  const ytSessId = process.env.YOUTUBE_SESSION_ID;
  const ytVisitor = process.env.YOUTUBE_VISITOR_INFO;
  if (ytSessId || ytVisitor) {
    logger.debug('YouTube', '從環境變數載入 Cookies（記憶體模式）');
    const parts = [];
    if (ytSessId)  parts.push(`SID=${ytSessId}`);
    if (ytVisitor) parts.push(`VISITOR_INFO1_LIVE=${ytVisitor}`);
    YT_COOKIES_FILE   = null;
    YT_COOKIE_HEADER  = parts.join('; ');
    return;
  }
  logger.debug('YouTube', '未設定 Cookies，使用無帳號模式');
  YT_COOKIES_FILE   = null;
  YT_COOKIE_HEADER  = null;
}

function initCookies() {
  prepareBilibiliCookies();
  prepareYouTubeCookies();
  return { BILIBILI_COOKIES_FILE, YT_COOKIES_FILE };
}

function _appendCookieArgs(args, cookiesFile, cookieHeader) {
  if (cookiesFile) {
    args.push('--cookies', cookiesFile);
  } else if (cookieHeader) {
    args.push('--add-header', `Cookie:${cookieHeader}`);
  }
}


const appendBilibiliCookieArgs = (args) => _appendCookieArgs(args, BILIBILI_COOKIES_FILE, BILIBILI_COOKIE_HEADER);
const appendYouTubeCookieArgs  = (args) => _appendCookieArgs(args, YT_COOKIES_FILE, YT_COOKIE_HEADER);

const getCookieStatus = () => ({
  bilibili : BILIBILI_COOKIES_FILE || BILIBILI_COOKIE_HEADER,
  youtube  : YT_COOKIES_FILE       || YT_COOKIE_HEADER,
  poToken  : YT_PO_TOKEN,
});

module.exports = { initCookies, appendBilibiliCookieArgs, appendYouTubeCookieArgs, getCookieStatus };
