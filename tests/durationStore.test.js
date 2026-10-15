'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const DATA = tempDir();
process.env.DURATIONS_FILE = path.join(DATA, 'durations.json');
const ds = require('../webplayer/durationStore');

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
test.beforeEach(() => ds._reset());

const abs = (fn) => '/music/' + fn;

test('第一次查詢在背景讀取,讀完後帶上長度', async () => {
  const calls = [];
  ds._setProbe(async (p) => { calls.push(p); return 215; });
  const files = [{ filename: 'a.mp3', size: 10, mtimeMs: 1 }];
  const first = ds.lookup(files, abs);
  assert.equal(first.durations.size, 0);
  assert.equal(first.pending, true);
  await ds._idle();
  const second = ds.lookup(files, abs);
  assert.equal(second.durations.get('a.mp3'), 215);
  assert.equal(second.pending, false);
  assert.deepEqual(calls, ['/music/a.mp3']);
});

test('檔案大小或修改時間變了就重新讀取', async () => {
  let n = 100;
  ds._setProbe(async () => n++);
  ds.lookup([{ filename: 'a.mp3', size: 10, mtimeMs: 1 }], abs);
  await ds._idle();
  ds.lookup([{ filename: 'a.mp3', size: 11, mtimeMs: 1 }], abs);
  await ds._idle();
  assert.equal(ds.lookup([{ filename: 'a.mp3', size: 11, mtimeMs: 1 }], abs).durations.get('a.mp3'), 101);
});

test('讀不出長度的檔案不帶 duration,也不會一直重試', async () => {
  let calls = 0;
  ds._setProbe(async () => { calls++; throw new Error('壞檔'); });
  const files = [{ filename: 'bad.mp3', size: 1, mtimeMs: 1 }];
  ds.lookup(files, abs);
  await ds._idle();
  const r = ds.lookup(files, abs);
  assert.equal(r.durations.has('bad.mp3'), false);
  assert.equal(r.pending, false);
  assert.equal(calls, 1);
});

test('找不到 ffprobe 時停用,不再排隊', async () => {
  ds._setProbe(async () => { const e = new Error('spawn ffprobe ENOENT'); e.code = 'ENOENT'; e.syscall = 'spawn ffprobe'; throw e; });
  ds.lookup([{ filename: 'a.mp3', size: 1, mtimeMs: 1 }, { filename: 'b.mp3', size: 1, mtimeMs: 1 }], abs);
  await ds._idle();
  const r = ds.lookup([{ filename: 'c.mp3', size: 1, mtimeMs: 1 }], abs);
  assert.equal(r.pending, false);
  assert.equal(r.durations.size, 0);
});

test('快取寫入檔案,重新載入後不必再讀', async () => {
  ds._setProbe(async () => 42);
  ds.lookup([{ filename: 'x.mp3', size: 5, mtimeMs: 9 }], abs);
  await ds._idle();
  await ds._flush();
  ds._reset();
  ds._setProbe(async () => { throw new Error('不應該再讀'); });
  const r = ds.lookup([{ filename: 'x.mp3', size: 5, mtimeMs: 9 }], abs);
  assert.equal(r.durations.get('x.mp3'), 42);
  assert.equal(r.pending, false);
});
