'use strict';
// 上傳路由：輸入檢查、公開／私人、保留原檔、配額與磁碟水位、預檢、用量。
// 轉檔路徑需要 ffmpeg，這裡只測在呼叫 ffmpeg 之前就會擋下的情況，以及不需要 ffmpeg 的「保留原檔」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.PRIVATE_QUOTA_MB = '1';
process.env.MIN_FREE_MB = '0';
const store = require('../musicStore');
const { mountUploadRoutes, estimateOutputBytes, sanitizeFilename } = require('../webplayer/uploadRoutes');

const OWNER = '111111111111111111';
let base, server, routes, user = { id: OWNER, admin: true };
const origError = console.error, origLog = console.log;
test.before(async () => {
  console.error = () => {}; console.log = () => {};
  const app = express();
  const requireWebAuth = (req, res, next) => {
    if (!user) return res.status(401).json({ error: '請先登入' });
    req.webUser = user; next();
  };
  routes = mountUploadRoutes(app, { store, requireWebAuth });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  console.error = origError; console.log = origLog;
  server.close();
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

const upload = (headers, body = Buffer.from('fake audio')) => fetch(base + '/web/api/upload', {
  method: 'POST', body,
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, encodeURIComponent(v)])),
});
const leftovers = () => fs.readdirSync(MUSIC, { recursive: true }).map((f) => String(f).replace(/\\/g, '/'));
const postJson = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('舊的 /upload 導到播放器的上傳面板；未登入 API 回 401', async () => {
  const r = await fetch(base + '/upload?upload=1', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/player?panel=upload');
  user = null;
  try { assert.equal((await upload({ 'x-upload-filename': 'a.mp3' })).status, 401); } finally { user = { id: OWNER, admin: true }; }
});

test('不支援的副檔名：400', async () => {
  for (const name of ['a.exe', 'a.mp3.exe', 'a', 'a.txt']) {
    const r = await upload({ 'x-upload-filename': name });
    assert.equal(r.status, 400, name);
    assert.match((await r.json()).error, /只允許上傳/);
  }
});

test('資料夾名稱不合法（跳出音樂庫、保留字元）：400，且不寫入任何檔案', async () => {
  for (const folder of ['..', '../x', 'a/../../b', 'a/./b', 'a//b', 'a:b', 'a|b', 'a*b', 'a?b', 'a\\..\\b']) {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-folder': folder });
    assert.equal(r.status, 400, folder);
  }
  assert.deepEqual(leftovers(), []);
});

test('不能用資料夾欄位或公開上傳寫進 .private / .web', async () => {
  for (const folder of ['.private', `.private/${OWNER}`, '.web', '.PRIVATE/x']) {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-folder': folder });
    assert.equal(r.status, 400, folder);
  }
  assert.deepEqual(leftovers(), []);
});

test('曲名清理後為空：400', async () => {
  for (const title of ['   ', '/', '???', '..']) {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-title': title });
    assert.equal(r.status, 400, title);
  }
});

test('曲名裡的「.」和「/」不會截斷曲名，只去掉音檔副檔名', () => {
  const cases = [['Mr. Brightside', 'Mr. Brightside'], ['Vol. 2', 'Vol. 2'], ['AC/DC - Thunderstruck', 'AC DC - Thunderstruck'], ['song.flac', 'song']];
  for (const [title, expected] of cases) assert.equal(sanitizeFilename(encodeURIComponent(title)), expected);
});

test('上傳欄位不是合法的 URL 編碼：400', async () => {
  const r = await fetch(base + '/web/api/upload', { method: 'POST', body: 'x', headers: { 'x-upload-filename': '%E0%A4%A' } });
  assert.equal(r.status, 400);
});

test('同名檔案已存在：409，原本的檔案不會被覆蓋', async () => {
  const fp = touch(MUSIC, 'fav/已存在.mp3', 'original');
  try {
    const r = await upload({ 'x-upload-filename': 'x.flac', 'x-upload-title': '已存在', 'x-upload-folder': 'fav' });
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(fp, 'utf8'), 'original');
    assert.deepEqual(leftovers().filter((f) => /\.tmp/.test(f)), [], '沒有留下暫存檔');
  } finally { fs.rmSync(path.join(MUSIC, 'fav'), { recursive: true, force: true }); }
});

