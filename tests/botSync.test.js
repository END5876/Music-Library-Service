'use strict';
// Bot ↔ 網頁同步：hub 的狀態清理、長輪詢、指令結果；HTTP 路由的驗證與 SSE
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
const store = require('../musicStore');
const { createHub } = require('../botSync/hub');
const { mountBotApi, mountWebApi } = require('../botSync/routes');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');

touch(MUSIC, 'fav/歌.mp3');

const hubs = [];
const newHub = (opts) => { const h = createHub(opts); hubs.push(h); return h; };
const servers = [];
test.after(() => {
  for (const h of hubs) h.close();
  for (const s of servers) s.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

const GUILD = {
  guildId: '123456789012345678', guildName: '測試伺服器', voiceChannel: '音樂',
  current: { kind: 'lib', filename: 'fav/歌.mp3', title: '歌' },
  status: 'playing', positionMs: 10000, queue: [{ kind: 'online', url: 'https://youtu.be/x', title: 'X', platform: 'YouTube' }],
  queueLength: 1, loopMode: 'all', randomPlay: false,
};

test('putState：清理輸入（不合法的伺服器、曲目、欄位會被丟掉或改成預設值）', () => {
  const hub = newHub();
  hub.putState('mousebot', {
    name: 'Mouse\u0000bot',
    guilds: [
      GUILD,
      { guildId: 'not-a-snowflake' },
      { guildId: '1', current: { kind: 'online', url: 'javascript:alert(1)' }, status: 'weird', loopMode: 'x', queue: [{ kind: 'bad' }] },
    ],
  });
  const [b] = hub.snapshot();
  assert.equal(b.name, 'Mouse bot');
  assert.equal(b.online, true);
  assert.equal(b.guilds.length, 2);
  const g = b.guilds[1];
  assert.equal(g.current, null, '非 https 網址丟掉');
  assert.equal(g.status, 'idle');
  assert.equal(g.loopMode, 'off');
  assert.deepEqual(g.queue, []);
  assert.equal(g.voice, '', '不認得的語音狀態清成空字串');
  hub.putState('mousebot', { guilds: [{ ...GUILD, voice: 'disconnected' }] });
  assert.equal(hub.snapshot()[0].guilds[0].voice, 'disconnected');
  assert.throws(() => hub.putState('bad id!', {}), /Bot ID/);
});

test('snapshot：播放中的位置會加上推送後經過的時間；超過 90 秒沒消息視為離線', () => {
  let t = 1_000_000;
  const hub = newHub({ now: () => t });
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  t += 5000;
  assert.equal(hub.snapshot()[0].guilds[0].positionMs, 15000);
  t += 90_000;
  const [b] = hub.snapshot();
  assert.equal(b.online, false);
  assert.deepEqual(b.guilds, [], '離線的 Bot 不顯示過期的播放狀態');
});

test('心跳：內容沒變、播放位置跟推算一致時不通知網頁；有變動、位置跳動、從離線恢復才通知', async () => {
  let t = 1_000_000;
  const hub = newHub({ now: () => t });
  let pushes = 0;
  hub.subscribe(() => { pushes++; });
  const flush = () => new Promise((r) => setTimeout(r, 250)); // 廣播會合併 200ms
  const state = (positionMs, extra = {}) => ({ name: 'B1', guilds: [{ ...GUILD, positionMs, ...extra }] });

  hub.putState('b1', state(10_000)); await flush();
  assert.equal(pushes, 1, '第一次推送');
  t += 30_000; hub.putState('b1', state(40_500)); await flush();
  assert.equal(pushes, 1, '心跳：位置與推算差 0.5 秒 → 不通知');
  assert.equal(hub.snapshot()[0].guilds[0].positionMs, 40_500, '但存下最新位置');
  t += 30_000; hub.putState('b1', state(5_000)); await flush();
  assert.equal(pushes, 2, '位置跳動（例如重播）→ 通知');
  t += 1_000; hub.putState('b1', state(6_000, { loopMode: 'one' })); await flush();
  assert.equal(pushes, 3, '內容變了 → 通知');
  hub.markOffline('b1'); await flush();
  t += 1_000; hub.putState('b1', state(7_000, { loopMode: 'one' })); await flush();
  assert.equal(pushes, 5, '下線、重新上線各通知一次');
});

test('長輪詢：沒有指令時等待，網頁送指令就立刻收到；Bot 回報結果後網頁拿到', async () => {
  const hub = newHub();
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  const poll = hub.takeCommands('b1', 5000);
  const result = hub.submitCommand('b1', GUILD.guildId, 'loop', { mode: 'one' });
  const cmds = await poll;
  assert.equal(cmds.length, 1);
  assert.deepEqual({ ...cmds[0], id: undefined }, { id: undefined, guildId: GUILD.guildId, action: 'loop', mode: 'one' });
  assert.equal(hub.reportResult('b1', cmds[0].id, { ok: true, message: '🔂 單曲循環已開啟' }), true);
  assert.deepEqual(await result, { ok: true, message: '🔂 單曲循環已開啟' });
  assert.equal(hub.reportResult('b1', cmds[0].id, { ok: true }), false, '同一個指令只能回報一次');
});

test('submitCommand：離線、不存在、不合法的操作直接回錯誤，不排進佇列', async () => {
  let t = 0;
  const hub = newHub({ now: () => t });
  assert.equal((await hub.submitCommand('nope', GUILD.guildId, 'skip')).status, 404);
  hub.putState('b1', { name: 'B1', guilds: [] });
  assert.equal((await hub.submitCommand('b1', GUILD.guildId, 'format-disk')).status, 400);
  assert.equal((await hub.submitCommand('b1', 'abc', 'skip')).status, 400);
  t += 100_000;
  assert.equal((await hub.submitCommand('b1', GUILD.guildId, 'skip')).status, 409);
  assert.deepEqual(await hub.takeCommands('b1', 0), []);
});

test('takeCommands：Bot 沒來拿的指令過期後丟棄並通知網頁', async () => {
  let t = 0;
  const hub = newHub({ now: () => t });
  hub.putState('b1', { guilds: [] });
  const r = hub.submitCommand('b1', GUILD.guildId, 'skip');
  t += 31_000;
  hub.putState('b1', { guilds: [] }); // 仍在線（有推送），但沒來拿指令
  assert.deepEqual(await hub.takeCommands('b1', 0), []);
  assert.match((await r).message, /沒有及時取得/);
});

test('markOffline（Bot 重啟前通知）：立刻離線、排隊的指令失敗；重新推送狀態後恢復', async () => {
  const hub = newHub();
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  const queued = hub.submitCommand('b1', GUILD.guildId, 'skip');
  const poll = hub.takeCommands('b1', 5000); // 已經被喚醒拿走 skip，再開一條模擬舊行程掛著的長輪詢
  assert.equal((await poll).length, 1);
  const r2 = hub.submitCommand('b1', GUILD.guildId, 'stop');
  const hanging = hub.takeCommands('b1', 5000);
  assert.equal((await hanging).length, 1, 'stop 被送進舊連線');
  const r3 = hub.submitCommand('b1', GUILD.guildId, 'clearQueue'); // 這個還在排隊

  assert.equal(hub.markOffline('b1'), true);
  assert.equal(hub.snapshot()[0].online, false);
  assert.match((await r3).message, /重新啟動或已離線/);
  assert.equal((await hub.submitCommand('b1', GUILD.guildId, 'skip')).status, 409);

  // 新行程上線：先輪詢（不會讓它恢復在線）、再推送狀態才恢復
  await hub.takeCommands('b1', 0);
  assert.equal(hub.snapshot()[0].online, false);
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  assert.equal(hub.snapshot()[0].online, true);
  assert.deepEqual(await hub.takeCommands('b1', 0), [], '舊指令不會在重啟後被執行');
  void queued; void r2; // 這兩個已送進舊行程的長輪詢，結果由 20 秒逾時處理，這裡不等
});

test('指令逾時：Bot 還沒拿走就撤回（重新連上也不會執行）；已拿走的說明可能仍會執行', async (t) => {
  const hub = newHub({ resultTimeoutMs: 50 });
  // 逾時計時器有 unref（不讓它撐住服務行程）：測試期間另外掛一個計時器，事件迴圈才不會提早結束
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  const notTaken = await hub.submitCommand('b1', GUILD.guildId, 'skip');
  assert.match(notTaken.message, /已取消/);
  assert.deepEqual(await hub.takeCommands('b1', 0), [], '逾時的指令不在佇列裡');

  const taken = hub.submitCommand('b1', GUILD.guildId, 'stop');
  assert.equal((await hub.takeCommands('b1', 0)).length, 1);
  assert.match((await taken).message, /可能仍會執行/);
});

test('同一個 Bot 開新的長輪詢時，舊的那條結束（回傳空陣列）', async () => {
  const hub = newHub();
  const old = hub.takeCommands('b1', 5000);
  const fresh = hub.takeCommands('b1', 50);
  assert.deepEqual(await old, []);
  assert.deepEqual(await fresh, []);
});

// ── HTTP ─────────────────────────────────────────────────
async function serve() {
  const hub = newHub();
  const app = express();
  mountBotApi(app, { hub });
  let authed = true;
  const requireWebAuth = (req, res, next) => (authed ? next() : res.status(401).json({ error: '請先登入' }));
  mountWebApi(app, { hub, requireWebAuth, store, isAllowedUrl, cleanUrl });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return { hub, base: `http://127.0.0.1:${server.address().port}`, setAuthed: (v) => { authed = v; } };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP：Bot 推送 → 網頁看得到；網頁點歌 → Bot 長輪詢拿到乾淨的參數 → 回報結果', async () => {
  const { base } = await serve();
  const put = await fetch(base + '/api/music/bots/mb/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mousebot', guilds: [GUILD] }),
  });
  assert.equal(put.status, 200);
  const list = await (await fetch(base + '/web/api/bots')).json();
  assert.equal(list.bots[0].guilds[0].guildName, '測試伺服器');

  const poll = fetch(base + '/api/music/bots/mb/commands?wait=5').then((r) => r.json());
  const web = post(base + '/web/api/bots/mb/command', {
    guildId: GUILD.guildId, action: 'enqueue', next: true,
    item: { kind: 'online', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD&t=10', title: 'Rick', extra: 'x' },
  });
  const { commands } = await poll;
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].item, { kind: 'online', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', title: 'Rick', author: '', duration: '' }, '經 cleanUrl 去掉 list，不認得的欄位不轉送');
  assert.equal(commands[0].next, true);
  await post(`${base}/api/music/bots/mb/commands/${commands[0].id}/result`, { ok: true, message: '已加入佇列' });
  const res = await web;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: '已加入佇列' });
});

