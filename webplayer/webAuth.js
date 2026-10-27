'use strict';
// webplayer/webAuth.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的登入驗證：Discord 登入（OAuth2，只要 identify）→ HttpOnly Cookie。
// 任何 Discord 帳號都能登入（聽歌、線上搜尋、自己的播放清單）；會影響所有人的操作只限管理員：
// 刪除／改名／移動音樂庫檔案、上傳、Bot 正在播放（查看與遙控）、服務狀態。
//
// 為什麼不用 /api/music/* 的金鑰 header：
//   瀏覽器的 <audio src="..."> 沒辦法帶自訂 header（x-music-lib-key），
//   所以網頁改用「Discord 登入 → HttpOnly Cookie」驗證；Bot 之間的內部 API
//   完全不受影響。
//
// 預設關閉：Discord 應用程式設定好才會掛載（mountWebAuth 回傳 null）。
//
// 環境變數：
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET   Discord Developer Portal → OAuth2
//   PUBLIC_BASE_URL      網頁對外網址（例如 https://music.example.com），用來組 redirect_uri；
//                        Discord 後台的 Redirects 要填 <PUBLIC_BASE_URL>/auth/discord/callback
//   WEB_ADMIN_USERS      管理員的 Discord 使用者 ID（逗號或空白分隔）。每次請求都重新檢查：移除＝立即失效
//   WEB_BLOCKED_USERS    不能登入的 Discord 使用者 ID（已登入的也立即失效）
//   WEB_SESSION_SECRET   簽 Cookie 用的金鑰。未設定時自動產生一組隨機金鑰存在 WEB_SESSION_SECRET_FILE
//   WEB_SESSION_SECRET_FILE  自動產生的金鑰存放位置，預設 <repo root>/data/session-secret（Docker 內為 /app/data，掛 Volume）。
//                        已登出的 Cookie 清單存在同一個資料夾的 session-revoked.json，重新啟動後仍然有效
//   WEB_SESSION_HOURS    登入有效時數，預設 720（30 天）
//   TRUST_PROXY          Express 的 trust proxy 設定，預設 'loopback, linklocal, uniquelocal'
//                        （只信任從本機／私有網段連進來的反向代理，例如同一台主機上的 Caddy）
//   DISCORD_API_BASE / DISCORD_AUTHORIZE_URL   （測試用）覆寫 Discord 端點
//
// 路由：
//   GET  /auth/discord/login     ?next=<站內路徑> 或 ?handoff=<id>（&switch=1＝顯示同意畫面以便換帳號）→ 302 到 Discord 授權頁
//   GET  /auth/discord/callback  Discord 導回來：驗證 state、換 token、檢查是否被封鎖 → 設定 Cookie
//   GET  /web/api/me             目前登入的帳號 { id, name, admin }（前端用來決定要不要顯示管理功能）
//   POST /web/logout             清除 Cookie，並讓這個 Cookie 失效
//   POST /auth/handoff/start     代碼交接：主畫面 App 取得一次性代碼
//   POST /auth/handoff/poll      代碼交接：主畫面 App 輪詢，瀏覽器那邊確認後拿到登入 Cookie
//   POST /auth/handoff/confirm   代碼交接：瀏覽器那邊的確認頁送出
//   POST /auth/handoff/cancel    代碼交接：App 按取消，代碼立刻作廢
//
// 代碼交接（iOS「加入主畫面」的 App）：
//   iOS 的主畫面 App 跟 Safari 不共用 Cookie，跳到 discord.com 登入後 Cookie 會設在瀏覽器那邊，回到 App 還是沒登入。
//   所以改成：App 先要一組一次性代碼，到瀏覽器完成 Discord 登入並在確認頁按「確認」，App 輪詢拿到登入 Cookie。
//   輪詢要帶 start 時發給 App 的 Cookie，只知道代碼或連結的人拿不走這次登入。
//   🔒 確認頁一定要手動按確認：別人把他 App 的登入連結傳給你，你點開時 Discord 已授權過會直接導回來，
//   沒有這一步就等於把你的登入交給對方。
//
// 回傳給其他網頁路由掛在前面使用的 middleware：
//   requireWebAuth   已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行；設定 req.webUser = { id, name, admin }
//                    （內部金鑰：id 為 null、admin 為 true）
//   requireWebAdmin  同上，但只放行管理員（與內部金鑰）
//   requireWebPage / requireAdminPage  需要登入的頁面：沒登入導去 Discord 登入
//   isAuthenticated / isAdmin          給長連線定期重新檢查（見 botSync/routes.js 的 SSE）

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { clientIp, rateLimitKey } = require('./clientIp');
const { alert } = require('../alert');

