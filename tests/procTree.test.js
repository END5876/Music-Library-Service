'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { spawnTree, isAlive, killTree } = require('../ytdlp/procTree');

const longRunning = () => spawnTree(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

test('isAlive：送出訊號後、行程真正結束前仍是 true（不能用 proc.killed 判斷）', async () => {
  const p = longRunning();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isAlive(p), true);
  p.kill('SIGTERM');
  assert.equal(p.killed, true, 'proc.killed 在訊號送出當下就變成 true');
  await once(p, 'exit');
  assert.equal(isAlive(p), false);
});

test('killTree：結束子行程；對已結束或不存在的行程呼叫不會出錯', async () => {
  const p = longRunning();
  await new Promise((r) => setTimeout(r, 200));
  killTree(p, 'SIGKILL');
  await once(p, 'exit');
  assert.equal(isAlive(p), false);
  killTree(p, 'SIGKILL');
  killTree(null);
  killTree(undefined, 'SIGTERM');
  assert.equal(isAlive(null), false);
});

test('killTree：Linux 上連同孫行程一起結束（整個 process group）', { skip: process.platform === 'win32' && 'Windows 沒有 process group' }, async () => {
  const { execSync } = require('child_process');
  // 父行程忽略 SIGTERM，並開一個孫行程（模擬 yt-dlp → ffmpeg）
  const p = spawnTree('sh', ['-c', 'trap "" TERM; sleep 30 & wait'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const members = () => execSync(`ps -eo pgid=,stat= | awk '$1==${p.pid} && $2 !~ /^Z/' | wc -l`).toString().trim();
  assert.equal(members(), '2', 'group 內有父行程與孫行程');
  killTree(p, 'SIGKILL');
  await once(p, 'exit');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(members(), '0', '孫行程也已結束（不算尚未回收的殭屍）');
});
