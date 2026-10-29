'use strict';
// 快取檔名必須和 Bot 完全相同，Bot 與網頁的快取才會互相命中
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempDir } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
const { getCacheFilename } = require('../ytdlp/musicCache');

test.after(() => fs.rmSync(MUSIC, { recursive: true, force: true }));

test('getCacheFilename：依平台加上影片 id', () => {
  assert.equal(getCacheFilename('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Never Gonna'), 'Never Gonna [yt_dQw4w9WgXcQ].mp3');
  assert.equal(getCacheFilename('https://youtu.be/dQw4w9WgXcQ', 'T'), 'T [yt_dQw4w9WgXcQ].mp3');
  assert.equal(getCacheFilename('https://www.bilibili.com/video/BV1xx411c7mD?p=2', '標題'), '標題 [BV1xx411c7mD].mp3');
  assert.equal(getCacheFilename('https://www.bilibili.com/video/av170001', 'T'), 'T [av170001].mp3');
});

test('getCacheFilename：移除檔名不允許的字元、合併空白、標題最多 80 字', () => {
  assert.equal(getCacheFilename('https://youtu.be/dQw4w9WgXcQ', ' a/b\\c:d*e?f"g<h>i|j   k '), 'abcdefghij k [yt_dQw4w9WgXcQ].mp3');
  const long = getCacheFilename('https://youtu.be/dQw4w9WgXcQ', 'x'.repeat(200));
  assert.equal(long, 'x'.repeat(80) + ' [yt_dQw4w9WgXcQ].mp3');
});

test('getCacheFilename：沒有標題時只用 id；認不出 id 時用網址的 base64 片段', () => {
  assert.equal(getCacheFilename('https://youtu.be/dQw4w9WgXcQ', ''), 'yt_dQw4w9WgXcQ.mp3');
  assert.equal(getCacheFilename('https://youtu.be/dQw4w9WgXcQ', '///'), 'yt_dQw4w9WgXcQ.mp3');
  const other = getCacheFilename('https://example.com/x', 'T');
  assert.match(other, /^T \[[A-Za-z0-9]{12}\]\.mp3$/);
  assert.equal(other, getCacheFilename('https://example.com/x', 'T'), '同一個網址結果固定');
});

test('findCachedById：只用影片 ID 找根目錄的快取檔，不需要標題', async () => {
  const { touch } = require('./helpers');
  const { findCachedById } = require('../ytdlp/musicCache');
  const { invalidateList } = require('../musicStore');
  const path = require('path');

  touch(MUSIC, '舊標題 [yt_dQw4w9WgXcQ].mp3');
  const newer = touch(MUSIC, '新標題 [yt_dQw4w9WgXcQ].mp3');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(newer, later, later);
  touch(MUSIC, 'yt_AAAAAAAAAAA.mp3');
  touch(MUSIC, 'favorites/收藏 [BV1xx411c7mD].mp3'); // 子資料夾不是快取
  touch(MUSIC, '分P [BV1yy411c7mD].mp3');
  touch(MUSIC, '下載中 [yt_BBBBBBBBBBB].tmp.mp3'); // 暫存檔不算
  invalidateList();

  assert.equal(await findCachedById('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), path.join(MUSIC, '新標題 [yt_dQw4w9WgXcQ].mp3'), '同 ID 多檔取最新');
  assert.equal(await findCachedById('https://youtu.be/AAAAAAAAAAA'), path.join(MUSIC, 'yt_AAAAAAAAAAA.mp3'), '沒有標題的檔名');
  assert.equal(await findCachedById('https://www.bilibili.com/video/BV1xx411c7mD'), null, '子資料夾不算快取');
  assert.equal(await findCachedById('https://www.youtube.com/watch?v=BBBBBBBBBBB'), null);
  assert.equal(await findCachedById('https://www.bilibili.com/video/BV1yy411c7mD'), path.join(MUSIC, '分P [BV1yy411c7mD].mp3'));
  assert.equal(await findCachedById('https://www.bilibili.com/video/BV1yy411c7mD?p=2'), null, '分 P 認不出是哪一 P，交給完整流程');
  assert.equal(await findCachedById('https://example.com/x'), null);
});

test('findCachedById：合集已快取其他 P 時，不帶 ?p= 的網址（第 1 P）不會拿到別 P 的檔案', async () => {
  const { touch } = require('./helpers');
  const { findCachedById } = require('../ytdlp/musicCache');
  const { invalidateList } = require('../musicStore');

  touch(MUSIC, '合集 p03 第三首 [BV1zz411c7mD].mp3');
  invalidateList();
  assert.equal(await findCachedById('https://www.bilibili.com/video/BV1zz411c7mD'), null, '交給完整流程用標題比對');
});

test('getCacheFilename：YouTube 影片 ID 裡剛好有 av1 / BV 時不會被當成 Bilibili（不同影片不會撞到同一個快取檔）', () => {
  assert.equal(getCacheFilename('https://www.youtube.com/watch?v=Xav1bcdefgh', 'T'), 'T [yt_Xav1bcdefgh].mp3');
  assert.equal(getCacheFilename('https://www.youtube.com/watch?v=Qav1zzzzzzz', 'T'), 'T [yt_Qav1zzzzzzz].mp3');
  assert.equal(getCacheFilename('https://www.youtube.com/watch?v=abBVcdefghi', 'T'), 'T [yt_abBVcdefghi].mp3');
  assert.equal(getCacheFilename('https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ', 'T'), 'T [yt_dQw4w9WgXcQ].mp3');
});
