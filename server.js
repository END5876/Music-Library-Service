'use strict';
// server.js
// ─────────────────────────────────────────────────────────────
// 共用音樂庫服務（Music Library Service）
//
// 獨立部署、獨立維護的服務，不含任何 Discord 邏輯，只做一件事：
// 掛著唯一一顆「音樂庫 Volume」，透過內部 HTTP API 讓多個 Bot（不同
// repo、不同服務）都能讀取／寫入同一份音樂庫。
//
// 環境變數：
//   PORT               監聽埠，Zeabur 會自動注入
//   MUSIC_DIR          音樂庫掛載路徑，預設 <repo root>/data/music
//   MUSIC_LIB_SECRET   保護 API 的共用金鑰，呼叫端要帶相同的值
//   MAX_CACHE_SIZE_MB  cache/ 子資料夾的容量上限，預設 2048
//   WEB_PLAYER_PASSWORD  網頁播放器登入密碼（不設定＝不啟用網頁播放器）
//
// API：
//   GET  /health                                   健康檢查（不驗證金鑰）
//   GET  /api/music/list                           列出整個音樂庫（filename / name / size）
//   GET  /api/music/exists?filename=                檢查指定 filename 是否已存在
//   GET  /api/music/file/*                          下載檔案內容（* 是相對於音樂庫根目錄的路徑）
//   PUT  /api/music/file/*                          上傳／覆寫檔案內容（原始位元組，不做任何解析）
//
// 網頁播放器（設定 WEB_PLAYER_PASSWORD 才啟用，細節見 webPlayer.js）：
//   GET  /player                                   播放器頁面
//   POST /web/login | /web/logout                  密碼登入／登出（Cookie）
//   GET  /web/api/list                             曲目清單（需登入）
//   GET  /web/stream/*                             串流音檔，支援 Range（需登入）
//
// 這個服務刻意不提供播放次數功能：每個呼叫端 Bot 各自計算、各自
// 記錄自己的播放次數，不透過這裡同步或集中管理。
//
// filename 的路徑分隔一律使用 '/'。

require('dotenv').config();
const express = require('express');
const store = require('./musicStore');
const { createLibraryKeyMiddleware } = require('./auth');
const { mountWebPlayer } = require('./webPlayer');

const PORT = process.env.PORT || 4100;
const SECRET = process.env.MUSIC_LIB_SECRET || '';

const app = express();

// 健康檢查放在金鑰驗證之前 —— 部署平台的健康檢查探針不會帶金鑰，
// 這條路由本身也不洩漏任何音樂庫內容。
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/music', createLibraryKeyMiddleware(SECRET));

// 網頁播放器：走自己的 Cookie 驗證，不影響上面 Bot 用的 /api/music/*
const webPlayerEnabled = mountWebPlayer(app, { store, libSecret: SECRET });

// ── 清單 ──────────────────────────────────────────────────
app.get('/api/music/list', async (req, res) => {
  try {
    const files = await store.listAll();
    res.json({ files });
  } catch (err) {
    console.error('❌ [MusicLibrary] /list 失敗:', err);
    res.status(500).json({ error: '讀取音樂庫清單失敗' });
  }
});

// ── 存在檢查 ──────────────────────────────────────────────
app.get('/api/music/exists', async (req, res) => {
  try {
    const info = await store.exists(req.query.filename);
    res.json(info);
  } catch (err) {
    res.status(400).json({ exists: false, error: err.message });
  }
});

// ── 下載 ──────────────────────────────────────────────────
app.get('/api/music/file/*', (req, res) => {
  try {
    const absPath = store.resolveForRead(req.params[0]);
    if (!absPath) return res.status(404).json({ error: '找不到檔案' });
    res.sendFile(absPath, (err) => {
      if (err && !res.headersSent) {
        console.error('❌ [MusicLibrary] 下載檔案失敗:', err.message);
        res.status(500).json({ error: '下載檔案失敗' });
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── 上傳（原始位元組 body，不用 body-parser，直接串流寫檔）────
app.put('/api/music/file/*', (req, res) => {
  store.writeFileFromStream(req.params[0], req)
    .then(({ relPath }) => res.json({ ok: true, filename: relPath }))
    .catch((err) => {
      console.error('❌ [MusicLibrary] 寫入檔案失敗:', err.message);
      if (!res.headersSent) res.status(400).json({ error: err.message });
    });
});

app.listen(PORT, () => {
  console.log(`✅ [MusicLibrary] 共用音樂庫服務已啟動，監聽埠 ${PORT}（音樂庫路徑: ${store.MUSIC_DIR}）`);
  if (!SECRET) {
    console.warn('⚠️ [MusicLibrary] 尚未設定 MUSIC_LIB_SECRET，任何連得到這個服務的請求都能讀寫音樂庫，僅建議在完全信任的內網環境這樣使用');
  }
  if (webPlayerEnabled) {
    console.log('🎧 [MusicLibrary] 網頁播放器已啟用: /player');
    if (!SECRET) {
      console.warn('⚠️ [MusicLibrary] 網頁播放器已啟用但沒有設定 MUSIC_LIB_SECRET：公開網域下 /api/music/* 會完全開放讀寫，請務必設定');
    }
  }
});