test('HTTP：批量點歌 enqueueMany —— 驗證每一首、保持順序、略過的數量一起送給 Bot；上限 500 首', async () => {
  const { base } = await serve();
  await fetch(base + '/api/music/bots/mb/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"guilds":[]}' });
  const poll = fetch(base + '/api/music/bots/mb/commands?wait=5').then((r) => r.json());
  const web = post(base + '/web/api/bots/mb/command', {
    guildId: GUILD.guildId, action: 'enqueueMany', next: true,
    items: [
      { kind: 'lib', filename: 'fav/歌.mp3', title: '歌' },
      { kind: 'lib', filename: 'missing.mp3' },
      { kind: 'online', url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'B', author: 'UP', duration: '4:01', evil: 1 },
      { kind: 'online', url: 'https://evil.example/x' },
      { kind: 'weird' },
    ],
  });
  const { commands } = await poll;
  assert.equal(commands[0].action, 'enqueueMany');
  assert.equal(commands[0].next, true);
  assert.equal(commands[0].skipped, 3);
  assert.deepEqual(commands[0].items, [
    { kind: 'lib', filename: 'fav/歌.mp3', title: '歌' },
    { kind: 'online', url: 'https://www.bilibili.com/video/BV1xx411c7mD', title: 'B', author: 'UP', duration: '4:01' },
  ]);
  await post(`${base}/api/music/bots/mb/commands/${commands[0].id}/result`, { ok: true, message: '已送出 2 首' });
  assert.equal((await (await web).json()).message, '已送出 2 首');

  const tooMany = Array.from({ length: 501 }, () => ({ kind: 'lib', filename: 'fav/歌.mp3' }));
  assert.equal((await post(base + '/web/api/bots/mb/command', { guildId: GUILD.guildId, action: 'enqueueMany', items: tooMany })).status, 400);
  const noneValid = await post(base + '/web/api/bots/mb/command', { guildId: GUILD.guildId, action: 'enqueueMany', items: [{ kind: 'lib', filename: 'missing.mp3' }] });
  assert.equal(noneValid.status, 400);
  assert.match((await noneValid.json()).message, /找不到可加入/);
});

