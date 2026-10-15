'use strict';
// 播放清單檔案的載入：壞掉的 JSON 要先備份再重新開始（不能被下一次存檔直接覆蓋掉）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
fs.writeFileSync(process.env.PLAYLISTS_FILE, '{ this is not json');

test.after(() => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('JSON 壞掉時改名備份，並以空清單繼續運作', async () => {
  const origError = console.error;
  console.error = () => {}; // 這裡預期會印出解析失敗的錯誤
  let pl;
  try {
    pl = require('../webplayer/playlistStore');
    assert.deepEqual(pl.list(), []);
  } finally {
    console.error = origError;
  }
  const baks = fs.readdirSync(DATA).filter((n) => /^playlists\.json\.corrupt-\d+\.bak$/.test(n));
  assert.equal(baks.length, 1, '有一份備份');
  assert.equal(fs.readFileSync(path.join(DATA, baks[0]), 'utf8'), '{ this is not json', '備份內容是原檔');
  await pl.create('fresh', [], { cleanUrl: (u) => u, isAllowedUrl: () => false });
  assert.equal(JSON.parse(fs.readFileSync(pl.FILE, 'utf8')).playlists.length, 1, '之後可以正常存檔');
});
