'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

process.env.NODE_ENV = 'test'; // express 預設錯誤處理在 test 環境不印堆疊（壞 JSON 那個案例是預期中的錯誤）
process.env.WEB_PLAYER_PASSWORD = 'correct horse';
process.env.WEB_SESSION_SECRET = 'test-session-secret';
delete process.env.WEB_SESSION_HOURS;
// 已登出清單存在 WEB_SESSION_SECRET_FILE 同一個資料夾：測試一律放暫存目錄，不寫進 repo 的 data/
const TMP_SESSION_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mls-auth-'));
process.env.WEB_SESSION_SECRET_FILE = require('path').join(TMP_SESSION_DIR, 'session-secret');
const { mountWebAuth } = require('../webplayer/webAuth');

let base, server;
test.before(async () => {
  const app = express();
  const { requireWebAuth } = mountWebAuth(app, { libSecret: 'lib-key' });
  app.get('/protected', requireWebAuth, (req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  require('fs').rmSync(TMP_SESSION_DIR, { recursive: true, force: true });
});

// 每個測試用不同的 X-Forwarded-For，限流計數才不會互相影響（trust proxy = 1）
let ipSeq = 0;
const newIp = () => `203.0.113.${++ipSeq}`;
const login = (password, ip, extra = {}) => fetch(base + '/web/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...extra }, body: JSON.stringify({ password }),
});
// 簽章金鑰＝HMAC(WEB_SESSION_SECRET, 'ml-session:' + 密碼)：換密碼＝所有 Cookie 失效
const SESSION_KEY = crypto.createHmac('sha256', 'test-session-secret').update('ml-session:correct horse').digest();
const sign = (payload) => crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');
const get = (headers = {}) => fetch(base + '/protected', { headers });

test('未設定 WEB_PLAYER_PASSWORD 時不掛載（回傳 null）', () => {
  const saved = process.env.WEB_PLAYER_PASSWORD;
  process.env.WEB_PLAYER_PASSWORD = '';
  try { assert.equal(mountWebAuth(express(), { libSecret: '' }), null); } finally { process.env.WEB_PLAYER_PASSWORD = saved; }
});

test('密碼正確：發出 HttpOnly、SameSite=Strict 的 Cookie，可存取受保護路由', async () => {
  const r = await login('correct horse', newIp());
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^ml_session=\d+\.[\w-]+;/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.doesNotMatch(sc, /SameSite=Lax/);
  assert.match(sc, /ml_device=\d+\.[\w-]+;/, '同時發出信任裝置 Cookie');
  assert.match(sc, /Max-Age=604800/, '預設 7 天');
  assert.doesNotMatch(sc, /Secure/, 'http 連線不加 Secure');
  const cookie = sc.split(';')[0];
  assert.equal((await get({ cookie })).status, 200);
});

test('經由 https 反向代理時 Cookie 加上 Secure', async () => {
  const r = await login('correct horse', newIp(), { 'X-Forwarded-Proto': 'https' });
  assert.match(r.headers.get('set-cookie'), /; Secure/);
});

test('密碼錯誤、缺少或型別不對：401', async () => {
  for (const body of ['wrong', '', 123, null]) {
    const r = await login(body, newIp());
    assert.equal(r.status, 401, JSON.stringify(body));
  }
  const bad = await fetch(base + '/web/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': newIp() }, body: '{bad json' });
  assert.ok(bad.status >= 400 && bad.status < 500);
});

test('Cookie 被竄改、過期、格式錯誤：401', async () => {
  const future = String(Date.now() + 3600e3);
  const past = String(Date.now() - 1000);
  for (const token of [
    `${future}.${sign(future).slice(0, -2)}xx`,       // 簽章被改
    `${String(Number(future) + 1)}.${sign(future)}`,  // 延長期限但沿用舊簽章
    `${past}.${sign(past)}`,                          // 簽章正確但已過期
    'garbage', `${future}`, `abc.${sign('abc')}`, '',
  ]) {
    assert.equal((await get({ cookie: `ml_session=${token}` })).status, 401, token);
  }
  assert.equal((await get({ cookie: `ml_session=${future}.${sign(future)}` })).status, 200, '對照：正確簽章且未過期可通過');
  assert.equal((await get()).status, 401, '沒有 Cookie');
});

