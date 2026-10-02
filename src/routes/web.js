'use strict';
// routes/web.js — 網頁播放器：靜態頁、登入／登出、曲目清單、音檔串流
const path = require('path');
const express = require('express');

const PUBLIC_DIR = path.join(require('../utils/rootDir'), 'public');

function mountWebRoutes(app, { store, auth }) {
  const { requireWebAuth, login, logout } = auth;

  app.get('/', (req, res) => res.redirect('/player'));
  app.use('/player-assets', express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));
  // Service Worker 必須由根路徑提供才能控制整個網站（離線開啟播放器頁面用）
  app.get('/player-sw.js', (req, res) => {
    res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
  });
  app.get('/player', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'player.html'));
  });

  // 只有這條路由解析 JSON body，音樂庫的 PUT 上傳仍是原始串流
  app.post('/web/login', express.json({ limit: '2kb' }), login);
  app.post('/web/logout', logout);

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

}

module.exports = { mountWebRoutes };
