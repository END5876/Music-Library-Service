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

const express = require('express');
const { LOOP_MODES } = require('./hub');

const MAX_SSE_CLIENTS = 50;
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
    res.on('close', () => { if (!res.writableEnded) hub.cancelWait(botId); });
    try {
      const commands = await hub.takeCommands(botId, Number(req.query.wait) * 1000);
      if (res.destroyed) return;
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
  const json = express.json({ limit: '16kb' });

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
        const next = !!b.next;
        if (it.kind === 'lib') {
          const info = await store.exists(String(it.filename || '')).catch(() => ({ exists: false }));
          if (!info.exists) throw new Error('音樂庫裡找不到這首歌');
          return { item: { kind: 'lib', filename: info.filename, title: String(it.title || '').slice(0, 200) }, next };
        }
        if (it.kind === 'online') {
          const url = cleanUrl(String(it.url || '').slice(0, 500));
          if (!isAllowedUrl(url)) throw new Error('只支援 YouTube / Bilibili 網址');
          return { item: { kind: 'online', url, title: String(it.title || '').slice(0, 200) }, next };
        }
        throw new Error('不支援的歌曲格式');
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
