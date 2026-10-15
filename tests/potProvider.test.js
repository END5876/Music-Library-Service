'use strict';
// 本機 bgutil server 按需啟動：第一次 ensureReady 才啟動並等到可連線、使用中不重複啟動、閒置後關閉。
// 用假的 server（只監聽 --port）取代真的 bgutil。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const { tempDir, touch } = require('./helpers');

const DIR = tempDir();
touch(DIR, 'build/main.js', `
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  setTimeout(() => require('http').createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1'), 300);
`);
process.env.BGUTIL_SERVER_DIR = DIR;
process.env.POT_IDLE_MINUTES = String(1 / 60); // 1 秒
delete process.env.POT_PROVIDER;
delete process.env.POT_PROVIDER_URL;
const pot = require('../ytdlp/potProvider');

const canConnect = () => new Promise((resolve) => {
  const s = net.connect(pot.LOCAL_PORT, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('按需啟動 → 可連線 → 閒置後關閉', async (t) => {
  if (await canConnect()) return t.skip(`埠 ${pot.LOCAL_PORT} 已被佔用`);

  assert.equal(pot.start(), 'local');
  assert.equal(pot._pid(), null, 'start() 不應立刻啟動 server');
  assert.deepEqual(pot.extractorArgs(), []);

  await pot.ensureReady();
  const pid = pot._pid();
  assert.ok(pid, '第一次 ensureReady 應啟動 server');
  assert.equal(await canConnect(), true, 'ensureReady resolve 時 server 應已可連線');

  await pot.ensureReady();
  assert.equal(pot._pid(), pid, '執行中不應重複啟動');

  await sleep(1600);
  assert.equal(pot._pid(), null, '閒置超過 POT_IDLE_MINUTES 應關閉');
  await sleep(300);
  assert.equal(await canConnect(), false);
});
