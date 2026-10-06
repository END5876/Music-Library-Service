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
// 這個檔案只負責組裝與曲目清單／靜態頁／音檔串流；其餘拆在同資料夾：
//   webAuth.js         登入、Cookie、限流（POST /web/login、/web/logout）
//   onlineRoutes.js    線上串流 API（/web/api/capabilities|search|info、/web/play）
//   playlistRoutes.js  播放清單 API（/web/api/playlists/*）
//
// 路由：
//   GET  /player             播放器頁面（純靜態，不含任何音樂庫資料）
//   POST /web/login          { password } → 設定 Cookie
//   POST /web/logout         清除 Cookie
//   GET  /web/api/list       曲目清單（需登入）
//   GET  /web/stream/*       串流音檔，支援 Range 拖曳進度（需登入）
//
// 線上串流（YouTube / Bilibili，需要伺服器有 yt-dlp 與 ffmpeg；沒有就自動停用，不影響上面的功能）：
//   GET  /web/api/capabilities   { online: true|false }
//   GET  /web/api/search?q=      同時搜尋 YouTube + Bilibili
//   GET  /web/api/info?url=      取得影片資訊（標題／時長）
//   GET  /web/play?url=          播放：快取命中→檔案（可拖曳）；否則 yt-dlp 即時串流＋背景下載快取
//   WEB_ONLINE=0 可強制關閉線上串流。

const path = require('path');
const express = require('express');
const online = require('../ytdlp/onlineStream');
const { mountWebAuth } = require('./webAuth');
const { mountOnlineRoutes } = require('./onlineRoutes');
const { mountPlaylists } = require('./playlistRoutes');
const { mountUploadRoutes } = require('./uploadRoutes');

function mountWebPlayer(app, { store, libSecret }) {
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
      res.set('Cache-Control', 'no-store');
      res.json({ files: files.map(({ filename, name, size }) => ({ filename, name, size })) });
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
      res.sendFile(absPath, { headers: { 'Cache-Control': 'private, max-age=3600' } }, (err) => {
        if (err && !res.headersSent) {
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

  return true;
}

module.exports = { mountWebPlayer };