test('HTTP：網頁指令驗證（不存在的檔案、不支援的網址、錯誤的循環模式）與登入', async () => {
  const { base, setAuthed } = await serve();
  await fetch(base + '/api/music/bots/mb/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"guilds":[]}' });
  const cases = [
    { action: 'enqueue', item: { kind: 'lib', filename: 'missing.mp3' } },
    { action: 'enqueue', item: { kind: 'lib', filename: '../etc/passwd' } },
    { action: 'enqueue', item: { kind: 'online', url: 'https://evil.example/x' } },
    { action: 'loop', mode: 'forever' },
    { action: 'removeQueue', index: -1 },
  ];
  for (const c of cases) {
    const r = await post(base + '/web/api/bots/mb/command', { guildId: GUILD.guildId, ...c });
    assert.equal(r.status, 400, JSON.stringify(c));
  }
  setAuthed(false);
  try {
    assert.equal((await fetch(base + '/web/api/bots')).status, 401);
    assert.equal((await post(base + '/web/api/bots/mb/command', { guildId: GUILD.guildId, action: 'skip' })).status, 401);
  } finally { setAuthed(true); }
});

test('HTTP：SSE 連上就收到目前狀態，Bot 推送後再收到一次', async () => {
  const { base } = await serve();
  const ac = new AbortController();
  const r = await fetch(base + '/web/api/bots/events', { signal: ac.signal });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const nextEvent = async () => {
    while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value, { stream: true });
    const i = buf.indexOf('\n\n');
    const ev = buf.slice(0, i); buf = buf.slice(i + 2);
    return JSON.parse(ev.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  };
  assert.deepEqual((await nextEvent()).bots, []);
  await fetch(base + '/api/music/bots/mb/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Mousebot', guilds: [GUILD] }),
  });
  const ev = await nextEvent();
  assert.equal(ev.bots[0].name, 'Mousebot');
  ac.abort();
});

