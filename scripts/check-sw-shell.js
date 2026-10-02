'use strict';
// 檢查 public/sw.js 的 SHELL_URLS 與 public/css、public/js 實際檔案是否一致，
// 並確認 player.html 引用的每個 CSS 都在清單內。清單有缺漏時離線首次開啟會失敗。
const fs = require('fs');
const path = require('path');
const PUBLIC = path.join(__dirname, '..', 'public');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}
const urlOf = (p) => '/player-assets/' + path.relative(PUBLIC, p).split(path.sep).join('/');

const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
const shellBlock = (sw.match(/const SHELL_URLS = \[([\s\S]*?)\];/) || [, ''])[1];
const listed = new Set([...shellBlock.matchAll(/'(\/[^']+)'/g)].map((m) => m[1]).filter((u) => u === '/player' || u.startsWith('/player-assets/')));
const onDisk = new Set(['css', 'js'].flatMap((d) => walk(path.join(PUBLIC, d))).map(urlOf));

const missing = [...onDisk].filter((u) => !listed.has(u));
const stale = [...listed].filter((u) => u !== '/player' && !onDisk.has(u));
const html = fs.readFileSync(path.join(PUBLIC, 'player.html'), 'utf8');
const linked = [...html.matchAll(/(?:href|src)="(\/player-assets\/[^"]+)"/g)].map((m) => m[1]);
const unlisted = linked.filter((u) => !listed.has(u));

if (missing.length || stale.length || unlisted.length) {
  if (missing.length) console.error('sw.js 缺少:', missing);
  if (stale.length) console.error('sw.js 多出（檔案不存在）:', stale);
  if (unlisted.length) console.error('player.html 引用但 sw.js 沒預快取:', unlisted);
  process.exit(1);
}
console.log(`sw.js SHELL_URLS OK（${listed.size} 項）`);
