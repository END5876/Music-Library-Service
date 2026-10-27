'use strict';
// 網頁播放器的 Discord 登入：任何帳號都能登入、管理員、封鎖、Cookie、登出、代碼交接（主畫面 App）。
// Discord 端用本機假的伺服器代替（DISCORD_API_BASE / DISCORD_AUTHORIZE_URL）。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

process.env.NODE_ENV = 'test';
const { mountWebAuth } = require('../webplayer/webAuth');

const ALICE = '111111111111111111'; // 管理員（WEB_ADMIN_USERS）
const BOB = '222222222222222222';   // 一般的 Discord 帳號
const EVE = '555555555555555555';   // 被封鎖（WEB_BLOCKED_USERS）

// ── 假的 Discord：授權碼 code-<id> 換到 token tok-<id> ──
let discordDown = false;
const bearer = (req) => (/^Bearer tok-(\d+)$/.exec(req.get('authorization') || '') || [])[1];
const discord = express();
discord.post('/api/oauth2/token', express.urlencoded({ extended: false }), (req, res) => {
  if (discordDown) return res.status(500).json({ error: 'server_error' });
  const m = /^code-(\d+)$/.exec(req.body.code || '');
  if (!m || req.body.client_id !== 'client-id' || req.body.client_secret !== 'client-secret'
    || req.body.redirect_uri !== 'https://music.test/auth/discord/callback') {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  res.json({ access_token: `tok-${m[1]}`, token_type: 'Bearer' });
});
discord.get('/api/users/@me', (req, res) => {
  const id = bearer(req);
  if (!id) return res.status(401).json({});
  res.json({ id, username: `user-${id.slice(0, 3)}`, global_name: id === ALICE ? 'Alice <b>' : null });
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mls-auth-'));
const servers = [];
let BASE_ENV;
let main; // 預設設定（管理員 Alice、封鎖 Eve）的服務

test.before(async () => {
  const s = await new Promise((r) => { const x = discord.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  BASE_ENV = {
    DISCORD_CLIENT_ID: 'client-id',
    DISCORD_CLIENT_SECRET: 'client-secret',
    PUBLIC_BASE_URL: 'https://music.test/',
    WEB_ADMIN_USERS: ALICE,
    WEB_BLOCKED_USERS: EVE,
    WEB_ALLOWED_USERS: undefined,
    WEB_ALLOWED_GUILD: undefined,
    WEB_ALLOWED_ROLES: undefined,
    WEB_PLAYER_PASSWORD: undefined,
    WEB_SESSION_HOURS: undefined,
    WEB_SESSION_SECRET: 'test-session-secret',
    // 已登出清單存在 WEB_SESSION_SECRET_FILE 同一個資料夾：測試一律放暫存目錄，不寫進 repo 的 data/
    WEB_SESSION_SECRET_FILE: path.join(TMP, 'session-secret'),
    DISCORD_API_BASE: `http://127.0.0.1:${s.address().port}/api`,
    DISCORD_AUTHORIZE_URL: 'https://discord.test/oauth2/authorize',
  };
  main = await boot();
});
test.after(() => {
  for (const s of servers) s.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// 用 BASE_ENV（加上 overrides，值為 undefined＝不設定）掛載一個 app；設定不完整時回傳 null
function withEnv(overrides, fn) {
  const env = { ...BASE_ENV, ...overrides };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
async function boot(overrides = {}) {
  const app = express();
  const auth = withEnv(overrides, () => mountWebAuth(app, { libSecret: 'lib-key' }));
  if (!auth) return null;
  app.get('/protected', auth.requireWebAuth, (req, res) => res.json({ ok: true, user: req.webUser }));
  app.get('/admin', auth.requireWebAdmin, (req, res) => res.json({ ok: true }));
  app.get('/page', auth.requireWebPage, (req, res) => res.send('page'));
  app.get('/admin-page', auth.requireAdminPage, (req, res) => res.send('admin page'));
  app.get('/is-admin', (req, res) => res.json({ authenticated: auth.isAuthenticated(req), admin: auth.isAdmin(req) }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '');
const sessionOf = (res) => cookieOf(res, 'ml_session').split(';')[0];
const get = (base, headers = {}) => fetch(`${base}/protected`, { headers });

// 完整登入流程：/auth/discord/login →（假裝在 Discord 按了授權）→ callback；回傳 callback 的回應
async function oauth(base, userId, { next, handoff, headers = {} } = {}) {
  const q = new URLSearchParams();
  if (next !== undefined) q.set('next', next);
  if (handoff !== undefined) q.set('handoff', handoff);
  const r1 = await fetch(`${base}/auth/discord/login?${q}`, { redirect: 'manual', headers });
  assert.equal(r1.status, 302);
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const stateCookie = cookieOf(r1, 'ml_oauth_state').split(';')[0];
  return fetch(`${base}/auth/discord/callback?code=code-${userId}&state=${state}`, {
    redirect: 'manual', headers: { cookie: stateCookie, ...headers },
  });
}
const loginAs = async (base, userId) => sessionOf(await oauth(base, userId));

// 用測試的 WEB_SESSION_SECRET 自己簽 token（驗證竄改／過期／用途錯誤）
const KEY = crypto.createHmac('sha256', 'test-session-secret').update('ml-session:discord').digest();
function seal(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', KEY).update(body).digest('base64url')}`;
}


test('設定不完整時不掛載（回傳 null）：缺 Discord 設定、只剩舊的密碼變數；不需要白名單或管理員', async () => {
  const none = { DISCORD_CLIENT_ID: undefined, DISCORD_CLIENT_SECRET: undefined, PUBLIC_BASE_URL: undefined };
  assert.equal(await boot(none), null, '完全沒設定');
  assert.equal(await boot({ ...none, WEB_PLAYER_PASSWORD: 'old-password' }), null, '只有舊的 WEB_PLAYER_PASSWORD');
  assert.equal(await boot({ DISCORD_CLIENT_SECRET: undefined }), null, '缺 client secret');
  assert.equal(await boot({ PUBLIC_BASE_URL: 'music.test' }), null, 'PUBLIC_BASE_URL 不是網址');
  assert.notEqual(await boot({ WEB_ADMIN_USERS: undefined, WEB_BLOCKED_USERS: undefined }), null, '沒有管理員也能啟用（只是沒人能用管理功能）');
});

test('/auth/discord/login：導到 Discord 授權頁，state 存在 Lax、只限 /auth/discord 的 Cookie', async () => {
  const r = await fetch(`${main}/auth/discord/login`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://discord.test/oauth2/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'client-id');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://music.test/auth/discord/callback', 'PUBLIC_BASE_URL 結尾的 / 去掉');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  assert.equal(loc.searchParams.get('scope'), 'identify', '只要 identify：不讀伺服器清單、不讀 email');
  assert.equal(loc.searchParams.get('prompt'), 'none');
  assert.match(loc.searchParams.get('state'), /^[0-9a-f]{32}$/);
  const sc = cookieOf(r, 'ml_oauth_state');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Lax/, 'Discord 導回來是跨站導覽，Strict 會收不到');
  assert.match(sc, /Path=\/auth\/discord;/);
  assert.match(sc, /Max-Age=600/);
});

test('登入成功，發出 HttpOnly、SameSite=Strict、30 天的 Cookie，用同站頁面跳回播放器', async () => {
  const r = await oauth(main, ALICE);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta http-equiv="refresh" content="0;url=\/player">/);
  const sc = cookieOf(r, 'ml_session');
  assert.match(sc, /^ml_session=[\w-]+\.[\w-]+;/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/;/);
  assert.match(sc, /Max-Age=2592000/, '預設 30 天');
  assert.doesNotMatch(sc, /Secure/, 'http 連線不加 Secure');
  assert.match(cookieOf(r, 'ml_oauth_state'), /Max-Age=0/, 'state Cookie 用完清掉');
  assert.equal((await get(main, { cookie: sc.split(';')[0] })).status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('經由 https 反向代理時 Cookie 加上 Secure', async () => {
  const r = await oauth(main, ALICE, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(cookieOf(r, 'ml_session'), /; Secure/);
});

test('next：站內路徑照用（HTML 跳脫），開放式重新導向一律改回 /player', async () => {
  const r = await oauth(main, ALICE, { next: '/upload?upload=1&x=2' });
  assert.match(await r.text(), /content="0;url=\/upload\?upload=1&amp;x=2"/);
  for (const bad of ['//evil.test', '/\\evil.test', 'https://evil.test', '/\t/evil.test', 'player', '']) {
    const html = await (await oauth(main, ALICE, { next: bad })).text();
    assert.match(html, /content="0;url=\/player"/, JSON.stringify(bad));
  }
});

test('任何 Discord 帳號都能登入；被封鎖的帳號被拒絕（顯示 ID，不發 Cookie）', async () => {
  const bob = await oauth(main, BOB);
  assert.equal(bob.status, 200);
  const r = await get(main, { cookie: sessionOf(bob) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).user, { id: BOB, name: `user-${BOB.slice(0, 3)}`, admin: false });

  const eve = await oauth(main, EVE);
  assert.equal(eve.status, 302);
  assert.equal(eve.headers.get('location'), `/player?login=denied&uid=${EVE}`);
  assert.equal(cookieOf(eve, 'ml_session'), '', '被封鎖的人不發登入 Cookie');
});

test('管理員：requireWebAdmin 只放行 WEB_ADMIN_USERS 與內部金鑰；/web/api/me 告訴前端是不是管理員', async () => {
  const alice = await loginAs(main, ALICE);
  const bob = await loginAs(main, BOB);
  const admin = (headers) => fetch(`${main}/admin`, { headers });
  assert.equal((await admin({ cookie: alice })).status, 200);
  const denied = await admin({ cookie: bob });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /管理員/);
  assert.equal((await admin()).status, 401, '沒登入');
  assert.equal((await admin({ 'x-music-lib-key': 'lib-key' })).status, 200, '內部金鑰（Bot）不受影響');
  assert.equal((await admin({ cookie: alice, 'Sec-Fetch-Site': 'cross-site' })).status, 403, '跨站請求一樣擋');

  const me = async (headers) => (await fetch(`${main}/web/api/me`, { headers })).json();
  assert.deepEqual(await me({ cookie: alice }), { id: ALICE, name: 'Alice <b>', admin: true });
  assert.deepEqual(await me({ cookie: bob }), { id: BOB, name: `user-${BOB.slice(0, 3)}`, admin: false });
  assert.deepEqual(await me({ 'x-music-lib-key': 'lib-key' }), { id: null, name: '', admin: true });
  assert.equal((await fetch(`${main}/web/api/me`)).status, 401);

  const check = async (cookie) => (await fetch(`${main}/is-admin`, { headers: cookie ? { cookie } : {} })).json();
  assert.deepEqual(await check(alice), { authenticated: true, admin: true });
  assert.deepEqual(await check(bob), { authenticated: true, admin: false });
  assert.deepEqual(await check(), { authenticated: false, admin: false });
});

test('管理員頁面：沒登入導去登入；不是管理員顯示 403 頁；管理員照常', async () => {
  const r = await fetch(`${main}/admin-page?upload=1`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/auth/discord/login?next=%2Fadmin-page%3Fupload%3D1');
  const bob = await fetch(`${main}/admin-page`, { headers: { cookie: await loginAs(main, BOB) } });
  assert.equal(bob.status, 403);
  assert.ok((await bob.text()).includes(BOB), '顯示目前帳號的 ID');
  assert.equal((await fetch(`${main}/admin-page`, { headers: { cookie: await loginAs(main, ALICE) } })).status, 200);
});

test('每次請求都重新檢查：拿掉管理員、加進 WEB_BLOCKED_USERS 都立即生效', async () => {
  const alice = await loginAs(main, ALICE);
  const bob = await loginAs(main, BOB);

  const noAdmin = await boot({ WEB_ADMIN_USERS: undefined });
  assert.equal((await fetch(`${noAdmin}/admin`, { headers: { cookie: alice } })).status, 403, 'Alice 不再是管理員');
  assert.equal((await get(noAdmin, { cookie: alice })).status, 200, '但還是可以一般使用');

  const blocked = await boot({ WEB_BLOCKED_USERS: `${ALICE} ${BOB}` });
  assert.equal((await get(blocked, { cookie: alice })).status, 401, '封鎖優先於管理員');
  assert.equal((await get(blocked, { cookie: bob })).status, 401);
});

test('callback：state 不符、沒有 state Cookie、缺 code 都回 400；使用者在 Discord 按取消回到播放器', async () => {
  const r1 = await fetch(`${main}/auth/discord/login`, { redirect: 'manual' });
  const stateCookie = cookieOf(r1, 'ml_oauth_state').split(';')[0];
  const state = new URL(r1.headers.get('location')).searchParams.get('state');
  const cb = (qs, cookie) => fetch(`${main}/auth/discord/callback?${qs}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  assert.equal((await cb(`code=code-${ALICE}&state=${'0'.repeat(32)}`, stateCookie)).status, 400, 'state 不符（登入 CSRF）');
  assert.equal((await cb(`code=code-${ALICE}&state=${state}`)).status, 400, '沒有 state Cookie');
  assert.equal((await cb(`state=${state}`, stateCookie)).status, 400, '缺 code');
  const forged = `ml_oauth_state=${seal({ t: 's', state, exp: Date.now() + 60e3 })}`;
  assert.equal((await cb(`code=code-${ALICE}&state=${state}`, forged)).status, 400, '別種用途的 token 不能當 state');
  const expired = `ml_oauth_state=${seal({ t: 'o', state, next: '/player', handoff: '', exp: Date.now() - 1 })}`;
  assert.equal((await cb(`code=code-${ALICE}&state=${state}`, expired)).status, 400, 'state 過期');

  const cancelled = await cb(`error=access_denied&state=${state}`, stateCookie);
  assert.equal(cancelled.status, 302);
  assert.equal(cancelled.headers.get('location'), '/player?login=cancelled');
});

test('Discord 出錯（換 token 失敗）：回到播放器顯示登入失敗', async () => {
  discordDown = true;
  try {
    const r = await oauth(main, ALICE);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/player?login=failed');
    assert.equal(cookieOf(r, 'ml_session'), '');
  } finally { discordDown = false; }
});

test('Cookie 被竄改、過期、用途不對、帳號被封鎖：401', async () => {
  const future = Date.now() + 3600e3;
  const ok = seal({ t: 's', sid: 'a'.repeat(32), uid: ALICE, exp: future });
  assert.equal((await get(main, { cookie: `ml_session=${ok}` })).status, 200, '對照：正確簽章且未過期可通過');
  const [body, sig] = ok.split('.');
  for (const token of [
    `${body}.${sig.slice(0, -2)}xx`,                                          // 簽章被改
    `${Buffer.from(JSON.stringify({ t: 's', sid: 'a'.repeat(32), uid: ALICE, exp: future + 1 })).toString('base64url')}.${sig}`, // 改內容沿用舊簽章
    seal({ t: 's', sid: 'b'.repeat(32), uid: ALICE, exp: Date.now() - 1000 }), // 簽章正確但已過期
    seal({ t: 'o', sid: 'c'.repeat(32), uid: ALICE, exp: future }),            // OAuth state 不能當登入用
    seal({ t: 's', sid: 'd'.repeat(32), uid: EVE, exp: future }),              // 被封鎖    seal({ t: 's', uid: ALICE, exp: future }),                                 // 沒有 sid（無法撤銷）
    'garbage', `${body}`, '',
  ]) {
    assert.equal((await get(main, { cookie: `ml_session=${token}` })).status, 401, token);
  }
  assert.equal((await get(main)).status, 401, '沒有 Cookie');
});

test('內部金鑰 x-music-lib-key 也可通過；錯誤金鑰不行', async () => {
  assert.equal((await get(main, { 'x-music-lib-key': 'lib-key' })).status, 200);
  assert.equal((await get(main, { 'x-music-lib-key': 'wrong' })).status, 401);
});

test('跨站請求（Sec-Fetch-Site: cross-site）：就算帶著有效的 Cookie 也回 403；同站與沒有這個標頭的照常', async () => {
  const cookie = await loginAs(main, ALICE);
  assert.equal((await get(main, { cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get(main, { cookie, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await get(main, { cookie, 'Sec-Fetch-Site': 'none' })).status, 200, '使用者自己在網址列輸入');
  assert.equal((await get(main, { cookie })).status, 200, '舊瀏覽器沒有 Sec-Fetch-Site');
  assert.equal((await get(main, { 'x-music-lib-key': 'lib-key', 'Sec-Fetch-Site': 'cross-site' })).status, 200, '內部金鑰不受影響');
});

test('需要登入的頁面（requireWebPage）：沒登入導去 Discord 登入並帶上原本的網址', async () => {
  const r = await fetch(`${main}/page?x=1`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/auth/discord/login?next=%2Fpage%3Fx%3D1');
  const cookie = await loginAs(main, ALICE);
  assert.equal((await fetch(`${main}/page`, { headers: { cookie } })).status, 200);
});

test('登出：清除 Cookie；這個 Cookie 就算被複製走也不能再用（服務重新啟動後也一樣），其他裝置不受影響', async () => {
  const c1 = await loginAs(main, ALICE);
  const c2 = await loginAs(main, ALICE);
  assert.notEqual(c1, c2);
  const r = await fetch(`${main}/web/logout`, { method: 'POST', headers: { cookie: c1 } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^ml_session=; .*Max-Age=0/);
  assert.equal((await get(main, { cookie: c1 })).status, 401);
  assert.equal((await get(main, { cookie: c2 })).status, 200);

  const rebooted = await boot(); // 模擬重新部署：已登出清單從檔案讀回來
  assert.equal((await get(rebooted, { cookie: c1 })).status, 401, '重新啟動後登出仍然有效');
  assert.equal((await get(rebooted, { cookie: c2 })).status, 200);
  assert.equal((await fetch(`${main}/web/logout`, { method: 'POST' })).status, 200, '沒登入也可以登出');
});

test('未設定 WEB_SESSION_SECRET：自動產生隨機金鑰存檔，重新啟動後沿用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mls-sess-'));
  try {
    const env = { WEB_SESSION_SECRET: undefined, WEB_SESSION_SECRET_FILE: path.join(dir, 'session-secret') };
    const b1 = await boot(env);
    const cookie = await loginAs(b1, ALICE);
    assert.ok(fs.readFileSync(env.WEB_SESSION_SECRET_FILE, 'utf8').trim().length >= 32);
    assert.equal((await get(main, { cookie })).status, 401, '金鑰不同的服務不認這個 Cookie');
    const b2 = await boot(env);
    assert.equal((await get(b2, { cookie })).status, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 代碼交接 ──
let ipSeq = 0;
const newIp = () => `203.0.113.${++ipSeq}`;
async function startHandoff(base, ip = newIp()) {
  const r = await fetch(`${base}/auth/handoff/start`, { method: 'POST', headers: { 'X-Forwarded-For': ip } });
  if (r.status !== 200) return { status: r.status };
  const j = await r.json();
  return { status: 200, ...j, ip, id:new URL(j.loginUrl, base).searchParams.get('handoff'), cookie: cookieOf(r, 'ml_handoff').split(';')[0], setCookie: cookieOf(r, 'ml_handoff') };
}
const poll = (base, cookie, headers = {}) => fetch(`${base}/auth/handoff/poll`, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...headers } });
const confirm = (base, form, headers = {}) => fetch(`${base}/auth/handoff/confirm`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form),
});

test('代碼交接：App 取得代碼 → 瀏覽器登入並確認 → App 輪詢拿到登入 Cookie（只能拿一次）', async () => {
  const h = await startHandoff(main);
  assert.equal(h.status, 200);
  assert.match(h.code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.match(h.loginUrl, /^\/auth\/discord\/login\?handoff=[0-9a-f]{32}$/);
  assert.match(h.setCookie, /HttpOnly/);
  assert.match(h.setCookie, /SameSite=Strict/);
  assert.match(h.setCookie, /Path=\/auth\/handoff;/);

  assert.equal((await poll(main, h.cookie)).status, 202);
  assert.equal((await poll(main)).status, 410, '沒有 App 的 Cookie：只知道代碼或連結拿不走登入');

  // 瀏覽器那邊（另一個 Cookie 環境、同一個網路）：登入完不直接發 Cookie，而是顯示確認頁
  const cb = await oauth(main, ALICE, { handoff: h.id, headers: { 'X-Forwarded-For': h.ip } });
  assert.equal(cb.status, 200);
  assert.equal(cookieOf(cb, 'ml_session'), '', '瀏覽器那邊不發登入 Cookie');
  const html = await cb.text();
  assert.ok(html.includes(h.code), '確認頁顯示同一組代碼');
  assert.ok(html.includes('Alice &lt;b&gt;'), 'Discord 名稱經過 HTML 跳脫');
  assert.doesNotMatch(html, /class="warn"/, '同一個網路不顯示警告');
  const token = /name="token" value="([0-9a-f]+)"/.exec(html)[1];
  assert.equal((await (await poll(main, h.cookie)).json()).status, 'confirming');

  assert.equal((await confirm(main, { id: h.id, token: 'f'.repeat(32), action: 'approve' })).status, 410, '確認 token 不對');
  assert.equal((await confirm(main, { id: h.id, token, action: 'approve' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await poll(main, `ml_handoff=${h.id}.forged`)).status, 410, '偽造的 App Cookie');
  assert.equal((await confirm(main, { id: h.id, token, action: 'approve' })).status, 200);

  const done = await poll(main, h.cookie);
  assert.equal(done.status, 200);
  const session = sessionOf(done);
  assert.match(cookieOf(done, 'ml_session'), /SameSite=Strict/);
  assert.match(cookieOf(done, 'ml_handoff'), /Max-Age=0/);
  assert.equal((await get(main, { cookie: session })).status, 200);

  assert.equal((await poll(main, h.cookie)).status, 410, '只能拿一次');
  const reuse = await fetch(`${main}${h.loginUrl}`, { redirect: 'manual' });
  assert.equal(reuse.status, 410, '用過的登入連結不能再用');
});

test('代碼交接：確認頁按取消＝代碼作廢；被拒絕的帳號看到自己的 ID；不存在的代碼回 410', async () => {
  const h = await startHandoff(main);
  const html = await (await oauth(main, ALICE, { handoff: h.id, headers: { 'X-Forwarded-For': newIp() } })).text();
  assert.match(html, /class="warn"/, '代碼是從另一個網路要求的：醒目警告（可能是別人傳來的連結）');
  const token = /name="token" value="([0-9a-f]+)"/.exec(html)[1];
  assert.equal((await confirm(main, { id: h.id, token, action: 'cancel' })).status, 200);
  assert.equal((await poll(main, h.cookie)).status, 410);
  assert.equal((await confirm(main, { id: h.id, token, action: 'approve' })).status, 410, '取消後不能再確認');

  const h2 = await startHandoff(main);
  const denied = await oauth(main, EVE, { handoff: h2.id });
  assert.equal(denied.status, 403);
  const deniedHtml = await denied.text();
  assert.ok(deniedHtml.includes(EVE));
  assert.ok(deniedHtml.includes(`/auth/discord/login?handoff=${h2.id}&amp;switch=1`), '提供換帳號的連結');
  const p = await poll(main, h2.cookie);
  assert.equal(p.status, 202, '代碼還能讓有權限的帳號用');
  assert.deepEqual(await p.json(), { status: 'denied', uid: EVE }, 'App 看得到瀏覽器那邊被拒絕');

  // 在 Discord 按取消、Discord 出錯：App 也看得到，代碼仍然有效
  const h3 = await startHandoff(main);
  const r1 = await fetch(`${main}/auth/discord/login?handoff=${h3.id}`, { redirect: 'manual' });
  const cancelled = await fetch(`${main}/auth/discord/callback?error=access_denied`, {
    redirect: 'manual', headers: { cookie: cookieOf(r1, 'ml_oauth_state').split(';')[0] },
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await (await poll(main, h3.cookie)).json(), { status: 'cancelled' });
  discordDown = true;
  try { assert.equal((await oauth(main, ALICE, { handoff: h3.id, headers: { 'X-Forwarded-For': newIp() } })).status, 502); } finally { discordDown = false; }
  assert.deepEqual(await (await poll(main, h3.cookie)).json(), { status: 'failed' });
  assert.equal((await oauth(main, ALICE, { handoff: h3.id })).status, 200, '重試成功就進到確認頁');

  assert.equal((await fetch(`${main}/auth/discord/login?handoff=${'0'.repeat(32)}`, { redirect: 'manual' })).status, 410);
  assert.equal((await fetch(`${main}/auth/discord/login?handoff=a&handoff=b`, { redirect: 'manual' })).status, 410);
});

test('代碼交接：同一個來源最多 5 組進行中的代碼；同一個 App 重新開始或取消不佔名額；跨站請求回 403', async () => {
  const ip = newIp();
  for (let i = 0; i < 5; i++) assert.equal((await startHandoff(main, ip)).status, 200);
  assert.equal((await startHandoff(main, ip)).status, 429);
  assert.equal((await startHandoff(main)).status, 200, '其他來源不受影響');
  const cross = await fetch(`${main}/auth/handoff/start`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403);

  // 同一個 App（帶著上一組的 Cookie）重新開始：舊代碼作廢，可以一直重來
  const ip2 = newIp();
  let h = await startHandoff(main, ip2);
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${main}/auth/handoff/start`, { method: 'POST', headers: { 'X-Forwarded-For': ip2, cookie: h.cookie } });
    assert.equal(r.status, 200, `第 ${i + 2} 次`);
    assert.equal((await poll(main, h.cookie)).status, 410, '舊代碼已作廢');
    h = { cookie: cookieOf(r, 'ml_handoff').split(';')[0] };
  }
  const c = await fetch(`${main}/auth/handoff/cancel`, { method: 'POST', headers: { cookie: h.cookie } });
  assert.equal(c.status, 200);
  assert.match(cookieOf(c, 'ml_handoff'), /Max-Age=0/);
  assert.equal((await poll(main, h.cookie)).status, 410, '取消後代碼作廢');
});

test('?switch=1：顯示 Discord 同意畫面（可以換帳號），預設不顯示', async () => {
  const prompt = async (qs) => new URL((await fetch(`${main}/auth/discord/login?${qs}`, { redirect: 'manual' })).headers.get('location')).searchParams.get('prompt');
  assert.equal(await prompt(''), 'none');
  assert.equal(await prompt('switch=1'), 'consent');
});

test('每個帳號 1 小時內最多登入 60 次（避免重複登入登出把已登出清單擠爆）；別的帳號不受影響', async () => {
  const base = await boot();
  for (let i = 0; i < 60; i++) assert.equal((await oauth(base, BOB)).status, 200, `第 ${i + 1} 次`);
  const r = await oauth(base, BOB);
  assert.equal(r.status, 429);
  assert.equal(cookieOf(r, 'ml_session'), '');
  assert.equal((await oauth(base, ALICE)).status, 200);
});

// 全站失敗上限會影響同一個 app 後續的登入，所以獨立掛一個 app，並放在這個檔案最後
test('限流：Discord 換 token 失敗太多次（亂灌 callback）就暫停登入；正常登入不計次數', async () => {
  const base = await boot();
  for (let i = 0; i < 15; i++) assert.equal((await oauth(base, ALICE)).status, 200, '成功登入不計次數');
  const ip = newIp();
  discordDown = true;
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await oauth(base, ALICE, { headers: { 'X-Forwarded-For': ip } })).headers.get('location'), '/player?login=failed');
    }
    const blocked = await oauth(base, ALICE, { headers: { 'X-Forwarded-For': ip } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { discordDown = false; }
  assert.equal((await oauth(base, ALICE, { headers: { 'X-Forwarded-For': ip } })).status, 429, 'Discord 恢復後這個來源仍要等');
  assert.equal((await oauth(base, ALICE, { headers: { 'X-Forwarded-For': newIp() } })).status, 200, '其他來源不受影響');

  discordDown = true;
  try {
    let status;
    for (let i = 0; i < 120 && status !== 429; i++) {
      status = (await oauth(base, ALICE, { headers: { 'X-Forwarded-For': `198.18.${Math.floor(i / 200)}.${(i % 200) + 1}` } })).status;
    }
    assert.equal(status, 429, '大量不同來源：全站上限');
  } finally { discordDown = false; }
  assert.equal((await oauth(base, ALICE, { headers: { 'X-Forwarded-For': newIp() } })).status, 429, '全新的來源也要等');
  assert.equal((await get(base, { cookie: await loginAs(main, ALICE) })).status, 200, '已登入的 Cookie 不受影響');
});
