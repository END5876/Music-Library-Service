'use strict';
// 播放清單檔讀不到（不是「不存在」）時不能當成空的：不然下一次存檔會把所有帳號的清單蓋掉。
// 不認得的格式（例如部署回滾到這一版）也要先備份再重新開始。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./helpers');

const MUSIC = tempDir();
const DATA = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PLAYLISTS_FILE = path.join(DATA, 'playlists.json');
fs.mkdirSync(process.env.PLAYLISTS_FILE); // 是資料夾 → readFileSync 失敗（EISDIR），模擬讀取錯誤
const A = '111111111111111111';
const deps = { cleanUrl: (u) => u, isAllowedUrl: () => false };

test.after(() => {
  fs.rmSync(MUSIC, { recursive: true, force: true });
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('讀取失敗：回 503、不寫檔；下一個請求會重新讀取', async () => {
  const origError = console.error;
  console.error = () => {}; // 這裡預期會印出錯誤
  try {
    const pl = require('../webplayer/playlistStore');
    assert.throws(() => pl.list(A), (e) => e.status === 503);
    await assert.rejects(pl.create(A, 'x', [], deps), (e) => e.status === 503);
    assert.ok(fs.statSync(pl.FILE).isDirectory(), '沒有被存檔蓋掉');

    // 修好之後（換成一個不認得格式的檔案）：先備份成 .unknown-*.bak，再從空的開始
    fs.rmdirSync(pl.FILE);
    const future = JSON.stringify({ version: 3, something: [1, 2, 3] });
    fs.writeFileSync(pl.FILE, future);
    assert.deepEqual(pl.list(A), []);
    const baks = fs.readdirSync(DATA).filter((n) => /^playlists\.json\.unknown-\d+\.bak$/.test(n));
    assert.equal(baks.length, 1);
    assert.equal(fs.readFileSync(path.join(DATA, baks[0]), 'utf8'), future, '備份內容是原檔');
    await pl.create(A, 'fresh', [], deps);
    assert.equal(JSON.parse(fs.readFileSync(pl.FILE, 'utf8')).owners[A].length, 1);
  } finally {
    console.error = origError;
  }
});
