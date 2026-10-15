'use strict';
// yt-dlp 參數組合的安全性：不關閉憑證驗證、不使用 generic extractor
const test = require('node:test');
const assert = require('node:assert/strict');
const antiBot = require('../ytdlp/musicAntiBot');

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD';

test('所有 yt-dlp 參數組合都不帶 --no-check-certificate；處理網址的都排除 generic extractor', () => {
  const withUrl = {
    youtubeStream: antiBot.buildYouTubeArgs(YT, antiBot.DEFAULT_YT_STRATEGY, true),
    youtubeDownload: antiBot.buildYouTubeArgs(YT, antiBot.DEFAULT_YT_STRATEGY, false),
    bilibiliStream: antiBot.buildBilibiliArgs(BILI, true),
    bilibiliDownload: antiBot.buildBilibiliArgs(BILI, false),
    youtubeInfo: antiBot.buildInfoArgs(YT),
    bilibiliInfo: antiBot.buildInfoArgs(BILI),
  };
  for (const [name, args] of Object.entries(withUrl)) {
    assert.ok(!args.includes('--no-check-certificate'), name);
    const i = args.indexOf('--use-extractors');
    assert.ok(i >= 0 && args[i + 1] === 'default,-generic', name);
    assert.ok(i < args.length - 1 && args[args.length - 1].startsWith('https://'), `${name}：網址在最後`);
  }
  for (const args of [antiBot.buildYouTubeSearchArgs(), antiBot.buildBilibiliSearchArgs()]) {
    assert.ok(!args.includes('--no-check-certificate'));
  }
});
