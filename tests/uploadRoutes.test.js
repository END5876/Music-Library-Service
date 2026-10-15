'use strict';
// 上傳路由的入口條件與輸入檢查（都在呼叫 ffmpeg 之前就會擋下，所以不需要安裝 ffmpeg）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const { tempDir } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
const store = require('../musicStore');
const { mountUploadRoutes } = require('../webplayer/uploadRoutes');

let base, server, authed = true;
const origError = console.error;
test.before(async () => {
  console.error = () => {}; // 這個檔案的每個案例都是預期中的上傳失敗，路由會印錯誤 log
  const app = express();
  const requireWebAuth = (req, res, next) => (authed ? next() : res.status(401).json({ error: '請先登入' }));
  mountUploadRoutes(app, { store, requireWebAuth });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  console.error = origError;
  server.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

const upload = (headers, query = '?upload=1') => fetch(base + '/web/api/upload' + query, {
  method: 'POST', body: Buffer.from('fake audio'),
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v)])),
});
const leftovers = () => fs.readdirSync(MUSIC, { recursive: true });

test('沒有帶 ?upload=1（或值不對）時頁面與 API 都不存在（404）', async () => {
  for (const q of ['', '?upload=0', '?upload=true', '?upload=1&upload=1']) {
    assert.equal((await upload({ 'x-upload-filename': 'a.mp3' }, q)).status, 404, q);
    assert.equal((await fetch(base + '/upload' + q)).status, 404, q);
  }
});

test('有 ?upload=1 但未登入：401', async () => {
  authed = false;
  try {
    assert.equal((await upload({ 'x-upload-filename': 'a.mp3' })).status, 401);
    assert.equal((await fetch(base + '/upload?upload=1')).status, 401);
  } finally { authed = true; }
});

test('不支援的副檔名：400', async () => {
  for (const name of ['a.exe', 'a.mp3.exe', 'a', 'a.txt']) {
    const r = await upload({ 'x-upload-filename': name });
    assert.equal(r.status, 400, name);
    assert.match((await r.json()).error, /只允許上傳/);
  }
});

test('資料夾名稱不合法（跳出音樂庫、保留字元）：400，且不寫入任何檔案', async () => {
  for (const folder of ['..', '../x', 'a/../../b', 'a/./b', 'a//b', 'a:b', 'a|b', 'a*b', 'a?b', 'a\\..\\b']) {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-folder': folder });
    assert.equal(r.status, 400, folder);
  }
  assert.deepEqual(leftovers(), []);
});

test('曲名清理後為空：400', async () => {
  for (const title of ['   ', '/', '???']) {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-title': title });
    assert.equal(r.status, 400, title);
  }
});

test('上傳欄位不是合法的 URL 編碼：400', async () => {
  const r = await fetch(base + '/web/api/upload?upload=1', { method: 'POST', body: 'x', headers: { 'x-upload-filename': '%E0%A4%A' } });
  assert.equal(r.status, 400);
});

test('同名檔案已存在：409，原本的檔案不會被覆蓋', async () => {
  const fp = require('path').join(MUSIC, 'fav', '已存在.mp3');
  fs.mkdirSync(require('path').dirname(fp), { recursive: true });
  fs.writeFileSync(fp, 'original');
  try {
    const r = await upload({ 'x-upload-filename': 'x.flac', 'x-upload-title': '已存在', 'x-upload-folder': 'fav' });
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'original');
    assert.deepEqual(leftovers().filter((f) => /\.tmp/.test(f)), [], '沒有留下暫存檔');
  } finally { fs.rmSync(require('path').join(MUSIC, 'fav'), { recursive: true, force: true }); }
});
