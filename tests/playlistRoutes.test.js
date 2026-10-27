'use strict';
// 播放清單 API：擁有者一律取自登入帳號（req.webUser.id），不同帳號互相看不到、改不到
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
const { mountPlaylists } = require('../webplayer/playlistRoutes');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');

const A = '111111111111111111';
const B = '222222222222222222';
touch(MUSIC, 'a.mp3');

let base, server;
test.before(async () => {
  const app = express();
  // 測試用的登入：x-test-user 標頭＝Discord 使用者 ID；x-test-internal＝只帶內部金鑰（沒有帳號）
  const requireWebAuth = (req, res, next) => {
    if (req.get('x-test-internal')) { req.webUser = { id: null, name: '', admin: true }; return next(); }
    const id = req.get('x-test-user');
    if (!id) return res.status(401).json({ error: '請先登入' });
    req.webUser = { id, name: '', admin: false };
    next();
  };
  mountPlaylists(app, { requireWebAuth, online: { cleanUrl, isAllowedUrl } });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const api = (method, url, headers, body) => fetch(base + url, {
  method,
  headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const as = (id) => ({ 'x-test-user': id });

test('每個帳號只看得到、改得到自己的播放清單', async () => {
  const created = await api('POST', '/web/api/playlists', as(A), { name: 'A 的', items: [{ kind: 'lib', filename: 'a.mp3' }] });
  assert.equal(created.status, 200);
  const { playlist } = await created.json();

  assert.deepEqual((await (await api('GET', '/web/api/playlists', as(A))).json()).playlists.map((p) => p.id), [playlist.id]);
  assert.deepEqual((await (await api('GET', '/web/api/playlists', as(B))).json()).playlists, [], 'B 看不到 A 的');

  const id = playlist.id;
  const itemId = playlist.items[0].id;
  for (const [method, url, body] of [
    ['PATCH', `/web/api/playlists/${id}`, { name: 'x' }],
    ['DELETE', `/web/api/playlists/${id}`],
    ['POST', `/web/api/playlists/${id}/items`, { items: [{ kind: 'lib', filename: 'a.mp3' }] }],
    ['POST', `/web/api/playlists/${id}/items/remove`, { ids: [itemId] }],
    ['DELETE', `/web/api/playlists/${id}/items/${itemId}`],
    ['PUT', `/web/api/playlists/${id}/order`, { order: [itemId] }],
  ]) {
    assert.equal((await api(method, url, as(B), body)).status, 404, `B 不能 ${method} ${url}`);
  }
  const still = (await (await api('GET', '/web/api/playlists', as(A))).json()).playlists[0];
  assert.equal(still.name, 'A 的');
  assert.equal(still.items.length, 1, 'A 的清單沒被動到');

  assert.equal((await api('PATCH', `/web/api/playlists/${id}`, as(A), { name: '改名' })).status, 200, 'A 自己可以改');
});

test('修改次數上限：每個帳號每分鐘 120 次，讀取不計、別的帳號不受影響', async () => {
  const C = '333333333333333333';
  const { playlist } = await (await api('POST', '/web/api/playlists', as(C), { name: 'rate' })).json();
  for (let i = 1; i < 120; i++) {
    assert.equal((await api('PATCH', `/web/api/playlists/${playlist.id}`, as(C), { name: `n${i}` })).status, 200, `第 ${i + 1} 次`);
  }
  const blocked = await api('PATCH', `/web/api/playlists/${playlist.id}`, as(C), { name: 'too many' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await api('GET', '/web/api/playlists', as(C))).status, 200, '讀取不受影響');
  assert.equal((await api('POST', '/web/api/playlists', as(B), { name: 'B ok' })).status, 200, '別的帳號不受影響');
});

test('只帶內部金鑰（沒有 Discord 帳號）不能用播放清單：403', async () => {
  const r = await api('GET', '/web/api/playlists', { 'x-test-internal': '1' });
  assert.equal(r.status, 403);
  assert.equal((await api('POST', '/web/api/playlists', { 'x-test-internal': '1' }, { name: 'x' })).status, 403);
  assert.equal((await api('GET', '/web/api/playlists')).status, 401, '沒登入');
});
