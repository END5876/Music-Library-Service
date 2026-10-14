'use strict';
// webplayer/webPlayer.js
// ─────────────────────────────────────────────────────────────
// 瀏覽器音樂串流播放器（Web Player）。
//
// 為什麼要另外做一組路由，而不是直接用 /api/music/*：
//   瀏覽器的 <audio src="..."> 沒辦法帶自訂 header（x-music-lib-key），
//   所以網頁改用「密碼登入 → HttpOnly Cookie」驗證；Bot 之間的內部 API
//   完全不受影響。
//
// 預設關閉：只有設定了 WEB_PLAYER_PASSWORD 才會掛載，避免服務一旦有公開網域
// 就意外把整個音樂庫曝露出去。
//
// 環境變數：見 webAuth.js（WEB_PLAYER_PASSWORD / WEB_SESSION_SECRET / WEB_SESSION_HOURS）
//
// 這個檔案只負責組裝與曲目清單／靜態頁／音檔串流；其餘拆在同資料夾（各檔開頭有自己的路由說明，完整清單見 README）：
//   webAuth.js         登入、Cookie、限流（POST /web/login、/web/logout）
//   onlineRoutes.js    線上串流 API（/web/api/capabilities|search|info、/web/play）
//   playlistRoutes.js  播放清單 API（/web/api/playlists/*）
//   uploadRoutes.js    受控音檔上傳（/upload?upload=1、/web/api/upload?upload=1）
//   durationStore.js   歌曲長度快取（ffprobe 讀取，/web/api/list 會帶上 duration）
//   libraryManageRoutes.js  音樂庫管理：移動（收藏到資料夾）／重新命名／刪除（/web/api/library/*）
//
// 本檔路由：
//   GET  /player             播放器頁面（純靜態，不含任何音樂庫資料）
//   GET  /web/api/list       曲目清單（需登入）
//   GET  /web/stream/*       串流音檔，支援 Range 拖曳進度（需登入）
//   GET  /web/api/status     服務狀態（需登入；內容同 /api/music/status，見 status.js）

const path = require('path');
const express = require('express');
const online = require('../ytdlp/onlineStream');
const { mountWebAuth } = require('./webAuth');
const { mountOnlineRoutes } = require('./onlineRoutes');
const { mountPlaylists } = require('./playlistRoutes');
const { mountUploadRoutes } = require('./uploadRoutes');
const { mountLibraryManageRoutes } = require('./libraryManageRoutes');
const durationStore = require('./durationStore');

function mountWebPlayer(app, { store, libSecret, status }) {
  const auth = mountWebAuth(app, { libSecret });
  if (!auth) return false;
  const { requireWebAuth } = auth;

  app.get('/', (req, res) => res.redirect('/player'));
  app.use('/player-assets', express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: 0 }));
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', 'manifest.webmanifest'));
  });
  // Service Worker 必須由根路徑提供才能控制整個網站（離線開啟播放器頁面用）
  app.get('/player-sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });
  app.get('/player', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', 'player.html'));
  });

  app.get('/web/api/list', requireWebAuth, async (req, res) => {
    try {
      const files = await store.listAll();
      // duration:歌曲長度(秒),還沒讀到的曲目不帶;durationsPending=true 表示背景還在讀,前端可稍後再要一次
      const { durations, pending } = durationStore.lookup(files, (fn) => store.resolveForRead(fn));
      res.set('Cache-Control', 'no-store');
      res.json({
        files: files.map(({ filename, name, size }) => {
          const duration = durations.get(filename);
          return duration ? { filename, name, size, duration } : { filename, name, size };
        }),
        durationsPending: pending,
      });
    } catch (err) {
      console.error('❌ [MusicLibrary] /web/api/list 失敗:', err);
      res.status(500).json({ error: '讀取音樂庫清單失敗' });
    }
  });

  // res.sendFile 內建 Range / If-Range / ETag，<audio> 拖曳進度靠它
  app.get('/web/stream/*', requireWebAuth, (req, res) => {
    try {
      const absPath = store.resolveForRead(req.params[0]);
      if (!absPath) return res.status(404).json({ error: '找不到檔案' });
      store.touchCache(absPath); // 播放＝使用中，延後被快取清理（LRU）
      res.sendFile(absPath, { headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
        if (err && !res.headersSent) {
          if (store.isNotFoundError(err)) return res.status(404).json({ error: '找不到檔案' });
          console.error('❌ [MusicLibrary] 串流失敗:', err.message);
          res.status(500).json({ error: '串流失敗' });
        }
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  mountOnlineRoutes(app, { requireWebAuth });

  mountPlaylists(app, { requireWebAuth, online });
  mountUploadRoutes(app, { store, requireWebAuth });
  mountLibraryManageRoutes(app, { store, requireWebAuth });

  if (status) {
    app.get('/web/api/status', requireWebAuth, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await status.collect());
    });
  }

  return true;
}

module.exports = { mountWebPlayer };
