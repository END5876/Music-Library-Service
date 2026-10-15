'use strict';
// 快取清理：MAX_CACHE_SIZE_MB 是模組載入時讀取，所以獨立一個測試檔（1MB 上限）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.MAX_CACHE_SIZE_MB = '1';
const store = require('../musicStore');

// 每刪一個檔案都會印一行 log；Windows 上並行跑測試時，子行程大量輸出多位元組字元偶爾會弄壞
// 測試執行器的通訊（Unable to deserialize cloned data），這裡的 log 都是預期中的，直接靜音
const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => {
  console.log = origLog;
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

const KB = 1024;
function put(rel, kb, ageSec) {
  const abs = touch(MUSIC, rel, Buffer.alloc(kb * KB));
  const t = Date.now() / 1000 - ageSec;
  fs.utimesSync(abs, t, t);
  return abs;
}

test('evictCacheIfNeeded：超過上限時依修改時間由舊到新刪除根目錄的音訊檔', async () => {
  put('old1.mp3', 400, 500);
  put('old2.mp3', 400, 400);
  put('mid.mp3', 400, 300);
  put('new.mp3', 400, 100);
  // 不該被碰的：子資料夾、暫存檔、非音訊檔（它們也不計入容量）
  const keep = [put('fav/big.mp3', 3000, 9999), put('dl.tmp.mp3', 900, 9999), put('notes.txt', 900, 9999)];

  await store.evictCacheIfNeeded();
  const left = fs.readdirSync(MUSIC).filter((n) => n.endsWith('.mp3') && !n.includes('.tmp')).sort();
  assert.deepEqual(left, ['mid.mp3', 'new.mp3'], '1600KB → 刪掉最舊的兩個後剩 800KB');
  for (const f of keep) assert.equal(fs.existsSync(f), true, f);
});

test('evictCacheIfNeeded：未超過上限時不刪任何檔案', async () => {
  const before = fs.readdirSync(MUSIC).sort();
  await store.evictCacheIfNeeded();
  assert.deepEqual(fs.readdirSync(MUSIC).sort(), before);
});

test('evictCacheIfNeeded：同時多次呼叫只跑一份，期間新增的檔案會在補跑時處理', async () => {
  put('a1.mp3', 400, 50);
  const p1 = store.evictCacheIfNeeded();
  put('a2.mp3', 400, 10); // 第一份可能已經掃描完，看不到這一首
  const p2 = store.evictCacheIfNeeded();
  assert.equal(p1, p2, '執行中再呼叫會拿到同一個 Promise');
  await p1;
  // 等補跑那一次結束後，再在閒置狀態跑一次（閒置時呼叫不會再排補跑，測試結束後就不會有殘留的工作）
  await new Promise((r) => setTimeout(r, 200));
  await store.evictCacheIfNeeded();
  const files = fs.readdirSync(MUSIC).filter((n) => n.endsWith('.mp3') && !n.includes('.tmp'));
  const total = files.reduce((s, n) => s + fs.statSync(path.join(MUSIC, n)).size, 0);
  assert.ok(total <= 1024 * KB, `根目錄總量 ${total} bytes 應不超過 1MB`);
  assert.ok(files.includes('a2.mp3'), '最新的一首保留');
});

test('evictCacheIfNeeded：LRU，最近播放過（touchCache）的舊檔不會先被刪', async () => {
  for (const n of fs.readdirSync(MUSIC)) fs.rmSync(path.join(MUSIC, n), { recursive: true, force: true });
  const played = put('played-old.mp3', 400, 900);
  put('unplayed-mid.mp3', 400, 500);
  put('unplayed-new.mp3', 400, 100);
  const mtimeBefore = fs.statSync(played).mtimeMs;

  await store.touchCache(played);
  assert.equal(fs.statSync(played).mtimeMs, mtimeBefore, '只更新 atime，mtime 不變（清單／長度快取靠 mtime 判斷異動）');

  await store.evictCacheIfNeeded();
  const left = fs.readdirSync(MUSIC).filter((n) => n.endsWith('.mp3')).sort();
  assert.deepEqual(left, ['played-old.mp3', 'unplayed-new.mp3'], '1200KB → 刪掉最久沒用的那首');
});

test('touchCache：子資料夾（非快取）與音樂庫外的路徑不處理', async () => {
  const fav = put('fav/keep.mp3', 1, 900);
  const before = fs.statSync(fav).atimeMs;
  await store.touchCache(fav);
  await store.touchCache(path.join(MUSIC, '..', 'outside.mp3'));
  assert.equal(fs.statSync(fav).atimeMs, before);
});

test('evictCacheIfNeeded：音樂庫資料夾不存在時不會丟出錯誤', async () => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  await store.evictCacheIfNeeded();
  fs.mkdirSync(MUSIC, { recursive: true });
});