test('內部金鑰 x-music-lib-key 也可通過；錯誤金鑰不行', async () => {
  assert.equal((await get({ 'x-music-lib-key': 'lib-key' })).status, 200);
  assert.equal((await get({ 'x-music-lib-key': 'wrong' })).status, 401);
});

test('限流：同一 IP 失敗 10 次後回 429（連正確密碼也擋），其他 IP 不受影響；成功登入會清除計數', async () => {
  const ip = newIp();
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong', ip)).status, 401);
  const blocked = await login('correct horse', ip);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login('correct horse', newIp())).status, 200, '其他 IP 正常');

  const ip2 = newIp();
  for (let i = 0; i < 9; i++) await login('wrong', ip2);
  assert.equal((await login('correct horse', ip2)).status, 200, '第 10 次之前成功登入');
  for (let i = 0; i < 9; i++) assert.equal((await login('wrong', ip2)).status, 401, '計數已清除，又可以再錯 9 次');
});

// 模擬正式環境：平台代理把它看到的 Cloudflare 節點 IP 追加在 X-Forwarded-For 最右邊
const CF_EDGE = '172.68.87.188';
const viaCloudflare = (user) => ({ 'X-Forwarded-For': `${user}, ${CF_EDGE}`, 'CF-Connecting-IP': user });

test('限流（經過 Cloudflare）：以 CF-Connecting-IP 區分使用者，同一個節點後面的其他人不受影響', async () => {
  const attacker = newIp(), victim = newIp();
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong', null, viaCloudflare(attacker))).status, 401);
  assert.equal((await login('correct horse', null, viaCloudflare(attacker))).status, 429, '亂試密碼的人被擋');
  assert.equal((await login('correct horse', null, viaCloudflare(victim))).status, 200, '同一個 Cloudflare 節點的其他人照常登入');
});

test('限流（繞過 Cloudflare）：偽造 CF-Connecting-IP 不能換額度', async () => {
  const real = newIp();
  for (let i = 0; i < 10; i++) {
    // 平台代理追加的是攻擊者真實 IP（不是 Cloudflare），每次換一個假的 CF-Connecting-IP 都沒用
    assert.equal((await login('wrong', real, { 'CF-Connecting-IP': `198.51.100.${i + 1}` })).status, 401);
  }
  assert.equal((await login('correct horse', real, { 'CF-Connecting-IP': '198.51.100.99' })).status, 429);
});

