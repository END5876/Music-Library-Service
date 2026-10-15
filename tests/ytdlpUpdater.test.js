'use strict';
// yt-dlp 自動更新：預設開關、-U 輸出分類、不支援時停止排程（以假的 run 取代真正執行 yt-dlp）
const test = require('node:test');
const assert = require('node:assert/strict');
const updater = require('../ytdlp/ytdlpUpdater');
const { preferOpus } = require('../ytdlp/streamPlayer');

const origWarn = console.warn, origLog = console.log;
test.before(() => { console.warn = () => {}; console.log = () => {}; });
test.after(() => { console.warn = origWarn; console.log = origLog; updater.stop(); });

test('isEnabled：未設定時只在 production 開啟，明確設定優先', () => {
  assert.equal(updater.isEnabled({}), false);
  assert.equal(updater.isEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(updater.isEnabled({ NODE_ENV: 'production', YTDLP_AUTO_UPDATE: '0' }), false);
  assert.equal(updater.isEnabled({ YTDLP_AUTO_UPDATE: '1' }), true);
});

test('classify：依 yt-dlp -U 輸出判斷結果', () => {
  assert.equal(updater.classify('Updating to stable@2026.09.30 from stable@2026.06.01 ...\nUpdated yt-dlp to stable@2026.09.30'), 'updated');
  assert.equal(updater.classify('Latest version: stable@2026.09.30\nyt-dlp is up to date (stable@2026.09.30)'), 'up-to-date');
  assert.equal(updater.classify('ERROR: You installed yt-dlp with pip or using the wheel from PyPi; Use that to update'), 'unsupported');
  assert.equal(updater.classify('ERROR: Unable to download'), 'error');
});

test('checkNow：更新成功後重新讀版本', async () => {
  let version = '2026.06.01';
  updater._setRun(async (args) => {
    if (args[0] === '-U') { version = '2026.09.30'; return 'Updated yt-dlp to stable@2026.09.30'; }
    return version;
  });
  assert.equal(await updater.checkNow(), 'updated');
  const s = updater.getStatus();
  assert.equal(s.version, '2026.09.30');
  assert.equal(s.lastResult, 'updated');
  assert.equal(s.lastError, null);
  assert.ok(s.lastCheckAt);
});

test('checkNow：失敗時記錄錯誤；同時呼叫只跑一次', async () => {
  let calls = 0;
  updater._setRun(async (args) => {
    if (args[0] === '-U') { calls++; const e = new Error('exit 1'); e.output = 'ERROR: network down'; throw e; }
    return '2026.09.30';
  });
  const [a, b] = [updater.checkNow(), updater.checkNow()];
  assert.equal(a, b);
  assert.equal(await a, 'error');
  assert.equal(calls, 1);
  assert.match(updater.getStatus().lastError, /network down/);
});

test('preferOpus：串流直接封裝模式優先挑 Opus 音軌，其他參數不動', () => {
  const args = ['--no-playlist', '-f', 'bestaudio/best', '-o', '-'];
  assert.deepEqual(preferOpus(args), ['--no-playlist', '-f', 'bestaudio[acodec=opus]/bestaudio/best', '-o', '-']);
  assert.deepEqual(args[2], 'bestaudio/best', '不修改原陣列');
  assert.deepEqual(preferOpus(['-f', '251']), ['-f', '251'], '不是預設選擇器時不改');
});
