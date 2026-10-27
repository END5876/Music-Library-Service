'use strict';
// 舊版（所有人共用、沒有擁有者）的播放清單檔：不搬移，備份後從空的開始
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
const LEGACY = JSON.stringify({ playlists: [{ id: 'abc', name: '共用清單', items: [], createdAt: 1, updatedAt: 1 }] });
fs.writeFileSync(process.env.PLAYLISTS_FILE, LEGACY);
const A = '111111111111111111';

test.after(() => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('舊版共用播放清單：備份成 .shared-*.bak，每個帳號都從空的開始', async () => {
  const origWarn = console.warn;
  console.warn = () => {}; // 這裡預期會印出警告
  let pl;
  try {
    pl = require('../webplayer/playlistStore');
    assert.deepEqual(pl.list(A), []);
  } finally {
    console.warn = origWarn;
  }
  const baks = fs.readdirSync(DATA).filter((n) => /^playlists\.json\.shared-\d+\.bak$/.test(n));
  assert.equal(baks.length, 1, '有一份備份');
  assert.equal(fs.readFileSync(path.join(DATA, baks[0]), 'utf8'), LEGACY, '備份內容是原檔');
  await pl.create(A, '新的', [], { cleanUrl: (u) => u, isAllowedUrl: () => false });
  const j = JSON.parse(fs.readFileSync(pl.FILE, 'utf8'));
  assert.equal(j.version, 2);
  assert.deepEqual(Object.keys(j.owners), [A]);
});
