'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
const pl = require('../webplayer/playlistStore');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');
const deps = { cleanUrl, isAllowedUrl };

touch(MUSIC, 'a.mp3');
touch(MUSIC, 'b.mp3');
touch(MUSIC, 'fav/c.flac');

test.after(() => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const saved = () => JSON.parse(fs.readFileSync(pl.FILE, 'utf8'));

test('create：驗證項目、保留順序、去重，並寫入檔案', async () => {
  const p = await pl.create('  我的清單  ', [
    { kind: 'lib', filename: 'b.mp3', title: 'B' },
    { kind: 'lib', filename: 'missing.mp3' },                       // 檔案不存在
    { kind: 'lib', filename: '../etc/passwd.mp3' },                 // 跳出音樂庫
    { kind: 'lib', filename: 'notes.txt' },                         // 非音訊
    { kind: 'online', url: 'https://youtu.be/dQw4w9WgXcQ?feature=share', title: 'Y', platform: 'YouTube', duration: '3:33' },
    { kind: 'online', url: 'https://evil.com/x' },                  // 不允許的網域
    { kind: 'lib', filename: 'b.mp3' },                             // 重複
    { kind: 'lib', filename: '/fav//c.flac' },                      // 會被正規化
    null, 5, { kind: 'weird' },
  ], deps);
  assert.equal(p.name, '我的清單', '名稱去頭尾空白');
  assert.deepEqual(p.items.map((x) => x.filename || x.url), ['b.mp3', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'fav/c.flac']);
  assert.equal(p.items[0].title, 'B');
  assert.equal(p.items[2].title, 'c', '沒有標題時用檔名');
  assert.deepEqual(p.items[1], { id: p.items[1].id, kind: 'online', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Y', author: '', platform: 'YouTube', duration: '3:33' });
  assert.equal(new Set(p.items.map((x) => x.id)).size, 3, '每個項目都有不重複的 id');
  assert.equal(saved().playlists.find((x) => x.id === p.id).items.length, 3, '已寫入檔案');
});

test('create：名稱為空、只有控制字元時拒絕；過長會截斷', async () => {
  await assert.rejects(pl.create('   ', [], deps), (e) => e instanceof pl.HttpError && e.status === 400);
  await assert.rejects(pl.create('\u0000\u0007', [], deps), (e) => e.status === 400);
  await assert.rejects(pl.create(123, [], deps), (e) => e.status === 400);
  const p = await pl.create('x'.repeat(80), [], deps);
  assert.equal(p.name.length, 50);
  pl.remove(p.id);
});

test('addItems：重複的略過，回傳實際加入數量', async () => {
  const p = await pl.create('add', [{ kind: 'lib', filename: 'a.mp3' }], deps);
  const r = await pl.addItems(p.id, [{ kind: 'lib', filename: 'a.mp3' }, { kind: 'lib', filename: 'b.mp3' }], deps);
  assert.equal(r.added, 1);
  assert.deepEqual(r.playlist.items.map((x) => x.filename), ['a.mp3', 'b.mp3']);
  await assert.rejects(pl.addItems(p.id, [], deps), (e) => e.status === 400);
  await assert.rejects(pl.addItems(p.id, [{ kind: 'lib', filename: 'nope.mp3' }], deps), (e) => e.status === 400);
  await assert.rejects(pl.addItems('no-such-id', [{ kind: 'lib', filename: 'a.mp3' }], deps), (e) => e.status === 404);
});

test('addItems：驗證期間播放清單被刪除時回 404，不會寫回', async () => {
  const p = await pl.create('race', [], deps);
  const pending = pl.addItems(p.id, [{ kind: 'lib', filename: 'a.mp3' }], deps);
  pl.remove(p.id); // 在 await 驗證檔案的期間刪掉
  await assert.rejects(pending, (e) => e.status === 404);
  assert.equal(saved().playlists.some((x) => x.id === p.id), false);
});

test('rename / removeItem / remove', async () => {
  const p = await pl.create('old', [{ kind: 'lib', filename: 'a.mp3' }, { kind: 'lib', filename: 'b.mp3' }], deps);
  assert.equal(pl.rename(p.id, 'new').name, 'new');
  assert.throws(() => pl.rename('nope', 'x'), (e) => e.status === 404);
  const after = pl.removeItem(p.id, p.items[0].id);
  assert.deepEqual(after.items.map((x) => x.filename), ['b.mp3']);
  assert.throws(() => pl.removeItem(p.id, 'nope'), (e) => e.status === 404);
  pl.remove(p.id);
  assert.equal(pl.list().some((x) => x.id === p.id), false);
  assert.throws(() => pl.remove(p.id), (e) => e.status === 404);
});

test('removeItems：一次移除多首，不存在的 id 略過，空陣列回 400', async () => {
  const p = await pl.create('bulk', ['a.mp3', 'b.mp3', 'fav/c.flac'].map((f) => ({ kind: 'lib', filename: f })), deps);
  const [a, , c] = p.items.map((x) => x.id);
  const r = pl.removeItems(p.id, [a, c, 'ghost']);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.playlist.items.map((x) => x.filename), ['b.mp3']);
  assert.deepEqual(saved().playlists.find((x) => x.id === p.id).items.map((x) => x.filename), ['b.mp3']);
  assert.equal(pl.removeItems(p.id, ['ghost']).removed, 0);
  assert.throws(() => pl.removeItems(p.id, []), (e) => e.status === 400);
  assert.throws(() => pl.removeItems('nope', [a]), (e) => e.status === 404);
});

test('reorder：依給定順序排列，沒列到的項目接在後面（不會遺失），不存在的 id 忽略', async () => {
  const p = await pl.create('order', ['a.mp3', 'b.mp3', 'fav/c.flac'].map((f) => ({ kind: 'lib', filename: f })), deps);
  const [a, b, c] = p.items.map((x) => x.id);
  assert.deepEqual(pl.reorder(p.id, [c, 'ghost', a]).items.map((x) => x.id), [c, a, b]);
  assert.throws(() => pl.reorder(p.id, 'nope'), (e) => e.status === 400);
});

test('上限：最多 100 個播放清單', async () => {
  const start = pl.list().length;
  for (let i = start; i < 100; i++) await pl.create('p' + i, [], deps);
  await assert.rejects(pl.create('one too many', [], deps), (e) => e.status === 400 && /最多 100/.test(e.message));
});