const COOKIE_NAME = 'ml_session';
const STATE_COOKIE = 'ml_oauth_state';
const STATE_PATH = '/auth/discord';
const HANDOFF_COOKIE = 'ml_handoff';
const HANDOFF_PATH = '/auth/handoff';
const STATE_TTL_MS = 10 * 60 * 1000;   // OAuth 來回 10 分鐘內要完成
const HANDOFF_TTL_MS = 10 * 60 * 1000; // 代碼 10 分鐘內要用掉
const MAX_HANDOFFS = 500;              // 同時進行中的代碼交接上限（只存在記憶體）
const MAX_HANDOFFS_PER_IP = 5;
const DISCORD_FETCH_TIMEOUT_MS = 10000; // Discord 卡住時讓使用者看到錯誤，而不是一直轉圈
const SNOWFLAKE = /^\d{17,20}$/;
// 代碼字元：去掉容易看錯的 0/O、1/I/L
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

// 固定長度雜湊後再 timingSafeEqual，避免長度不同時洩漏資訊
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// 讀取（沒有就建立）隨機的 Session 金鑰檔；檔案系統不能寫時退回只存在記憶體（重新啟動＝全部登出）
function loadOrCreateSessionSecret(file) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v.length >= 32) return v;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('❌ [WebAuth] 讀取 Session 金鑰失敗:', err.message);
  }
  const v = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${v}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(`⚠️ [WebAuth] 無法寫入 ${file}（${err.message}），Session 金鑰只存在記憶體：服務重新啟動後需要重新登入。可改設 WEB_SESSION_SECRET`);
  }
  return v;
}

// 逗號或空白分隔的 Discord ID 清單；不是 ID 的項目略過並警告（打錯字時才看得出來為什麼登不進去）
function parseIds(value, name) {
  const ids = new Set();
  for (const v of String(value || '').split(/[\s,]+/)) {
    if (!v) continue;
    if (SNOWFLAKE.test(v)) ids.add(v);
    else console.warn(`⚠️ [WebAuth] ${name} 裡的「${v}」不是 Discord ID，已略過`);
  }
  return ids;
}

/** 只允許站內相對路徑，避免被拿來當開放式重新導向（//evil、/\evil、夾控制字元都不行）。 */
function safeNext(v) {
  if (typeof v !== 'string' || !/^\/(?![/\\])/.test(v) || /[\x00-\x1f\x7f\\]/.test(v)) return '/player';
  return v.slice(0, 500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

// 登入流程中的小頁面（錯誤、確認、跳轉）。內容全部經過 escapeHtml，body 由呼叫端組好（已跳脫）。
function sendPage(res, status, title, bodyHtml, { refresh } = {}) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="0;url=${escapeHtml(refresh)}">` : ''}<title>${escapeHtml(title)}｜裊器音樂</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:#0b0b0b;color:#fff;font-family:-apple-system,"Segoe UI","Noto Sans TC","PingFang TC","Microsoft JhengHei",Roboto,sans-serif}
main{background:#1c1c1c;border:1px solid #2e2e2e;border-radius:16px;padding:24px;width:100%;max-width:360px;display:flex;flex-direction:column;gap:14px;text-align:center}
h1{font-size:18px;margin:0}p{color:#b3b3b3;font-size:14px;line-height:1.6;margin:0}
.code{font:700 30px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.2em;color:#fff}
form{display:flex;flex-direction:column;gap:10px}
button,a.btn{height:46px;border-radius:23px;border:0;font:inherit;font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}
.primary{background:#fff;color:#000}.secondary{background:#2a2a2a;color:#fff}
p.warn{color:#ff6b81;font-weight:600}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`);
}

const backLink = '<a class="btn secondary" href="/player">回到播放器</a>';

