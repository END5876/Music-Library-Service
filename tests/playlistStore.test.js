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
const A = '111111111111111111'; // 兩個不同的 Discord 帳號
const B = '222222222222222222';

touch(MUSIC, 'a.mp3');
touch(MUSIC, 'b.mp3');
touch(MUSIC, 'fav/c.flac');

test.after(() => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

const saved = () => JSON.parse(fs.readFileSync(pl.FILE, 'utf8'));

test('create：驗證項目、保留順序、去重，並寫入檔案', async () => {
  const p = await pl.create(A, '  我的清單  ', [
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
  assert.equal(saved().owners[A].find((x) => x.id === p.id).items.length, 3, '已寫入檔案');
});

test('create：名稱為空、只有控制字元時拒絕；過長會截斷', async () => {
  await assert.rejects(pl.create(A, '   ', [], deps), (e) => e instanceof pl.HttpError && e.status === 400);
  await assert.rejects(pl.create(A, '\u0000\u0007', [], deps), (e) => e.status === 400);
  await assert.rejects(pl.create(A, 123, [], deps), (e) => e.status === 400);
  const p = await pl.create(A, 'x'.repeat(80), [], deps);
  assert.equal(p.name.length, 50);
  pl.remove(A, p.id);
});

test('addItems：重複的略過，回傳實際加入數量', async () => {
  const p = await pl.create(A, 'add', [{ kind: 'lib', filename: 'a.mp3' }], deps);
  const r = await pl.addItems(A, p.id, [{ kind: 'lib', filename: 'a.mp3' }, { kind: 'lib', filename: 'b.mp3' }], deps);
  assert.equal(r.added, 1);
  assert.deepEqual(r.playlist.items.map((x) => x.filename), ['a.mp3', 'b.mp3']);
  await assert.rejects(pl.addItems(A, p.id, [], deps), (e) => e.status === 400);
  await assert.rejects(pl.addItems(A, p.id, [{ kind: 'lib', filename: 'nope.mp3' }], deps), (e) => e.status === 400);
  await assert.rejects(pl.addItems(A, 'no-such-id', [{ kind: 'lib', filename: 'a.mp3' }], deps), (e) => e.status === 404);
});

test('addItems：驗證期間播放清單被刪除時回 404，不會寫回', async () => {
  const p = await pl.create(A, 'race', [], deps);
  const pending = pl.addItems(A, p.id, [{ kind: 'lib', filename: 'a.mp3' }], deps);
  pl.remove(A, p.id); // 在 await 驗證檔案的期間刪掉
  await assert.rejects(pending, (e) => e.status === 404);
  assert.equal(saved().owners[A].some((x) => x.id === p.id), false);
});

test('rename / removeItem / remove', async () => {
  const p = await pl.create(A, 'old', [{ kind: 'lib', filename: 'a.mp3' }, { kind: 'lib', filename: 'b.mp3' }], deps);
  assert.equal(pl.rename(A, p.id, 'new').name, 'new');
  assert.throws(() => pl.rename(A, 'nope', 'x'), (e) => e.status === 404);
  const after = pl.removeItem(A, p.id, p.items[0].id);
  assert.deepEqual(after.items.map((x) => x.filename), ['b.mp3']);
  assert.throws(() => pl.removeItem(A, p.id, 'nope'), (e) => e.status === 404);
  pl.remove(A, p.id);
  assert.equal(pl.list(A).some((x) => x.id === p.id), false);
  assert.throws(() => pl.remove(A, p.id), (e) => e.status === 404);
});

test('removeItems：一次移除多首，不存在的 id 略過，空陣列回 400', async () => {
  const p = await pl.create(A, 'bulk', ['a.mp3', 'b.mp3', 'fav/c.flac'].map((f) => ({ kind: 'lib', filename: f })), deps);
  const [a, , c] = p.items.map((x) => x.id);
  const r = pl.removeItems(A, p.id, [a, c, 'ghost']);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.playlist.items.map((x) => x.filename), ['b.mp3']);
  assert.deepEqual(saved().owners[A].find((x) => x.id === p.id).items.map((x) => x.filename), ['b.mp3']);
  assert.equal(pl.removeItems(A, p.id, ['ghost']).removed, 0);
  assert.throws(() => pl.removeItems(A, p.id, []), (e) => e.status === 400);
  assert.throws(() => pl.removeItems(A, 'nope', [a]), (e) => e.status === 404);
});

test('reorder：依給定順序排列，沒列到的項目接在後面（不會遺失），不存在的 id 忽略', async () => {
  const p = await pl.create(A, 'order', ['a.mp3', 'b.mp3', 'fav/c.flac'].map((f) => ({ kind: 'lib', filename: f })), deps);
  const [a, b, c] = p.items.map((x) => x.id);
  assert.deepEqual(pl.reorder(A, p.id, [c, 'ghost', a]).items.map((x) => x.id), [c, a, b]);
  assert.throws(() => pl.reorder(A, p.id, 'nope'), (e) => e.status === 400);
});

test('每個帳號各自一份：看不到、改不到、刪不到別人的播放清單', async () => {
  const a = await pl.create(A, 'A 的清單', [{ kind: 'lib', filename: 'a.mp3' }], deps);
  assert.equal(pl.list(B).some((x) => x.id === a.id), false, 'B 看不到');
  assert.throws(() => pl.rename(B, a.id, 'x'), (e) => e.status === 404);
  assert.throws(() => pl.remove(B, a.id), (e) => e.status === 404);
  assert.throws(() => pl.removeItem(B, a.id, a.items[0].id), (e) => e.status === 404);
  assert.throws(() => pl.removeItems(B, a.id, [a.items[0].id]), (e) => e.status === 404);
  assert.throws(() => pl.reorder(B, a.id, []), (e) => e.status === 404);
  await assert.rejects(pl.addItems(B, a.id, [{ kind: 'lib', filename: 'b.mp3' }], deps), (e) => e.status === 404);
  assert.equal(pl.list(A).find((x) => x.id === a.id).name, 'A 的清單', 'A 的清單沒被動到');

  const b = await pl.create(B, 'B 的清單', [], deps);
  assert.deepEqual(pl.list(B).map((x) => x.id), [b.id]);
  assert.deepEqual(saved().owners[B].map((x) => x.id), [b.id], '檔案裡依帳號分開存');
  assert.equal(saved().version, 2);
  pl.remove(B, b.id);
  assert.equal(saved().owners[B], undefined, '沒有清單了就不佔帳號名額');
  pl.remove(A, a.id);
});

test('擁有者必須是 Discord 使用者 ID：沒登入帳號（內部金鑰）、亂填的值都回 403', async () => {
  for (const bad of [null, undefined, '', 'abc', '__proto__', 123, '1'.repeat(30)]) {
    assert.throws(() => pl.list(bad), (e) => e.status === 403, String(bad));
    await assert.rejects(pl.create(bad, 'x', [], deps), (e) => e.status === 403, String(bad));
  }
});

test('上限：每個帳號所有清單合計最多 MAX_OWNER_ITEMS 首；超過時整批不加（不會只加一半）', async () => {
  const C = '333333333333333333';
  const yt = (n) => ({ kind: 'online', url: `https://www.youtube.com/watch?v=${String(n).padStart(11, 'x')}`, title: 't' });
  const per = 2000;
  const lists = [];
  for (let i = 0; i * per < pl.MAX_OWNER_ITEMS; i++) {
    lists.push(await pl.create(C, 'big' + i, Array.from({ length: per }, (_, j) => yt(i * per + j)), deps));
  }
  assert.equal(lists.reduce((n, p) => n + p.items.length, 0), pl.MAX_OWNER_ITEMS);
  const extra = await pl.create(C, 'extra', [], deps);
  await assert.rejects(pl.addItems(C, extra.id, [yt(999999), yt(999998)], deps), (e) => e.status === 400 && /合計最多/.test(e.message));
  assert.equal(pl.list(C).find((p) => p.id === extra.id).items.length, 0, '整批不加');
  await assert.rejects(pl.create(C, 'more', [yt(999997)], deps), (e) => e.status === 400);
  assert.equal(pl.list(C).some((p) => p.name === 'more'), false, '建立失敗不會留下空清單');
  const b = await pl.create(B, '別的帳號不受影響', [yt(888888)], deps);
  for (const p of [...pl.list(C)]) pl.remove(C, p.id);
  pl.remove(B, b.id);
});

test('上限：每個帳號最多 100 個播放清單（別的帳號不受影響）', async () => {
  const start = pl.list(A).length;
  for (let i = start; i < 100; i++) await pl.create(A, 'p' + i, [], deps);
  await assert.rejects(pl.create(A, 'one too many', [], deps), (e) => e.status === 400 && /最多 100/.test(e.message));
  const b = await pl.create(B, 'B 還可以建', [], deps);
  pl.remove(B, b.id);
});

test('存檔失敗時不留在記憶體：回錯誤後清單維持原樣，重試不會重複新增', async () => {
  const before = pl.list(B).length;
  const tmp = `${pl.FILE}.${process.pid}.tmp`;
  fs.mkdirSync(tmp); // 暫存檔路徑被資料夾佔住 → 寫入失敗
  try {
    await assert.rejects(pl.create(B, '寫不進去', [], deps));
    assert.equal(pl.list(B).length, before, '失敗的改動不會留在記憶體');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const p = await pl.create(B, '寫得進去', [], deps);
  assert.deepEqual(pl.list(B).map((x) => x.name).filter((n) => n.startsWith('寫')), ['寫得進去']);
  pl.remove(B, p.id);
});
