'use strict';
// ytdlp/env.js — 環境檢查（yt-dlp / ffmpeg）與初始化（同 Bot）
const { exec } = require('child_process');
const { promisify } = require('util');
const cache = require('./cache');
const antiBot = require('./antiBot');
const logger = require('../../utils/logger');
const state = require('./state');
const { ytdlpPath } = require('./constants');

const execAsync = promisify(exec);

async function checkYtDlp() {
  try {
    const { stdout } = await execAsync(`${ytdlpPath} --version`);
    logger.debug('OnlineMusic', `yt-dlp 版本: ${stdout.trim()}`);
    return true;
  } catch {
    logger.error('OnlineMusic', 'yt-dlp 未安裝');
    return false;
  }
}

async function checkFFmpeg() {
  for (const p of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try { await execAsync(`${p} -version`); logger.debug('OnlineMusic', `FFmpeg: ${p}`); return true; }
    catch {}
  }
  logger.error('OnlineMusic', 'FFmpeg 未找到');
  return false;
}

function init() {
  if (state.initPromise) return state.initPromise;
  state.initPromise = (async () => {
    antiBot.initCookies();
    cache.ensureCacheDir();
    const [ytdlpOk, ffmpegOk] = await Promise.all([checkYtDlp(), checkFFmpeg()]);
    state.available = ytdlpOk && ffmpegOk;
    if (state.available) {
      const { bilibili, youtube, poToken } = antiBot.getCookieStatus();
      logger.info('OnlineMusic',
        `網頁線上串流已就緒｜Bilibili ${bilibili ? '✓' : '✗'}、YouTube ${youtube ? '✓' : '✗（無帳號模式）'}、PO Token ${poToken ? '✓' : '✗'}`);
    } else {
      logger.warn('OnlineMusic', 'yt-dlp 或 FFmpeg 未就緒，網頁的線上搜尋／串流功能停用（音樂庫播放不受影響）');
    }
    return state.available;
  })();
  return state.initPromise;
}

function isAvailable() { return state.available; }

module.exports = { init, isAvailable };
