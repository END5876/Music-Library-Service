'use strict';
// 音樂庫管理（移動／重新命名／刪除）：musicStore 的 moveFile / deleteFile，以及網頁路由與播放清單跟著改路徑
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
const store = require('../musicStore');
const pl = require('../webplayer/playlistStore');
const { mountLibraryManageRoutes } = require('../webplayer/libraryManageRoutes');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');
const A = '111111111111111111'; // 兩個不同的 Discord 帳號（播放清單各自一份）
const B = '222222222222222222';

let base, server, authed = true;
const origLog = console.log;
test.before(async () => {
  console.log = () => {};
  const app = express();
  const requireWebAuth = (req, res, next) => (authed ? next() : res.status(401).json({ error: '請先登入' }));
  mountLibraryManageRoutes(app, { store, requireWebAuth });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  console.log = origLog;
  server.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const exists = (rel) => fs.existsSync(path.join(MUSIC, ...rel.split('/')));
const move = (body) => fetch(base + '/web/api/library/move', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('moveFile：收藏到子資料夾，省略副檔名時沿用原本的', async () => {
  touch(MUSIC, '歌 [yt_dQw4w9WgXcQ].mp3');
  const r = await store.moveFile('歌 [yt_dQw4w9WgXcQ].mp3', 'favorites/歌');
  assert.deepEqual(r, { from: '歌 [yt_dQw4w9WgXcQ].mp3', to: 'favorites/歌.mp3' });
  assert.ok(exists('favorites/歌.mp3'));
  assert.ok(!exists('歌 [yt_dQw4w9WgXcQ].mp3'));
});

test('moveFile：拒絕路徑跳脫、保留資料夾、非音訊、覆寫既有檔案', async () => {
  touch(MUSIC, 'a.mp3');
  touch(MUSIC, 'b.mp3');
  touch(MUSIC, 'note.txt');
  const cases = [
    [['a.mp3', '../evil.mp3'], 400],
    [['a.mp3', '.web/x.mp3'], 400],
    [['note.txt', 'x/note.txt'], 400],
    [['missing.mp3', 'x/m.mp3'], 404],
    [['a.mp3', 'b.mp3'], 409],
  ];
  for (const [[from, to], status] of cases) {
    await assert.rejects(store.moveFile(from, to), (err) => err.status === status, `${from} → ${to}`);
  }
  assert.ok(exists('a.mp3') && exists('b.mp3'));
});

test('moveFile：改副檔名會被當成檔名的一部分（不會變成別的格式）', async () => {
  touch(MUSIC, 'ext.mp3');
  const r = await store.moveFile('ext.mp3', 'ext.flac');
  assert.equal(r.to, 'ext.flac.mp3');
});

test('deleteFile：刪除音訊檔；找不到回 404；不能刪非音訊檔', async () => {
  touch(MUSIC, 'del.mp3');
  await store.deleteFile('del.mp3');
  assert.ok(!exists('del.mp3'));
  await assert.rejects(store.deleteFile('del.mp3'), (err) => err.status === 404);
  await assert.rejects(store.deleteFile('note.txt'), (err) => err.status === 400);
  await assert.rejects(store.deleteFile('../x.mp3'), (err) => err.status === 400);
});

test('POST /web/api/library/move：所有帳號的播放清單裡的路徑都跟著改', async () => {
  touch(MUSIC, 'song.mp3');
  touch(MUSIC, 'keep/song.mp3');
  const deps = { cleanUrl, isAllowedUrl };
  const p1 = await pl.create(A, '清單一', [{ kind: 'lib', filename: 'song.mp3' }], deps);
  const p2 = await pl.create(B, '清單二', [{ kind: 'lib', filename: 'song.mp3' }, { kind: 'lib', filename: 'keep/song.mp3' }], deps);

  await fs.promises.unlink(path.join(MUSIC, 'keep', 'song.mp3')); // 讓目標位置空出來，但清單二裡仍有指向它的項目
  const r = await move({ from: 'song.mp3', to: 'keep/song' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, { ok: true, from: 'song.mp3', to: 'keep/song.mp3', playlists: 2 });

  const byId = (owner, id) => pl.list(owner).find((p) => p.id === id);
  assert.deepEqual(byId(A, p1.id).items.map((it) => it.filename), ['keep/song.mp3']);
  assert.deepEqual(byId(B, p2.id).items.map((it) => it.filename), ['keep/song.mp3'], '已有新路徑的清單不重複');
});

test('網頁路由：輸入檢查、錯誤碼、需要登入', async () => {
  assert.equal((await move({ from: 'a.mp3' })).status, 400);
  assert.equal((await move({ from: 'a.mp3', to: 'b.mp3' })).status, 409);
  assert.equal((await fetch(base + '/web/api/library/file/nope.mp3', { method: 'DELETE' })).status, 404);

  touch(MUSIC, 'sub/刪我.mp3');
  const r = await fetch(base + '/web/api/library/file/sub/' + encodeURIComponent('刪我.mp3'), { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.ok(!exists('sub/刪我.mp3'));

  authed = false;
  try {
    assert.equal((await move({ from: 'a.mp3', to: 'x/a' })).status, 401);
    assert.equal((await fetch(base + '/web/api/library/file/a.mp3', { method: 'DELETE' })).status, 401);
  } finally { authed = true; }
  assert.ok(exists('a.mp3'));
});

test('moveFile：只差大小寫時，檔案系統分大小寫（另一個檔真的存在）→ 409；不分大小寫 → 允許改名', async () => {
  touch(MUSIC, 'case/a.mp3', 'lower');
  const caseSensitive = !exists('case/A.mp3');
  if (caseSensitive) {
    touch(MUSIC, 'case/A.mp3', 'UPPER');
    await assert.rejects(store.moveFile('case/a.mp3', 'case/A.mp3'), (err) => err.status === 409);
    assert.equal(fs.readFileSync(path.join(MUSIC, 'case', 'A.mp3'), 'utf8'), 'UPPER', '另一個檔沒有被蓋掉');
  } else {
    const r = await store.moveFile('case/a.mp3', 'case/A.mp3');
    assert.equal(r.to, 'case/A.mp3');
    assert.deepEqual(fs.readdirSync(path.join(MUSIC, 'case')), ['A.mp3']);
  }
});

test('publishFile：overwrite=false 時目標已存在 → 409，來源與目標都不動', () => {
  touch(MUSIC, 'pub/target.mp3', 'old');
  const src = touch(MUSIC, 'pub/target.mp3.upload_1.tmp', 'new');
  const target = { relPath: 'pub/target.mp3', absPath: path.join(MUSIC, 'pub', 'target.mp3') };
  assert.throws(() => store.publishFile(src, target, { overwrite: false }), (err) => err.status === 409);
  assert.equal(fs.readFileSync(target.absPath, 'utf8'), 'old');
  assert.equal(fs.existsSync(src), true, '來源留給呼叫端清理');
  fs.rmSync(target.absPath);
  store.publishFile(src, target, { overwrite: false });
  assert.equal(fs.readFileSync(target.absPath, 'utf8'), 'new');
  assert.equal(fs.existsSync(src), false);
});
