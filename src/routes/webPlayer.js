'use strict';
// routes/webPlayer.js
// ─────────────────────────────────────────────────────────────
// 瀏覽器音樂串流播放器（Web Player）的路由組裝。
//
// 為什麼另外做一組路由，而不是直接用 /api/music/*：
//   瀏覽器的 <audio src="..."> 沒辦法帶自訂 header（x-music-lib-key），
//   所以網頁改用「密碼登入 → HttpOnly Cookie」驗證；Bot 之間的內部 API 完全不受影響。
//
// 預設關閉：只有設定了 WEB_PLAYER_PASSWORD 才會掛載，避免服務一旦有公開網域
// 就意外把整個音樂庫曝露出去。
//
// 實際路由分散在：
//   routes/web.js        /player、/web/login、/web/logout、/web/api/list、/web/stream/*
//   routes/online.js     /web/api/capabilities|search|info、/web/play
//   routes/playlists.js  /web/api/playlists/*

const online = require('../services/ytdlp');
const { createWebAuth } = require('../middleware/webAuth');
const { mountWebRoutes } = require('./web');
const { mountOnlineRoutes } = require('./online');
const { mountPlaylists } = require('./playlists');

function mountWebPlayer(app, { store, libSecret }) {
  const password = process.env.WEB_PLAYER_PASSWORD || '';
  if (!password) return false;

  // 服務在反向代理後面：讓 req.ip / req.secure 取到真實值（只信任一層）
  app.set('trust proxy', 1);

  const auth = createWebAuth({ password, libSecret });

  mountWebRoutes(app, { store, auth });
  mountOnlineRoutes(app, { online, requireWebAuth: auth.requireWebAuth });
  mountPlaylists(app, { requireWebAuth: auth.requireWebAuth, online });

  return true;
}

module.exports = { mountWebPlayer };