test('跨站請求（Sec-Fetch-Site: cross-site）：就算帶著有效的 Cookie 也回 403；同站與沒有這個標頭的照常', async () => {
  const cookie = (await login('correct horse', newIp())).headers.get('set-cookie').split(';')[0];
  assert.equal((await get({ cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get({ cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await get({ cookie, 'Sec-Fetch-Site': 'none' })).status, 200, '使用者自己在網址列輸入');
  assert.equal((await get({ cookie })).status, 200, '舊瀏覽器沒有 Sec-Fetch-Site');
  assert.equal((await get({ 'x-music-lib-key': 'lib-key', 'Sec-Fetch-Site': 'cross-site' })).status, 200, '內部金鑰不受影響');
});

test('設定了 WEB_SESSION_SECRET 也跟密碼綁定：換密碼後舊 Cookie 失效', async () => {
  const cookie = (await login('correct horse', newIp())).headers.get('set-cookie').split(';')[0];
  const saved = process.env.WEB_PLAYER_PASSWORD;
  process.env.WEB_PLAYER_PASSWORD = 'a different password';
  try {
    const app = express();
    const { requireWebAuth } = mountWebAuth(app, { libSecret: '' });
    app.get('/p', requireWebAuth, (req, res) => res.json({ ok: true }));
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/p`, { headers: { cookie } })).status, 401);
    } finally { s.close(); }
  } finally {
    process.env.WEB_PLAYER_PASSWORD = saved;
  }
});

test('登出：清除 Cookie（Max-Age=0）', async () => {
  const r = await fetch(base + '/web/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^ml_session=; .*Max-Age=0/);
});

test('限流（IPv6）：同一個 /64 裡換位址不能換額度', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login('wrong', `2001:db8:aa:bb::${i + 1}`)).status, 401);
  assert.equal((await login('correct horse', '2001:db8:aa:bb::ffff')).status, 429);
  assert.equal((await login('correct horse', '2001:db8:aa:cc::1')).status, 200, '其他 /64 不受影響');
});

test('登出後，這個 Cookie 就算被複製走也不能再用（服務重新啟動後也一樣）；其他裝置的 Cookie 不受影響', async () => {
  const c1 = (await login('correct horse', newIp())).headers.get('set-cookie').split(';')[0];
  await new Promise((r) => setTimeout(r, 5)); // 到期時間不同 → 不同 token
  const c2 = (await login('correct horse', newIp())).headers.get('set-cookie').split(';')[0];
  assert.notEqual(c1, c2);
  assert.equal((await fetch(base + '/web/logout', { method: 'POST', headers: { cookie: c1 } })).status, 200);
  assert.equal((await get({ cookie: c1 })).status, 401);
  assert.equal((await get({ cookie: c2 })).status, 200);

  // 模擬重新部署：重新掛載，已登出清單從檔案讀回來
  const app = express();
  const { requireWebAuth } = mountWebAuth(app, { libSecret: '' });
  app.get('/p', requireWebAuth, (req, res) => res.json({ ok: true }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const b = `http://127.0.0.1:${s.address().port}`;
    assert.equal((await fetch(b + '/p', { headers: { cookie: c1 } })).status, 401, '重新啟動後登出仍然有效');
    assert.equal((await fetch(b + '/p', { headers: { cookie: c2 } })).status, 200);
  } finally { s.close(); }
});

test('未設定 WEB_SESSION_SECRET：自動產生隨機金鑰存檔（重啟後沿用），簽章金鑰不再只由密碼決定', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mls-sess-'));
  const saved = { secret: process.env.WEB_SESSION_SECRET, file: process.env.WEB_SESSION_SECRET_FILE };
  delete process.env.WEB_SESSION_SECRET;
  process.env.WEB_SESSION_SECRET_FILE = path.join(dir, 'session-secret');
  const servers = [];
  const boot = async () => {
    const app = express();
    const { requireWebAuth } = mountWebAuth(app, { libSecret: '' });
    app.get('/p', requireWebAuth, (req, res) => res.json({ ok: true }));
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    servers.push(s);
    return `http://127.0.0.1:${s.address().port}`;
  };
  try {
    const b1 = await boot();
    const sc = (await fetch(b1 + '/web/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) })).headers.get('set-cookie');
    const cookie = sc.split(';')[0];
    assert.ok(fs.readFileSync(process.env.WEB_SESSION_SECRET_FILE, 'utf8').trim().length >= 32);
    const [exp, mac] = cookie.slice('ml_session='.length).split('.');
    const oldStyle = crypto.createHmac('sha256', crypto.createHash('sha256').update('ml-session:correct horse').digest()).update(exp).digest('base64url');
    assert.notEqual(mac, oldStyle, '光知道密碼算不出簽章');
    const b2 = await boot(); // 模擬重新啟動：讀同一個金鑰檔
    assert.equal((await fetch(b2 + '/p', { headers: { cookie } })).status, 200);
  } finally {
    for (const s of servers) s.close();
    if (saved.secret === undefined) delete process.env.WEB_SESSION_SECRET; else process.env.WEB_SESSION_SECRET = saved.secret;
    if (saved.file === undefined) delete process.env.WEB_SESSION_SECRET_FILE; else process.env.WEB_SESSION_SECRET_FILE = saved.file;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 全站上限會影響同一個 app 後續的登入，所以放在這個檔案最後
test('限流（全站）：大量不同 IP 一起猜，失敗總數到上限後所有來源暫停登入；成功登入過的裝置不受影響', async () => {
  const device = (await login('correct horse', newIp())).headers.get('set-cookie')
    .split(/,\s*(?=ml_)/).find((c) => c.startsWith('ml_device=')).split(';')[0];
  let status;
  for (let i = 0; i < 120; i++) {
    status = (await login('wrong', `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}`)).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
  assert.equal((await login('correct horse', newIp())).status, 429, '全新的 IP 也要等');
  assert.equal((await get({ 'x-music-lib-key': 'lib-key' })).status, 200, '已登入／內部金鑰不受影響');
  assert.equal((await login('correct horse', newIp(), { cookie: device })).status, 200, '信任裝置不受全站上限影響');
  assert.equal((await login('wrong', newIp(), { cookie: 'ml_device=99999999999999.forged' })).status, 429, '偽造的信任裝置 Cookie 沒用');
});
