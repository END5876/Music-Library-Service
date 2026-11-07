'use strict';
// 私人上傳（.private/<uid>/）的隔離：路徑檢查、共用清單、移動／刪除、播放清單、響度階數
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
const store = require('../musicStore');
const pl = require('../webplayer/playlistStore');
const { gainSteps } = require('../ytdlp/musicNormalizer');

const A = '111111111111111111';
const B = '222222222222222222';
const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => {
  console.log = origLog;
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('沒帶 uid、別人的 uid、大小寫不同、只到資料夾層：一律拒絕', () => {
  touch(MUSIC, `.private/${A}/s.mp3`);
  const p = `.private/${A}/s.mp3`;
  assert.throws(() => store.resolveForRead(p));
  assert.throws(() => store.resolveForRead(p, { uid: B }));
  assert.throws(() => store.resolveForRead(`.PRIVATE/${A}/s.mp3`, { uid: A }));
  assert.throws(() => store.resolveForRead(`.private/${A}`, { uid: A }));
  assert.throws(() => store.resolveForRead(`.private/${A}/../${B}/s.mp3`, { uid: A }));
  assert.throws(() => store.resolveForRead('.private/abc/s.mp3', { uid: 'abc' }), '不是 Discord ID 格式');
  assert.ok(store.resolveForRead(p, { uid: A }));
  assert.throws(() => store.resolveForRead('.web/x.mp3', { uid: A }), '.web 仍然不能讀');
});

test('共用清單、快取統計看不到私人檔；listPrivate 只列自己的', async () => {
  touch(MUSIC, `.private/${B}/b.mp3`);
  touch(MUSIC, 'pub/p.mp3');
  store.invalidateList();
  assert.deepEqual((await store.listAll()).map((f) => f.filename), ['pub/p.mp3']);
  assert.deepEqual((await store.listPrivate(A)).map((f) => f.filename), [`.private/${A}/s.mp3`]);
  assert.ok((await store.listPrivate(A)).every((f) => f.private));
  assert.deepEqual(await store.listPrivate('333333333333333333'), []);
});

test('移動：私人 ↔ 公開要帶 uid；不能搬進別人的私人資料夾', async () => {
  await assert.rejects(store.moveFile('pub/p.mp3', `.private/${A}/p.mp3`));
  await assert.rejects(store.moveFile('pub/p.mp3', `.private/${B}/p.mp3`, { uid: A }));
  const r = await store.moveFile('pub/p.mp3', `.private/${A}/p.mp3`, { uid: A });
  assert.equal(r.to, `.private/${A}/p.mp3`);
  await store.moveFile(`.private/${A}/p.mp3`, 'pub/p.mp3', { uid: A });
  assert.ok(fs.existsSync(path.join(MUSIC, 'pub', 'p.mp3')));
});

test('刪除：別人的私人檔刪不掉', async () => {
  await assert.rejects(store.deleteFile(`.private/${B}/b.mp3`, { uid: A }));
  assert.ok(fs.existsSync(path.join(MUSIC, '.private', B, 'b.mp3')));
});

test('播放清單：私人歌曲只有帶本人 scope 才能加入；搬進私人時只改本人的清單', async () => {
  const deps = { isAllowedUrl: () => false, cleanUrl: (u) => u };
  const priv = { kind: 'lib', filename: `.private/${A}/s.mp3` };
  const noScope = await pl.create(A, 'x', [priv], deps);
  assert.equal(noScope.items.length, 0);
  const mine = await pl.create(A, 'mine', [priv, { kind: 'lib', filename: 'pub/p.mp3' }], { ...deps, scope: { uid: A } });
  assert.equal(mine.items.length, 2);
  const other = await pl.create(B, 'other', [{ kind: 'lib', filename: 'pub/p.mp3' }], deps);
  assert.equal(other.items.length, 1);
  assert.equal(pl.renameLibFile('pub/p.mp3', `.private/${A}/p.mp3`, { onlyOwner: A }), 1);
  assert.ok(pl.list(B)[0].items.every((it) => it.filename === 'pub/p.mp3'), '別人的清單不指向私人路徑');
});

test('啟動清理暫存檔時也會清 .private 底下的', async () => {
  const tmp = touch(MUSIC, `.private/${A}/x.mp3.upload_1_ab.tmp`);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(tmp, old, old);
  await store.cleanupStaleTemps();
  assert.ok(!fs.existsSync(tmp));
});

test('mp3gain 階數：往 -16 LUFS 靠，調大時真峰值不超過 -1 dBTP', () => {
  assert.equal(gainSteps({ input_i: '-16', input_tp: '-3' }), 0);
  assert.equal(gainSteps({ input_i: '-10', input_tp: '-0.5' }), -4); // 太大聲：降 6 dB
  assert.equal(gainSteps({ input_i: '-22', input_tp: '-10' }), 4);   // 太小聲：升 6 dB
  assert.equal(gainSteps({ input_i: '-22', input_tp: '-2.5' }), 1);  // 峰值只容許升 1.5 dB
  assert.equal(gainSteps({ input_i: '-inf', input_tp: '-inf' }), 0);
});
