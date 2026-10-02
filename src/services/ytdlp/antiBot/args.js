'use strict';
// antiBot/args.js — yt-dlp 參數組合（串流 / 下載 / 搜尋 / 取得資訊）
const { isYouTubeUrl } = require('../../../utils/urlUtils');
const cookies = require('./cookies');
const { YT_CLIENT_STRATEGIES } = require('./clients');
const { WARP_PROXY, BILIBILI_HEADERS, YOUTUBE_HEADERS, YT_PO_TOKEN } = require('./config');

function buildYouTubeArgs(url, strategy, streamMode = true) {
  const args = [];

  if (WARP_PROXY) {
    args.push('--proxy', WARP_PROXY);
  }
  args.push('--js-runtimes', 'node');

  if (streamMode) {
    args.push('-f', 'bestaudio/best', '-o', '-', '--quiet', '--buffer-size', '16K');
  } else {
    args.push('-f', 'bestaudio/best', '-o', '__OUTPUT__', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push('--no-playlist', '--no-warnings');
  args.push(...strategy.args);

  if (strategy.needsPO && YT_PO_TOKEN) {
    args.push('--extractor-args', `youtube:po_token=mweb.gvs+${YT_PO_TOKEN}`);
    console.log(`🔑 [YouTube] 附加 PO Token (${YT_PO_TOKEN.slice(0, 8)}...)`);
  }

  if (strategy.name !== 'tv_simply') {
    cookies.appendYouTubeCookieArgs(args);
  }

  args.push(
    '--user-agent',  YOUTUBE_HEADERS['User-Agent'],
    '--add-header',  `Accept-Language:${YOUTUBE_HEADERS['Accept-Language']}`,
  );

  // ⚡ --sleep-* 只在背景快取下載（streamMode=false）保留；即時串流路徑跳過，換取反應速度
  if (!streamMode) {
    args.push(
      '--sleep-requests',     '1',
      '--sleep-interval',     '1',
      '--max-sleep-interval', '3',
    );
  }

  args.push('--no-check-certificate', '--ignore-errors');

  args.push(url);
  return args;
}

function buildBilibiliArgs(url, streamMode = true) {
  const args = [];
  if (streamMode) {
    args.push('-f', 'bestaudio/best', '-o', '-', '--quiet', '--extract-audio', '--audio-format', 'opus', '--audio-quality', '0', '--buffer-size', '16K');
  } else {
    args.push('-f', 'bestaudio/best', '-o', '__OUTPUT__', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push('--no-playlist', '--no-warnings');
  cookies.appendBilibiliCookieArgs(args);

  args.push(
    '--user-agent', BILIBILI_HEADERS['User-Agent'],
    '--referer',    BILIBILI_HEADERS['Referer'],
    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
  );

  if (!streamMode) {
    args.push(
      '--sleep-requests',     '2',
      '--sleep-interval',     '2',
      '--max-sleep-interval', '5',
    );
  }

  args.push(
    '--no-check-certificate',
    '--extractor-args', 'bilibili:getcomments=false',
    '--extractor-args', 'bilibili:getdanmaku=false'
  );

  args.push(url);
  return args;
}

// Bilibili 搜尋專用參數（僅 headers/cookies，不含下載/播放旗標）
function buildBilibiliSearchArgs() {
  const args = [];

  cookies.appendBilibiliCookieArgs(args);

  args.push(
    '--user-agent', BILIBILI_HEADERS['User-Agent'],
    '--referer',    BILIBILI_HEADERS['Referer'],
    '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
    '--add-header', `Accept:${BILIBILI_HEADERS['Accept']}`,
    '--no-check-certificate',
  );

  return args;
}

// YouTube 搜尋專用參數（僅 headers/proxy/cookies，不含下載旗標）
function buildYouTubeSearchArgs() {
  const args = [];

  if (WARP_PROXY) {
    args.push('--proxy', WARP_PROXY);
  }

  cookies.appendYouTubeCookieArgs(args);

  args.push(
    '--user-agent',   YOUTUBE_HEADERS['User-Agent'],
    '--add-header',   `Accept-Language:${YOUTUBE_HEADERS['Accept-Language']}`,
    '--no-check-certificate',
  );

  return args;
}

function buildInfoArgs(url) {
  const base = ['--dump-json', '--no-playlist', '--no-warnings', '--skip-download'];

  if (isYouTubeUrl(url)) {
    if (WARP_PROXY) {
      base.push('--proxy', WARP_PROXY);
    }
    base.push('--js-runtimes', 'node');

    const strategy = YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || YT_CLIENT_STRATEGIES[0];
    base.push(...strategy.args);

    if (strategy.name !== 'tv_simply') {
      cookies.appendYouTubeCookieArgs(base);
    }
    base.push('--user-agent', YOUTUBE_HEADERS['User-Agent'], '--no-check-certificate');
  } else {
    cookies.appendBilibiliCookieArgs(base);
    base.push(
      '--user-agent', BILIBILI_HEADERS['User-Agent'],
      '--referer',    BILIBILI_HEADERS['Referer'],
      '--add-header', `Origin:${BILIBILI_HEADERS['Origin']}`,
      '--no-check-certificate',
      '--extractor-args', 'bilibili:getcomments=false',
      '--extractor-args', 'bilibili:getdanmaku=false',
      '--sleep-requests',     '2',
      '--sleep-interval',     '2',
      '--max-sleep-interval', '5'
    );
  }

  base.push(url);
  return base;
}

module.exports = {
  buildYouTubeArgs, buildBilibiliArgs, buildBilibiliSearchArgs, buildYouTubeSearchArgs, buildInfoArgs,
};
