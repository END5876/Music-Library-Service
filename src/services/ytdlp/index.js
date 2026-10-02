'use strict';
// ytdlp — YouTube / Bilibili 線上搜尋與串流。
//
// 播放流程與 Bot 完全相同（playStream）：
//   1. 查快取（getCachedPath）→ 命中：直接播放快取檔（_playFromFile）
//   2. 未命中 → _fallbackStream：yt-dlp 即時串流（YouTube 走 client 輪換策略）
//   3. 長度 ≤ 7 分鐘 → 同時背景下載快取（downloadingUrls 防重複）→ 下載完成後自動響度正規化
//      長度 > 7 分鐘 / 未知長度 / 直播 → 只串流，不下載
//   4. 錯誤 → _handleStreamError：連續錯誤計數 + 最多重試 3 次（間隔 3 秒）
// 常數（MAX_RETRIES / RETRY_DELAY / MAX_CONSECUTIVE_ERRORS / 7 分鐘 / 各種逾時）與 Bot 相同。
//
// 與 Bot 版本必要的差異（因為輸出對象從 Discord AudioPlayer 變成瀏覽器的 HTTP response）：
//   - 「送給播放器」改成「寫進 HTTP response」：
//       快取命中 → res.sendFile（支援 Range，可拖曳進度）
//       即時串流 → yt-dlp stdout 經 ffmpeg 轉成 mp3 後寫進 response
//                 （Bot 是把 stdout 交給 Discord 語音，由 ffmpeg 解碼；瀏覽器沒辦法直接播
//                   yt-dlp 吐出的原始 webm/m4a 管線串流，所以在這裡先用 ffmpeg 轉成 mp3）
//   - 第一個位元組送出前才寫 response header，因此串流一開始就失敗時，重試／輪換 client
//     的行為和 Bot 一樣，對瀏覽器來說只是「等比較久」
//   - 此服務本身就是共用音樂庫，下載＋正規化完的檔案已在庫內，沒有 pushToSharedLibrary 這一步
//   - 「guildId」換成固定 key 'web'（YouTube client 輪換與連續錯誤計數）
//   - 不註冊 process.on('uncaughtException')（會吞掉整個服務的未捕捉錯誤，不應由網頁模組決定）

const { init, isAvailable } = require('./env');
const { isAllowedUrl, cleanUrl } = require('../../utils/urlUtils');
const { getInfoCached } = require('./info');
const { searchMulti } = require('./search');
const { handlePlayRequest } = require('./request');

module.exports = {
  init,
  isAvailable,
  isAllowedUrl,
  cleanUrl,
  getInfo: getInfoCached,
  searchMulti,
  handlePlayRequest,
};
