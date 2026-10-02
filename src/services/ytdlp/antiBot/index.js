'use strict';
// antiBot — Bilibili & YouTube 防爬蟲邏輯（Headers 偽裝、Cookies、參數組合、錯誤分類、client 輪換）
// 移植自 Mousebot handlers/musicplayer/musicAntiBot.js，對外介面與拆分前相同。
//
// 與 Bot 版本的差異：
//   - Cookies 檔案位置預設為 <repo root>/data/，可用環境變數 YTDLP_COOKIES_DIR 覆寫
//     （例如指到掛載 Volume 的路徑，避免重新部署後 cookies 消失）
//   - 移除網頁用不到的 buildPlaylistCheckArgs（網頁沒有播放清單流程）
const { isYouTubeUrl } = require('../../../utils/urlUtils');

module.exports = {
  isYouTubeUrl,
  ...require('./cookies'),
  ...require('./clients'),
  ...require('./args'),
  ...require('./errors'),
};
