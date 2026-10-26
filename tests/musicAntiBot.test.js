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

test('錯誤分類只認真正的 HTTP 狀態碼：影片 ID／BV 號裡的數字不會被當成 403、412', () => {
  // 影片 ID 剛好含 403、412：以前 includes('403') 會判成「禁止存取」並輪換 client
  const ytNoise = 'ERROR: [youtube] abc403xyz12: Some other failure';
  assert.equal(antiBot.classifyYouTubeError(ytNoise).type, 'UNKNOWN');
  assert.equal(antiBot.classifyYouTubeError('ERROR: unable to download video data: HTTP Error 403: Forbidden').type, 'FORBIDDEN_403');
  assert.equal(antiBot.classifyYouTubeError('ERROR: HTTP Error 429: Too Many Requests').type, 'RATE_LIMITED');
  assert.equal(antiBot.classifyYouTubeError('ERROR: [youtube] x: Sign in to confirm you are not a bot').type, 'BOT_DETECTED');

  assert.match(antiBot.classifyBilibiliError('ERROR: [BiliBili] BV1412xx403: HTTP Error 412: Precondition Failed').msg, /412/);
  // 只有 BV 號含 412 時是未知錯誤，訊息取最後一行 ERROR
  const bili = antiBot.classifyBilibiliError('[BiliBili] BV1412xx403: Downloading webpage\nERROR: [BiliBili] BV1412xx403: something broke');
  assert.equal(bili.msg, '未知錯誤: ERROR: [BiliBili] BV1412xx403: something broke');
  assert.equal(antiBot.classifyBilibiliError('ERROR: Unsupported URL: https://example.com').msg, '不支援的網址');
});