function mountWebAuth(app, { libSecret }) {
  if (process.env.WEB_PLAYER_PASSWORD) {
    console.error('⚠️ [WebAuth] 密碼登入已移除，WEB_PLAYER_PASSWORD 不再有作用：網頁播放器改用 Discord 登入（DISCORD_CLIENT_ID 等，見 README），設定好之後請刪除這個變數');
  }

  const clientId = process.env.DISCORD_CLIENT_ID || '';
  const clientSecret = process.env.DISCORD_CLIENT_SECRET || '';
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const ADMIN_USERS = parseIds(process.env.WEB_ADMIN_USERS, 'WEB_ADMIN_USERS');
  const BLOCKED_USERS = parseIds(process.env.WEB_BLOCKED_USERS, 'WEB_BLOCKED_USERS');
  for (const old of ['WEB_ALLOWED_USERS', 'WEB_ALLOWED_GUILD', 'WEB_ALLOWED_ROLES']) {
    if (process.env[old]) console.warn(`⚠️ [WebAuth] ${old} 已經沒有作用（任何 Discord 帳號都能登入）；管理員請改設 WEB_ADMIN_USERS`);
  }

  if (!clientId || !clientSecret || !/^https?:\/\//i.test(publicBase)) {
    if (clientId || clientSecret || publicBase || process.env.WEB_PLAYER_PASSWORD) {
      console.error('❌ [WebAuth] Discord 登入設定不完整（需要 DISCORD_CLIENT_ID、DISCORD_CLIENT_SECRET、PUBLIC_BASE_URL），網頁播放器不啟用');
    }
    return null;
  }
  if (!ADMIN_USERS.size) {
    console.warn('⚠️ [WebAuth] 沒有設定 WEB_ADMIN_USERS：刪除／改名／上傳音樂、Bot 正在播放等管理功能在網頁上沒有人能用');
  }

  // 指定 API 版本：不帶版本的 /api 會落到 Discord 的預設版本，哪天預設版本調整就可能壞掉
  const API_BASE = (process.env.DISCORD_API_BASE || 'https://discord.com/api/v10').replace(/\/+$/, '');
  const AUTHORIZE_URL = process.env.DISCORD_AUTHORIZE_URL || 'https://discord.com/oauth2/authorize';
  const REDIRECT_URI = `${publicBase}/auth/discord/callback`;
  const SCOPE = 'identify';

  const secretFile = process.env.WEB_SESSION_SECRET_FILE || path.join(__dirname, '..', 'data', 'session-secret');
  const revokedFile = path.join(path.dirname(secretFile), 'session-revoked.json');
  const SESSION_KEY = crypto
    .createHmac('sha256', process.env.WEB_SESSION_SECRET || loadOrCreateSessionSecret(secretFile))
    .update('ml-session:discord')
    .digest();
  const SESSION_HOURS = Math.max(1, parseFloat(process.env.WEB_SESSION_HOURS || '720') || 720);
  const SESSION_MS = SESSION_HOURS * 3600 * 1000;

  // 反向代理後面：讓 req.secure（Cookie 的 Secure）與 req.ip 取到代理看到的值。
  // 🔒 只信任從本機／私有網段連進來的代理：以前 trust proxy = 1 是「信任一層」，服務的埠號
  // 直接對外時，攻擊者自己帶的 X-Forwarded-For 就會被當成來源 IP，換一個值就能繞過單一來源的限流。
  // 限流用的使用者 IP 另外由 clientIp() 處理前面還有 Cloudflare 的情況。
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

  // ── 簽章 token：base64url(JSON).HMAC，t 區分用途（s＝登入、o＝OAuth state），不能互相拿來用 ──
  const mac = (body) => crypto.createHmac('sha256', SESSION_KEY).update(body).digest('base64url');
  function seal(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${mac(body)}`;
  }
  function unseal(token, type) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    if (!safeEqual(token.slice(dot + 1), mac(body))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!p || p.t !== type || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
      return p;
    } catch {
      return null;
    }
  }

  // 🔒 SameSite=Strict：別的網站連過來（包含頂層導覽）都不會帶上登入 Cookie。
  // 播放器頁面本身（/player）不需要登入，開啟後的 API 請求是同站的，所以從 Discord 點連結進來不受影響。
  // 只有 OAuth state 用 Lax：Discord 導回 callback 是跨站的頂層導覽，Strict 的話瀏覽器不會帶上。
  function cookieString(req, name, value, maxAgeSec, { sameSite = 'Strict', path: p = '/' } = {}) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    return `${name}=${value}; Path=${p}; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(maxAgeSec)}${secure ? '; Secure' : ''}`;
  }

  // ── 登入 Session ──
  // 每個 Session 有自己的 sid，登出時只撤銷這一個（其他裝置不受影響）。name 只用來顯示，不做任何判斷。
  // 管理員身分不寫進 Cookie：每次請求依 WEB_ADMIN_USERS 判斷，拿掉＝立即失效。
  function sessionCookie(req, user) {
    const payload = { t: 's', sid: crypto.randomBytes(16).toString('hex'), uid: user.id, name: user.name || '', exp: Date.now() + SESSION_MS };
    return cookieString(req, COOKIE_NAME, seal(payload), SESSION_MS / 1000);
  }

  const isAllowed = (user) => !BLOCKED_USERS.has(user.uid);

  // 已登出的 Session（sid → 到期時間），最多保留 MAX_REVOKED 筆。
  // 🔒 同時寫進 session-revoked.json：只存在記憶體的話，每次部署（服務重新啟動）後，
  // 已登出但被複製走的 Cookie 又能用到到期為止。
  const MAX_REVOKED = 10000;
  const revoked = loadRevoked(revokedFile, MAX_REVOKED);

  function readSession(req) {
    const p = unseal(getCookie(req, COOKIE_NAME), 's');
    if (!p || typeof p.sid !== 'string' || typeof p.uid !== 'string' || revoked.has(p.sid)) return null;
    return p;
  }

  // 🔒 清單滿了不擠掉還沒到期的舊紀錄：不然任何人重複登入／登出一萬次，就能讓別人已登出、被複製走的 Cookie 復活。
  // 代價是清單滿的期間新的登出只清掉瀏覽器的 Cookie、不能撤銷（另外有每個帳號的登入次數上限，見 issueAllowed）。
  function revokeSession(p) {
    if (revoked.size >= MAX_REVOKED) {
      const now = Date.now();
      for (const [sid, exp] of revoked) if (exp < now) revoked.delete(sid);
      if (revoked.size >= MAX_REVOKED) {
        console.warn(`⚠️ [WebAuth] 已登出清單已滿（${MAX_REVOKED} 筆），這次登出無法撤銷 Cookie`);
        return;
      }
    }
    revoked.set(p.sid, p.exp);
    saveRevoked(revokedFile, revoked);
  }

  // 每個帳號 1 小時內最多發出 MAX_ISSUE_PER_HOUR 次登入（正常使用遠低於這個數）
  const MAX_ISSUE_PER_HOUR = 60;
  const issued = new Map(); // uid → { count, resetAt }
  function issueAllowed(uid) {
    const now = Date.now();
    let rec = issued.get(uid);
    if (!rec || rec.resetAt <= now) { rec = { count: 0, resetAt: now + 3600 * 1000 }; issued.set(uid, rec); }
    return ++rec.count <= MAX_ISSUE_PER_HOUR;
  }

  // 瀏覽器明確標示是從別的網站發出的請求（Sec-Fetch-Site: cross-site）：一律不接受 Cookie 登入。
  // 例如別的網站用 <img>、表單或 location 導向 /web/play，讓已登入的使用者代為下載並寫入共用音樂庫。
  function isCrossSite(req) {
    return req.get('sec-fetch-site') === 'cross-site';
  }

  // 這個請求的登入帳號 { id, name, admin }；沒登入、Cookie 無效、已登出、被封鎖、跨站請求都回 null
  function sessionUser(req) {
    if (isCrossSite(req)) return null;
    const p = readSession(req);
    if (!p || !isAllowed(p)) return null;
    return { id: p.uid, name: typeof p.name === 'string' ? p.name : '', admin: ADMIN_USERS.has(p.uid) };
  }

  /** 這個請求的登入 Cookie 現在是否仍然有效（給長連線定期重新檢查，見 botSync/routes.js 的 SSE）。 */
  const isAuthenticated = (req) => !!sessionUser(req);
  /** 同上，而且是管理員。 */
  const isAdmin = (req) => !!(sessionUser(req) || {}).admin;

  function hasLibKey(req) {
    const key = req.get('x-music-lib-key');
    return !!(libSecret && key && safeEqual(key, libSecret));
  }

  // 已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行
  function requireWebAuth(req, res, next) {
    const user = sessionUser(req);
    if (user) { req.webUser = user; return next(); }
    if (hasLibKey(req)) { req.webUser = { id: null, name: '', admin: true }; return next(); }
    if (isCrossSite(req)) return res.status(403).json({ error: '不接受從其他網站發出的請求' });
    res.status(401).json({ error: '請先登入' });
  }

  // 會影響所有人的操作：只放行管理員（與內部金鑰）
  function requireWebAdmin(req, res, next) {
    requireWebAuth(req, res, () => {
      if (req.webUser.admin) return next();
      res.status(403).json({ error: '只有管理員可以使用這個功能' });
    });
  }

  // 需要登入的「頁面」（例如 /upload）：沒登入就導去 Discord 登入，登入完回到原頁
  function requireWebPage(req, res, next) {
    const user = sessionUser(req);
    if (user) { req.webUser = user; return next(); }
    res.set('Cache-Control', 'no-store');
    res.redirect(302, `/auth/discord/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
  }

  function requireAdminPage(req, res, next) {
    requireWebPage(req, res, () => {
      if (req.webUser.admin) return next();
      sendPage(res, 403, '只有管理員可以使用這個功能', `<p>目前登入的帳號（ID ${escapeHtml(req.webUser.id)}）不是管理員。</p>${backLink}`);
    });
  }

  // ── 代碼交接（只存在記憶體；重新啟動＝進行中的代碼作廢，重新取得就好）──
  // id → { ip, code, secretHash, state: 'pending'|'authorized'|'approved', exp, user?, confirmToken?, notice? }
  // notice：瀏覽器那邊沒成功（denied／cancelled／failed）時記下來給 App 顯示；代碼仍然有效，可以在瀏覽器重試或換帳號
  const handoffs = new Map();
  function liveHandoff(id, state) {
    const h = typeof id === 'string' ? handoffs.get(id) : null;
    if (!h || h.exp < Date.now()) return null;
    return !state || h.state === state ? h : null;
  }
  // App 這邊：由 ml_handoff Cookie（id.secret）找到自己的代碼；只知道 id 不行
  function handoffFromCookie(req) {
    const raw = getCookie(req, HANDOFF_COOKIE) || '';
    const dot = raw.indexOf('.');
    const id = dot > 0 ? raw.slice(0, dot) : '';
    const h = liveHandoff(id);
    if (!h || !crypto.timingSafeEqual(sha256(raw.slice(dot + 1)), h.secretHash)) return null;
    return { id, h };
  }
  const clearHandoffCookie = (req) => cookieString(req, HANDOFF_COOKIE, '', 0, { path: HANDOFF_PATH });
  const expiredHandoffPage = (res) => sendPage(res, 410, '登入代碼已過期',
    '<p>這組代碼已經用過、取消或過期了。請回到主畫面 App 重新取得代碼。</p>');

  // ── 登入失敗限流 ──
  // 每次 callback 都會帶著 client secret 去 Discord 換 token；state 可以免費一直要，所以拿隨便的 code 灌 callback，
  // 就能讓伺服器對 Discord 發出大量無效請求，害伺服器的 IP 被 Discord 限流（大家都登不進來）。
  // 只計「換 token 失敗」的次數（正常登入不受影響）：每個來源 10 分鐘 10 次，全站 100 次。
  const FAIL_WINDOW_MS = 10 * 60 * 1000;
  const MAX_FAILS = 10;
  const GLOBAL_MAX_FAILS = 100;
  const failures = new Map(); // rateLimitKey → { count, resetAt }
  let globalFails = { count: 0, resetAt: Date.now() + FAIL_WINDOW_MS };
  function loginBlockedUntil(key, now) {
    const rec = failures.get(key);
    if (rec && rec.resetAt > now && rec.count >= MAX_FAILS) return rec.resetAt;
    if (globalFails.resetAt > now && globalFails.count >= GLOBAL_MAX_FAILS) return globalFails.resetAt;
    return 0;
  }
  function recordLoginFailure(key, now) {
    let rec = failures.get(key);
    if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    rec.count += 1;
    // 記憶體上限：表滿了就不再記新的來源（全站上限仍會計數）
    if (failures.has(key) || failures.size < 10000) failures.set(key, rec);
    if (globalFails.resetAt <= now) globalFails = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    globalFails.count += 1;
    if (globalFails.count === GLOBAL_MAX_FAILS) {
      alert('web-login-fail:global', `網頁播放器 ${FAIL_WINDOW_MS / 60000} 分鐘內 Discord 登入失敗達 ${GLOBAL_MAX_FAILS} 次，暫停新的登入（已登入的裝置不受影響）`);
    }
  }

  setInterval(() => {
    const now = Date.now();
    for (const [id, h] of handoffs) if (h.exp < now) handoffs.delete(id);
    for (const [sid, exp] of revoked) if (exp < now) revoked.delete(sid);
    for (const [key, f] of failures) if (f.resetAt <= now) failures.delete(key);
    for (const [uid, rec] of issued) if (rec.resetAt <= now) issued.delete(uid);
  }, 60 * 1000).unref();

  // ── Discord OAuth ──
  async function discordJson(url, init = {}) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(DISCORD_FETCH_TIMEOUT_MS) });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  }

  // 用授權碼換 token，取得使用者 ID 與名稱。Discord 的 access token 用完就丟，不存起來。
  async function fetchDiscordUser(code) {
    const tok = await discordJson(`${API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    if (!tok.ok || !tok.body.access_token) throw new Error(tok.body.error_description || tok.body.error || `token HTTP ${tok.status}`);
    const headers = { Authorization: `Bearer ${tok.body.access_token}` };

    const me = await discordJson(`${API_BASE}/users/@me`, { headers });
    const id = String(me.body.id || '');
    if (!me.ok || !SNOWFLAKE.test(id)) throw new Error(`users/@me HTTP ${me.status}`);
    return { id, uid: id, name: String(me.body.global_name || me.body.username || '').slice(0, 60) };
  }

  app.get('/auth/discord/login', (req, res) => {
    let handoff = '';
    if (req.query.handoff !== undefined) {
      if (!liveHandoff(req.query.handoff, 'pending')) return expiredHandoffPage(res);
      handoff = req.query.handoff;
    }
    const state = crypto.randomBytes(16).toString('hex');
    const token = seal({ t: 'o', state, next: safeNext(req.query.next), handoff, exp: Date.now() + STATE_TTL_MS });
    res.set('Cache-Control', 'no-store');
    res.append('Set-Cookie', cookieString(req, STATE_COOKIE, token, STATE_TTL_MS / 1000, { sameSite: 'Lax', path: STATE_PATH }));
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    // 授權過一次之後不再顯示同意畫面。?switch=1（被拒絕後重試、想換帳號）改成一定顯示：
    // 同意畫面上才有「不是你？」可以換 Discord 帳號，不然每次都會用同一個帳號直接導回來
    url.searchParams.set('prompt', req.query.switch === '1' ? 'consent' : 'none');
    res.redirect(302, url.toString());
  });

  // 代碼交接時瀏覽器那邊沒成功：記下來讓 App 顯示，並提供重試／換帳號的連結（代碼仍然有效）
  function handoffRetryPage(res, status, title, message, handoffId, notice, { switchAccount = false } = {}) {
    const h = liveHandoff(handoffId, 'pending');
    if (!h) return expiredHandoffPage(res);
    h.notice = notice;
    const retry = `/auth/discord/login?handoff=${encodeURIComponent(handoffId)}${switchAccount ? '&switch=1' : ''}`;
    return sendPage(res, status, title,
      `<p>${message}</p><a class="btn primary" href="${escapeHtml(retry)}">${switchAccount ? '換一個 Discord 帳號' : '再試一次'}</a>`);
  }

  app.get('/auth/discord/callback', async (req, res) => {
    const saved = unseal(getCookie(req, STATE_COOKIE), 'o');
    res.set('Cache-Control', 'no-store');
    res.append('Set-Cookie', cookieString(req, STATE_COOKIE, '', 0, { sameSite: 'Lax', path: STATE_PATH }));
    const { code, state, error } = req.query;

    if (typeof error === 'string') {
      if (saved && saved.handoff) {
        return handoffRetryPage(res, 200, '已取消登入', '已在 Discord 取消登入。', saved.handoff, { status: 'cancelled' });
      }
      return res.redirect(302, '/player?login=cancelled');
    }
    if (!saved || typeof state !== 'string' || !safeEqual(state, saved.state) || typeof code !== 'string') {
      return sendPage(res, 400, '登入流程已過期或無效', `<p>請回到播放器重新登入一次。</p>${backLink}`);
    }
    if (saved.handoff && !liveHandoff(saved.handoff, 'pending')) return expiredHandoffPage(res);

    const now = Date.now();
    const ipKey = rateLimitKey(clientIp(req));
    const blockedUntil = loginBlockedUntil(ipKey, now);
    if (blockedUntil) {
      res.set('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      return sendPage(res, 429, '登入嘗試太多次', `<p>請過幾分鐘再試。已經登入的裝置不受影響。</p>${backLink}`);
    }

    let user;
    try {
      user = await fetchDiscordUser(code);
    } catch (err) {
      recordLoginFailure(ipKey, Date.now());
      console.error('❌ [WebAuth] Discord 登入失敗:', err.message);
      if (saved.handoff) {
        return handoffRetryPage(res, 502, 'Discord 登入失敗', '請稍後再試一次。', saved.handoff, { status: 'failed' });
      }
      return res.redirect(302, '/player?login=failed');
    }

    if (!isAllowed(user)) {
      console.warn(`🚫 [WebAuth] 被封鎖的 Discord 帳號嘗試登入：${user.name}（${user.id}）`);
      if (saved.handoff) {
        return handoffRetryPage(res, 403, '這個帳號已被停用',
          `目前登入的 Discord 帳號是 ${escapeHtml(user.name)}（ID ${escapeHtml(user.id)}），已被管理員停用。可以換一個帳號登入。`,
          saved.handoff, { status: 'denied', uid: user.id }, { switchAccount: true });
      }
      return res.redirect(302, `/player?login=denied&uid=${user.id}`);
    }
    if (!issueAllowed(user.id)) {
      console.warn(`⚠️ [WebAuth] Discord 帳號 ${user.name}（${user.id}）1 小時內登入超過 ${MAX_ISSUE_PER_HOUR} 次，暫時拒絕`);
      return sendPage(res, 429, '登入太頻繁', `<p>這個帳號短時間內登入太多次，請過一陣子再試。</p>${backLink}`);
    }

    if (saved.handoff) {
      // 重新檢查一次：換 token 的這段時間裡，這組代碼可能已經被另一個分頁用掉了
      const h = liveHandoff(saved.handoff, 'pending');
      if (!h) return expiredHandoffPage(res);
      h.state = 'authorized';
      h.user = { id: user.id, uid: user.uid, name: user.name };
      h.confirmToken = crypto.randomBytes(16).toString('hex');
      // 主畫面 App 和瀏覽器通常是同一台裝置、同一個網路；來源不同時多一道醒目的警告（可能是別人傳來的連結）
      const otherNetwork = rateLimitKey(clientIp(req)) !== h.ip;
      return sendPage(res, 200, '確認登入主畫面 App', `
<p>要讓顯示下面這組代碼的裝置，以 <b>${escapeHtml(user.name)}</b> 的身分登入播放器嗎？</p>
<div class="code">${escapeHtml(h.code)}</div>
${otherNetwork ? '<p class="warn">⚠️ 這組代碼是從另一個網路要求的。如果不是你自己的裝置剛剛要求的（例如有人傳這個連結給你），請按取消。</p>' : ''}
<p>只有在<b>你自己的</b>主畫面 App 上看到同一組代碼時才按確認。如果這不是你剛剛要求的，請按取消。</p>
<form method="post" action="/auth/handoff/confirm">
<input type="hidden" name="id" value="${escapeHtml(saved.handoff)}">
<input type="hidden" name="token" value="${escapeHtml(h.confirmToken)}">
<button class="primary" type="submit" name="action" value="approve">確認登入</button>
<button class="secondary" type="submit" name="action" value="cancel">取消</button>
</form>`);
    }

    res.append('Set-Cookie', sessionCookie(req, user));
    // 🔒 不直接 302：登入 Cookie 是 SameSite=Strict，從 discord.com 一路導回來的這串請求在瀏覽器眼中是跨站的，
    // 302 過去的下一頁拿不到剛設定的 Cookie（/upload 這類要登入的頁面會又被導去登入，變成無限循環）。
    // 改由這個同站頁面自己跳轉，下一個請求就是同站的。
    sendPage(res, 200, '登入成功', `<p>正在返回…</p><a class="btn primary" href="${escapeHtml(saved.next)}">沒有自動跳轉請點這裡</a>`,
      { refresh: saved.next });
  });

  app.get('/web/api/me', requireWebAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(req.webUser);
  });

  app.post('/web/logout', (req, res) => {
    const p = readSession(req);
    if (p) revokeSession(p); // 讓這個 Cookie 就算被複製走也不能再用
    res.set('Set-Cookie', cookieString(req, COOKIE_NAME, '', 0));
    res.json({ ok: true });
  });

  // ── 代碼交接 ──
  app.post('/auth/handoff/start', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isCrossSite(req)) return res.status(403).json({ error: '不接受從其他網站發出的請求' });
    const now = Date.now();
    for (const [id, h] of handoffs) if (h.exp < now) handoffs.delete(id);
    // 重新開始：這個 App 之前要的代碼直接作廢，不佔名額（不然重試幾次就被下面的上限擋住）
    const prev = handoffFromCookie(req);
    if (prev) handoffs.delete(prev.id);
    const ip = rateLimitKey(clientIp(req));
    let fromIp = 0;
    for (const h of handoffs.values()) if (h.ip === ip) fromIp += 1;
    if (fromIp >= MAX_HANDOFFS_PER_IP || handoffs.size >= MAX_HANDOFFS) {
      return res.status(429).json({ error: '登入代碼要求太多次，請稍後再試' });
    }
    const id = crypto.randomBytes(16).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const code = randomCode(6);
    handoffs.set(id, { ip, code, secretHash: sha256(secret), state: 'pending', exp: now + HANDOFF_TTL_MS });
    res.append('Set-Cookie', cookieString(req, HANDOFF_COOKIE, `${id}.${secret}`, HANDOFF_TTL_MS / 1000, { path: HANDOFF_PATH }));
    res.json({ code, loginUrl: `/auth/discord/login?handoff=${id}`, expiresIn: HANDOFF_TTL_MS / 1000 });
  });

  app.post('/auth/handoff/poll', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isCrossSite(req)) return res.status(403).json({ error: '不接受從其他網站發出的請求' });
    const found = handoffFromCookie(req);
    if (!found) return res.status(410).json({ error: '登入代碼已過期，請重新取得' });
    const { id, h } = found;
    if (h.state === 'authorized') return res.status(202).json({ status: 'confirming' });
    if (h.state !== 'approved') return res.status(202).json(h.notice || { status: 'pending' });
    handoffs.delete(id);
    res.append('Set-Cookie', clearHandoffCookie(req));
    if (!isAllowed(h.user)) return res.status(403).json({ error: '這個帳號沒有使用權限' });
    res.append('Set-Cookie', sessionCookie(req, h.user));
    res.json({ ok: true });
  });

  // App 按取消：代碼立刻作廢（瀏覽器那邊就算已經登入也不能再確認）
  app.post('/auth/handoff/cancel', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (isCrossSite(req)) return res.status(403).json({ error: '不接受從其他網站發出的請求' });
    const found = handoffFromCookie(req);
    if (found) handoffs.delete(found.id);
    res.append('Set-Cookie', clearHandoffCookie(req));
    res.json({ ok: true });
  });

  app.post('/auth/handoff/confirm', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (isCrossSite(req)) return sendPage(res, 403, '不接受從其他網站發出的請求', '');
    const { id, token, action } = req.body || {};
    const h = liveHandoff(id, 'authorized');
    if (!h || typeof token !== 'string' || !safeEqual(token, h.confirmToken)) return expiredHandoffPage(res);
    if (action === 'cancel') {
      handoffs.delete(id);
      return sendPage(res, 200, '已取消', '<p>這組代碼已經作廢，那台裝置不會登入。</p>');
    }
    h.state = 'approved';
    sendPage(res, 200, '登入完成', '<p>請回到主畫面 App，幾秒內就會自動登入。這個視窗可以關掉了。</p>');
  });

  return { requireWebAuth, requireWebAdmin, requireWebPage, requireAdminPage, isAuthenticated, isAdmin };
}

// 已登出 Session 清單的持久化：{ "<sid>": <到期時間> }。讀不到或格式錯誤時從空的開始（只會讓已登出的
// Cookie 在到期前又能用，不會擋掉任何人）；寫入失敗只記 log，記憶體裡的清單照樣生效。
function loadRevoked(file, max) {
  const map = new Map();
  try {
    const now = Date.now();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [sid, exp] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (typeof exp === 'number' && exp >= now && map.size < max) map.set(sid, exp);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`⚠️ [WebAuth] 讀取已登出清單失敗（${err.message}），從空的清單開始`);
  }
  return map;
}

function saveRevoked(file, map) {
  try {
    const now = Date.now();
    const obj = {};
    for (const [sid, exp] of map) if (exp >= now) obj[sid] = exp;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`⚠️ [WebAuth] 無法寫入已登出清單 ${file}（${err.message}），重新啟動後這些 Cookie 會再度有效`);
  }
}

module.exports = { mountWebAuth };
