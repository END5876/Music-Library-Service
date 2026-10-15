'use strict';
// botSync/routes.js
// ─────────────────────────────────────────────────────────────
// Bot ↔ 網頁「正在播放」同步的 HTTP 介面（狀態與指令佇列在 hub.js）。
//
// Bot 端（掛在 /api/music 底下，沿用內部金鑰 x-music-lib-key 與「公開但沒設金鑰就停用」的保護）：
//   PUT  /api/music/bots/:botId/state                 推送整份狀態 { name, guilds:[...] }
//   DELETE /api/music/bots/:botId/state               Bot 關閉前通知下線
//   GET  /api/music/bots/:botId/commands?wait=25      長輪詢拿指令 → { commands:[{ id, guildId, action, ... }] }
//   POST /api/music/bots/:botId/commands/:id/result   回報執行結果 { ok, message }
//
// 網頁端（需登入）：
//   GET  /web/api/bots                                目前各 Bot／各伺服器的播放狀態
//   GET  /web/api/bots/events                         SSE：狀態有變就推一次（event: state）
//   POST /web/api/bots/:botId/command                 { guildId, action, ... } → 等 Bot 回報 { ok, message }
//     action：skip | stop | clearQueue
//             loop { mode: off|one|all } | randomPlay { on } | removeQueue { index, key }
//             enqueue { item: { kind:'lib', filename } | { kind:'online', url, title?... }, next? }
//             enqueueMany { items:[...同上], next? }   一次最多 500 首；找不到的檔案、不支援的網址略過不計
//               （線上歌曲直接用帶來的標題／作者／長度，Bot 不逐首跑 yt-dlp，同 /play 匯入播放清單的做法）

const express = require('express');
const { LOOP_MODES } = require('./hub');

const MAX_SSE_CLIENTS = 50;
const MAX_BATCH = 500;
const SSE_PING_MS = 20 * 1000;

function mountBotApi(app, { hub }) {
  const json = express.json({ limit: '256kb' });

  app.put('/api/music/bots/:botId/state', json, (req, res) => {
    try {
      hub.putState(req.params.botId, req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Bot 關閉前通知下線（重新部署、重啟）：網頁立刻顯示離線，排隊中的指令直接失敗
  app.delete('/api/music/bots/:botId/state', (req, res) => {
    res.json({ ok: hub.markOffline(req.params.botId) });
  });

  app.get('/api/music/bots/:botId/commands', async (req, res) => {
    const { botId } = req.params;
    // Bot 中斷這條長輪詢（重啟、逾時）：結束等待，之後的指令留給下一條連線
    // （用 res 的 close：新版 Node 的 req 在請求本體讀完時就可能觸發 close）
    const token = {};
    res.on('close', () => { if (!res.writableEnded) hub.cancelWait(botId, token); });
    try {
      const commands = await hub.takeCommands(botId, Number(req.query.wait) * 1000, token);
      if (res.destroyed) {
        // 指令已經從佇列拿出來、連線卻斷了：放回去，否則這些指令就默默消失，網頁只會等到逾時
        hub.requeue(botId, commands.map((c) => c.id));
        return;
      }
      res.set('Cache-Control', 'no-store');
      res.json({ commands });
    } catch (err) {
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/music/bots/:botId/commands/:id/result', json, (req, res) => {
    const ok = hub.reportResult(req.params.botId, req.params.id, req.body);
    res.json({ ok });
  });
}

function mountWebApi(app, { hub, requireWebAuth, store, isAllowedUrl, cleanUrl }) {
  const json = express.json({ limit: '256kb' }); // 批量點歌最多 500 首
  const s = (v, max) => String(v || '').slice(0, max);
  // 送給 Bot 的文字（歌名、作者）可能被 Bot 原樣貼到 Discord：在 @ 後面插入零寬空白，
  // 讓「@everyone」「<@使用者ID>」之類的字不會變成真的提及（畫面上看起來不變）
  const t = (v, max) => s(v, max).replace(/@/g, '@\u200b');

  // 網頁點的一首歌 → 送給 Bot 的乾淨格式；不存在的檔案、不支援的網址回傳 null
  async function cleanRequestItem(it) {
    if (!it || typeof it !== 'object') return null;
    if (it.kind === 'lib') {
      const info = await store.exists(s(it.filename, 1000)).catch(() => ({ exists: false }));
      return info.exists ? { kind: 'lib', filename: info.filename, title: t(it.title, 200) } : null;
    }
    if (it.kind === 'online') {
      const url = cleanUrl(s(it.url, 500));
      if (!isAllowedUrl(url)) return null;
      return { kind: 'online', url, title: t(it.title, 200), author: t(it.author, 100), duration: s(it.duration, 20) };
    }
    return null;
  }

  app.get('/web/api/bots', requireWebAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ bots: hub.snapshot() });
  });

  app.get('/web/api/bots/events', requireWebAuth, (req, res) => {
    if (hub.subscriberCount() >= MAX_SSE_CLIENTS) return res.status(503).json({ error: '連線數已滿' });
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    const send = (snap) => res.write(`event: state\ndata: ${JSON.stringify({ bots: snap })}\n\n`);
    send(hub.snapshot());
    const unsubscribe = hub.subscribe(send);
    // 註解行當心跳：讓反向代理不會因為閒置而切斷連線，也讓瀏覽器盡快發現斷線
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    res.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  // 指令參數全部在這裡驗證，送到 Bot 的只會是乾淨的值
  async function buildArgs(action, b) {
    switch (action) {
      case 'skip': case 'stop': case 'clearQueue':
        return {};
      case 'loop':
        if (!LOOP_MODES.includes(b.mode)) throw new Error('不合法的循環模式');
        return { mode: b.mode };
      case 'randomPlay':
        return { on: !!b.on };
      case 'removeQueue': {
        const index = Number(b.index);
        if (!Number.isInteger(index) || index < 0 || index > 100000) throw new Error('不合法的位置');
        return { index, key: typeof b.key === 'string' ? b.key.slice(0, 600) : '' };
      }
      case 'enqueue': {
        const it = b.item || {};
        const item = await cleanRequestItem(it);
        if (!item) throw new Error(it.kind === 'lib' ? '音樂庫裡找不到這首歌' : it.kind === 'online' ? '只支援 YouTube / Bilibili 網址' : '不支援的歌曲格式');
        return { item, next: !!b.next };
      }
      case 'enqueueMany': {
        if (!Array.isArray(b.items) || !b.items.length) throw new Error('沒有要加入的歌曲');
        if (b.items.length > MAX_BATCH) throw new Error(`一次最多 ${MAX_BATCH} 首`);
        const items = [];
        for (let i = 0; i < b.items.length; i += 64) { // 分批並行 stat，維持原本順序
          for (const it of await Promise.all(b.items.slice(i, i + 64).map(cleanRequestItem))) if (it) items.push(it);
        }
        if (!items.length) throw new Error('找不到可加入的歌曲（檔案不存在或網址不支援）');
        return { items, next: !!b.next, skipped: b.items.length - items.length };
      }
      default:
        throw new Error('不支援的操作');
    }
  }

  app.post('/web/api/bots/:botId/command', requireWebAuth, json, async (req, res) => {
    const b = req.body || {};
    let args;
    try {
      args = await buildArgs(b.action, b);
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    const result = await hub.submitCommand(req.params.botId, String(b.guildId || ''), b.action, args);
    res.set('Cache-Control', 'no-store');
    res.status(result.status || 200).json({ ok: result.ok, message: result.message });
  });
}

module.exports = { mountBotApi, mountWebApi };
