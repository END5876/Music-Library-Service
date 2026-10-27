'use strict';
// Bot 用的 /api/music/*：金鑰驗證、「公開但沒設金鑰」時的鎖定、清單的 ETag／304
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
const store = require('../musicStore');
const { mountLibraryRoutes, isInsecureLocked } = require('../libraryRoutes');

touch(MUSIC, 'a.mp3');

const servers = [];
async function serve(secret, env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const app = express();
    mountLibraryRoutes(app, { store, secret, status: { collect: async () => ({ ok: true }) } });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  } finally {
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

test.after(() => {
  for (const s of servers) s.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

test('isInsecureLocked：沒設金鑰就鎖（不論有沒有啟用網頁播放器），只有明確允許才開放', () => {
  assert.equal(isInsecureLocked({ secret: '', env: {} }), true, '沒金鑰、沒播放器：一樣鎖住');
  assert.equal(isInsecureLocked({ secret: '', env: { DISCORD_CLIENT_ID: 'client-id' } }), true);
  assert.equal(isInsecureLocked({ secret: '', env: { ALLOW_INSECURE_LIBRARY_API: '1' } }), false);
  assert.equal(isInsecureLocked({ secret: '', env: { DISCORD_CLIENT_ID: 'client-id', ALLOW_INSECURE_LIBRARY_API: '1' } }), false);
  assert.equal(isInsecureLocked({ secret: 'k', env: { DISCORD_CLIENT_ID: 'client-id' } }), false);
  assert.equal(isInsecureLocked({ secret: 'k', env: {} }), false);
});

test('公開但沒設金鑰：/api/music/* 一律 503（含寫入）', async () => {
  const base = await serve('', { DISCORD_CLIENT_ID: 'client-id' });
  assert.equal((await fetch(base + '/api/music/list')).status, 503);
  assert.equal((await fetch(base + '/api/music/file/x.mp3', { method: 'PUT', body: 'x' })).status, 503);
  assert.ok(!fs.existsSync(`${MUSIC}/x.mp3`));
});

test('有金鑰：沒帶或帶錯 401，帶對 200；status 路由也受保護', async () => {
  const base = await serve('secret', { DISCORD_CLIENT_ID: 'client-id' });
  assert.equal((await fetch(base + '/api/music/list')).status, 401);
  assert.equal((await fetch(base + '/api/music/list', { headers: { 'x-music-lib-key': 'nope' } })).status, 401);
  assert.equal((await fetch(base + '/api/music/status')).status, 401);
  const r = await fetch(base + '/api/music/status', { headers: { 'x-music-lib-key': 'secret' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('PUT /api/music/file：同名檔案已存在回 409、內容不變；帶 ?overwrite=1 才取代', async () => {
  const base = await serve('secret', {});
  const h = { 'x-music-lib-key': 'secret' };
  const name = encodeURIComponent('Song [yt_AAAAAAAAAAA].mp3');
  assert.equal((await fetch(`${base}/api/music/file/${name}`, { method: 'PUT', headers: h, body: 'first' })).status, 200);
  assert.equal((await fetch(`${base}/api/music/file/${name}`, { method: 'PUT', headers: h, body: 'evil' })).status, 409);
  assert.equal(fs.readFileSync(`${MUSIC}/Song [yt_AAAAAAAAAAA].mp3`, 'utf8'), 'first');
  assert.equal((await fetch(`${base}/api/music/file/${name}?overwrite=1`, { method: 'PUT', headers: h, body: 'second' })).status, 200);
  assert.equal(fs.readFileSync(`${MUSIC}/Song [yt_AAAAAAAAAAA].mp3`, 'utf8'), 'second');
});

test('沒設金鑰也沒啟用播放器：預設一樣鎖住；明確設定 ALLOW_INSECURE_LIBRARY_API=1 才開放', async () => {
  const locked = await serve('', {});
  assert.equal((await fetch(locked + '/api/music/list')).status, 503);
  const open = await serve('', { ALLOW_INSECURE_LIBRARY_API: '1' });
  assert.equal((await fetch(open + '/api/music/list')).status, 200);
});

test('/api/music/list：帶 If-None-Match 且清單沒變時回 304（Bot 輪詢省流量）', async () => {
  const base = await serve('secret', {});
  const h = { 'x-music-lib-key': 'secret' };
  const r1 = await fetch(base + '/api/music/list', { headers: h });
  const etag = r1.headers.get('etag');
  assert.ok(etag, '回應有 ETag');
  const r2 = await fetch(base + '/api/music/list', { headers: { ...h, 'If-None-Match': etag } });
  assert.equal(r2.status, 304);

  touch(MUSIC, 'b.mp3');
  store.invalidateList();
  const r3 = await fetch(base + '/api/music/list', { headers: { ...h, 'If-None-Match': etag } });
  assert.equal(r3.status, 200, '清單變了就回完整內容');
});

test('檔名以 . 開頭的歌也能下載（不會因為 dotfile 規則回 404）；保留資料夾不分大小寫一律拒絕', async () => {
  touch(MUSIC, '.dot song.mp3', 'dot');
  touch(MUSIC, '..double.mp3', 'dd');
  const base = await serve('k', {});
  const h = { 'x-music-lib-key': 'k' };
  const r = await fetch(base + '/api/music/file/' + encodeURIComponent('.dot song.mp3'), { headers: h });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'dot');
  assert.equal((await fetch(base + '/api/music/file/..double.mp3', { headers: h })).status, 200, '..開頭但不是上層目錄的檔名');
  for (const p of ['.web/x.mp3', '.WEB/x.mp3', '.Web/x.mp3']) {
    assert.equal((await fetch(base + '/api/music/file/' + p, { headers: h })).status, 400, p);
  }
});