test('cancelWait 帶 token：舊連線晚一點才斷，不會把新的長輪詢一起結束', async () => {
  const hub = newHub();
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  const oldToken = {}, newToken = {};
  const old = hub.takeCommands('b1', 5000, oldToken);
  const fresh = hub.takeCommands('b1', 5000, newToken);
  assert.deepEqual(await old, []);
  hub.cancelWait('b1', oldToken); // 舊連線的 close 事件
  const r = hub.submitCommand('b1', GUILD.guildId, 'skip');
  const cmds = await fresh;
  assert.equal(cmds.length, 1, '新的長輪詢仍然拿得到指令');
  hub.reportResult('b1', cmds[0].id, { ok: true });
  assert.equal((await r).ok, true);
});

test('requeue：指令拿出來後連線斷掉 → 放回佇列最前面，下一條長輪詢照順序拿到', async () => {
  const hub = newHub();
  hub.putState('b1', { name: 'B1', guilds: [GUILD] });
  const r1 = hub.submitCommand('b1', GUILD.guildId, 'skip');
  const r2 = hub.submitCommand('b1', GUILD.guildId, 'stop');
  const lost = await hub.takeCommands('b1', 0);
  assert.equal(lost.length, 2);
  const r3 = hub.submitCommand('b1', GUILD.guildId, 'clearQueue');
  assert.equal(hub.requeue('b1', lost.map((c) => c.id)), 2);
  assert.equal(hub.requeue('b1', lost.map((c) => c.id)), 0, '同一批不會放回兩次');
  const again = await hub.takeCommands('b1', 0);
  assert.deepEqual(again.map((c) => c.action), ['skip', 'stop', 'clearQueue']);
  for (const c of again) hub.reportResult('b1', c.id, { ok: true });
  assert.deepEqual((await Promise.all([r1, r2, r3])).map((x) => x.ok), [true, true, true]);
  assert.equal(hub.requeue('b1', [again[0].id]), 0, '已回報結果的指令不放回');
});

test('HTTP：送給 Bot 的歌名／作者裡的 @ 會被插入零寬空白（不會在 Discord 變成 @everyone）', async () => {
  const { base } = await serve();
  await fetch(base + '/api/music/bots/mb/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'M', guilds: [GUILD] }),
  });
  const poll = fetch(base + '/api/music/bots/mb/commands?wait=5').then((r) => r.json());
  const web = post(base + '/web/api/bots/mb/command', {
    guildId: GUILD.guildId, action: 'enqueue',
    item: { kind: 'online', url: 'https://youtu.be/dQw4w9WgXcQ', title: '@everyone hi', author: '<@123>' },
  });
  const { commands } = await poll;
  assert.equal(commands[0].item.title, '@\u200beveryone hi');
  assert.equal(commands[0].item.author, '<@\u200b123>');
  await post(`${base}/api/music/bots/mb/commands/${commands[0].id}/result`, { ok: true });
  await web;
});
