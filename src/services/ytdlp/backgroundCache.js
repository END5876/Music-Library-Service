'use strict';
// ytdlp/backgroundCache.js — 串流的同時，背景下載快取並在完成後做響度正規化（同 Bot）
const path = require('path');
const cache = require('./cache');
const antiBot = require('./antiBot');
const normalizer = require('./normalizer');
const state = require('./state');

// 同一個 URL 同時間只會下載一次（state.downloadingUrls 為下載鎖）
function startBackgroundDownload(item, platform) {
  if (!state.downloadingUrls.has(item.url)) {
    state.downloadingUrls.add(item.url);

    console.log(`⬇️ [${platform}] 背景開始下載快取...`);

    const dlArgs = antiBot.isYouTubeUrl(item.url)
      ? antiBot.buildYouTubeArgs(
          item.url,
          antiBot.YT_CLIENT_STRATEGIES.find(s => s.name === 'default') || antiBot.YT_CLIENT_STRATEGIES[0],
          false,
        )
      : antiBot.buildBilibiliArgs(item.url, false);

    let lastProgress = 0;

    cache.downloadAndCache(
      item.url,
      item.title,
      dlArgs,
      (progress) => {
        if (progress - lastProgress >= 20) {
          lastProgress = progress;
          console.log(`⬇️ [${platform}] 背景下載進度: ${progress.toFixed(1)}%`);
        }
      },
    )
    .then((filePath) => {
      console.log(`✅ [Cache] 背景下載完成，已儲存至: ${path.basename(filePath)}`);

      // 下載完成後，背景自動進行響度正規化（不阻塞任何播放邏輯）
      // ※ Bot 版在正規化後會 pushToSharedLibrary；這個服務本身就是共用音樂庫，檔案已在庫內。
      normalizer.normalizeAudioFile(filePath)
        .then(() => {
          console.log(`🎚️ [Normalizer] 響度正規化完成: ${path.basename(filePath)}`);
        })
        .catch((err) => {
          console.warn(`⚠️ [Normalizer] 正規化失敗（略過，原檔仍可正常播放）: ${err.message}`);
        });
    })
    .catch((err) => {
      console.error(`⚠️ [Cache] 背景下載失敗: ${err.message}`);
    })
    .finally(() => {
      state.downloadingUrls.delete(item.url);
    });

  } else {
    console.log(`⏳ 此 URL 已經在背景下載中，跳過重複下載任務。`);
  }
}

module.exports = { startBackgroundDownload };
