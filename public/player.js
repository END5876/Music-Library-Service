'use strict';
// player.js — 網頁播放器的進入點：其他檔案都載入後，從這裡開始初始化。
// 播放器的狀態由下列檔案共用，跨檔的變數與函式放在 window.MLPlayer（各檔裡簡稱 P），同一檔內的直接用名稱。
// 載入順序（player.html 的 <script> 與 sw.js 的 SHELL_URLS 都要照這個順序列出）：
//   playerState.js      共用狀態與偏好、背景播放 helper
//   playerAccount.js    登入、帳號選單
//   playerLibrary.js    封面、列表元件（makeRow）、多選、音樂庫清單
//   playerQueue.js      目前播放資訊、隨機佇列、佇列畫面、拖曳排序
//   playerPlayback.js   播放（play／advance／prev）、audio 事件、斷線與補救
//   playerControls.js   控制項、全螢幕播放頁、鍵盤、頁籤切換
//   playerSource.js     線上搜尋與串流、離線儲存、預載、載入音源
//   playerDownloads.js  離線下載、離線模式、更新提示
//   playerPlaylists.js  播放清單與離線歌曲頁
//   playerMenus.js      ⋮ 選單、音樂庫管理、播放清單卡片
//   player.js           初始化
// 後面的檔案可以在載入時用前面的；前面的只能在函式裡（之後才執行）用後面的。
// 不碰這些狀態的獨立檔案要更早載入：offlineStore.js（IndexedDB）、downloader.js（下載引擎）、
//   playerUi.js（提示訊息、返回鍵層級、對話框）、playerDebug.js（除錯模式）、playerPlatform.js（Android 判斷、靜音保活）、
//   playerGestures.js（手機手勢）、playerBots.js（「Bot 正在播放」頁籤）、playerUpload.js（上傳頁籤）
(() => {
  const P = window.MLPlayer;
  const { $ } = window.MLUi;

  // ── 初始化 ──
  P.syncButtons();
  P.setNow(null);
  P.updateProgress();
  P.updatePlayIcons();
  // 清單請求與離線清單掃描同時進行;等離線清單讀完才畫畫面,才能正確標示已下載的歌
  const listReq = fetch('/web/api/list');
  listReq.catch(() => {}); // 失敗交給 loadList 處理,這裡只避免「未處理的 Promise 錯誤」
  window.MLGestures.setupGestures({ $, libSel: P.libSel, plSel: P.plSel, setLibSelecting: P.setLibSelecting, setPlSelecting: P.setPlSelecting, isFullOpen: P.isFullOpen, openFull: P.openFull, closeFull: P.closeFull, advance: P.advance, prev: P.prev });

  P.offlineInit().finally(() => { P.updateNetState(); P.loadList(listReq); });
  // 「點給 Bot 播放」選單項目只在有 Bot 在語音頻道時出現:頁面開著時每分鐘更新一次(Bot 頁籤開著時由 SSE 即時更新)
  setInterval(() => { if (!document.hidden && P.me.admin && P.mode !== 'bots' && $('acctBtn').hidden === false) P.bots.refresh(); }, 60 * 1000);
  P.registerSW();
})();