test('target / mode 不合法：400；保留原檔只限私人上傳', async () => {
  assert.equal((await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-target': 'public' })).status, 400);
  assert.equal((await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-mode': 'raw' })).status, 400);
  const r = await upload({ 'x-upload-filename': 'a.flac', 'x-upload-mode': 'original' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /只有私人上傳/);
});

test('私人上傳＋保留原檔：先回 202 排隊，背景處理後存到 .private/<uid>/，副檔名不變，不出現在共用清單', async () => {
  const r = await upload({ 'x-upload-filename': 'Song.flac', 'x-upload-title': '我的歌', 'x-upload-folder': 'live', 'x-upload-target': 'private', 'x-upload-mode': 'original' }, Buffer.from('flac-bytes'));
  assert.equal(r.status, 202);
  const { job } = await r.json();
  assert.equal(job.filename, `.private/${OWNER}/live/我的歌.flac`);
  assert.ok(['queued', 'processing'].includes(job.status));
  await routes.idle();
  const jobs = (await (await fetch(base + '/web/api/upload/jobs')).json()).jobs;
  const done = jobs.find((x) => x.id === job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.method, 'original');
  assert.equal(fs.readFileSync(path.join(MUSIC, '.private', OWNER, 'live', '我的歌.flac'), 'utf8'), 'flac-bytes');
  store.invalidateList();
  assert.deepEqual((await store.listAll()).map((f) => f.filename), [], '共用清單（Bot、快取清理）看不到');
  assert.deepEqual((await store.listPrivate(OWNER)).map((f) => f.filename), [`.private/${OWNER}/live/我的歌.flac`]);
  assert.deepEqual(leftovers().filter((f) => /\.tmp/.test(f)), []);
});

test('沒有 Discord 帳號（只帶內部金鑰）不能私人上傳：403', async () => {
  user = { id: null, admin: true };
  try {
    const r = await upload({ 'x-upload-filename': 'a.mp3', 'x-upload-target': 'private', 'x-upload-mode': 'original' });
    assert.equal(r.status, 403);
  } finally { user = { id: OWNER, admin: true }; }
});

test('私人配額：超過 PRIVATE_QUOTA_MB 回 507，不留下檔案', async () => {
  const big = Buffer.alloc(1024 * 1024 + 10, 1);
  const r = await upload({ 'x-upload-filename': 'big.flac', 'x-upload-target': 'private', 'x-upload-mode': 'original' }, big);
  assert.equal(r.status, 507);
  assert.match((await r.json()).error, /私人空間不足/);
  assert.ok(!leftovers().some((f) => /big/.test(f)));
});

test('預檢：逐檔檢查格式、整批估算、超過私人配額時 ok=false', async () => {
  let r = await postJson('/web/api/upload/preflight', {
    target: 'private', mode: 'original',
    files: [{ name: 'a.flac', size: 600 * 1024 }, { name: 'b.txt', size: 10 }, { name: 'c.flac', size: 600 * 1024 }],
  });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.items[1].ok, false);
  assert.equal(j.estimatedBytes, 1200 * 1024);
  assert.match(j.warnings.join(), /配額/);

  r = await postJson('/web/api/upload/preflight', { target: 'library', files: [{ name: 'a.flac', size: 10 * 1024 * 1024 }] });
  j = await r.json();
  assert.equal(j.ok, true, '公開上傳不受私人配額限制');
  assert.equal(j.estimatedBytes, estimateOutputBytes('a.flac', 10 * 1024 * 1024, 'transcode'));

  assert.equal((await postJson('/web/api/upload/preflight', { target: 'library', mode: 'original', files: [] })).status, 400);
});

test('用量：回傳公開、快取、私人、磁碟與各項上限', async () => {
  touch(MUSIC, 'pub/a.mp3', 'abc');
  touch(MUSIC, 'x [yt_abcdefghijk].mp3', 'cache!');
  store.invalidateList();
  const j = await (await fetch(base + '/web/api/upload/usage')).json();
  assert.equal(j.library.files, 1);
  assert.equal(j.library.bytes, 3);
  assert.equal(j.cache.files, 1);
  assert.equal(j.private.files, 1);
  assert.equal(j.private.quotaBytes, 1024 * 1024);
  assert.ok('freeBytes' in j.disk);
  assert.equal(j.disk.minFreeBytes, 0);
});

test('估算：MP3 不變、無損格式大幅縮小、保留原檔不變', () => {
  assert.equal(estimateOutputBytes('a.mp3', 1000, 'transcode'), 1000);
  assert.ok(estimateOutputBytes('a.flac', 1000, 'transcode') < 500);
  assert.ok(estimateOutputBytes('a.wav', 1000, 'transcode') < 300);
  assert.equal(estimateOutputBytes('a.wav', 1000, 'original'), 1000);
});

test('工作清單只看得到自己的；清除只清掉已完成的', async () => {
  user = { id: '333333333333333333', admin: true };
  try {
    assert.deepEqual((await (await fetch(base + '/web/api/upload/jobs')).json()).jobs, []);
  } finally { user = { id: OWNER, admin: true }; }
  assert.ok((await (await fetch(base + '/web/api/upload/jobs')).json()).jobs.length > 0);
  assert.equal((await postJson('/web/api/upload/jobs/clear', {})).status, 200);
  assert.deepEqual((await (await fetch(base + '/web/api/upload/jobs')).json()).jobs, []);
});

test('背景佇列：一次處理一首、依上傳順序；同名的歌還在排隊時回 409；處理失敗時狀態 error 且不留暫存檔', async () => {
  const normalizer = require('../ytdlp/musicNormalizer');
  const orig = normalizer.processUpload;
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  normalizer.processUpload = async (input, output, opts) => {
    order.push(path.basename(output).split('.')[0]);
    await gate;
    if (/壞掉/.test(output)) throw new Error('模擬轉檔失敗');
    fs.copyFileSync(input, output);
    return { method: 'transcode' };
  };
  try {
    const send = (title) => upload({ 'x-upload-filename': 'a.flac', 'x-upload-title': title, 'x-upload-folder': 'q' });
    const ids = [];
    for (const t of ['第一首', '壞掉', '第三首']) {
      const r = await send(t);
      assert.equal(r.status, 202, t);
      ids.push((await r.json()).job.id);
    }
    assert.equal((await send('第三首')).status, 409, '同名的歌還在排隊');
    let jobs = (await (await fetch(base + '/web/api/upload/jobs')).json()).jobs;
    assert.equal(jobs.filter((j) => j.status === 'processing').length, 1, '一次只處理一首');
    assert.equal(jobs.find((j) => j.id === ids[2]).position, 2);

    release();
    await routes.idle();
    assert.deepEqual(order, ['第一首', '壞掉', '第三首']);
    jobs = (await (await fetch(base + '/web/api/upload/jobs')).json()).jobs;
    const st = Object.fromEntries(jobs.filter((j) => ids.includes(j.id)).map((j) => [j.title, j]));
    assert.equal(st['第一首'].status, 'done');
    assert.equal(st['第三首'].status, 'done');
    assert.equal(st['壞掉'].status, 'error');
    assert.match(st['壞掉'].error, /模擬轉檔失敗/);
    assert.ok(fs.existsSync(path.join(MUSIC, 'q', '第一首.mp3')));
    assert.ok(!fs.existsSync(path.join(MUSIC, 'q', '壞掉.mp3')));
    assert.deepEqual(leftovers().filter((f) => /\.tmp/.test(f)), []);
  } finally {
    normalizer.processUpload = orig;
    release();
  }
});
