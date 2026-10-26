'use strict';
// webplayer/webAuth.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的登入驗證：密碼登入 → HttpOnly Cookie，以及登入嘗試限流。
//
// 為什麼不用 /api/music/* 的金鑰 header：
//   瀏覽器的 <audio src="..."> 沒辦法帶自訂 header（x-music-lib-key），
//   所以網頁改用「密碼登入 → HttpOnly Cookie」驗證；Bot 之間的內部 API
//   完全不受影響。
//
// 預設關閉：只有設定了 WEB_PLAYER_PASSWORD 才會掛載（mountWebAuth 回傳 null）。
//
// 環境變數：
//   WEB_PLAYER_PASSWORD  網頁登入密碼（未設定＝不啟用網頁播放器）
//   WEB_SESSION_SECRET   簽 Cookie 用的金鑰。未設定時自動產生一組隨機金鑰存在 WEB_SESSION_SECRET_FILE。
//                        不論哪一種，都再和密碼一起衍生出簽章金鑰：換密碼＝全部登出。
//                        （以前直接由密碼衍生：拿到任何一個 Cookie 就能離線暴力猜密碼；
//                          更早設定了 WEB_SESSION_SECRET 時則不跟密碼綁定，換密碼也登不出被複製走的 Cookie）
//   WEB_SESSION_SECRET_FILE  自動產生的金鑰存放位置，預設 <repo root>/data/session-secret（Docker 內為 /app/data，掛 Volume）。
//                        已登出的 Cookie 清單存在同一個資料夾的 session-revoked.json，重新啟動後仍然有效
//   WEB_SESSION_HOURS    登入有效時數，預設 168（7 天）
//   TRUST_PROXY          Express 的 trust proxy 設定，預設 'loopback, linklocal, uniquelocal'
//                        （只信任從本機／私有網段連進來的反向代理，例如同一台主機上的 Caddy）
//
// 路由：
//   POST /web/login          { password } → 設定 Cookie
//   POST /web/logout         清除 Cookie
//
// 回傳 { requireWebAuth }：已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行，
// 供其他網頁路由（曲目清單、線上串流、播放清單）掛在路由前面使用。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { clientIp, rateLimitKey } = require('./clientIp');

const COOKIE_NAME = 'ml_session';
// 成功登入過的裝置：全站登入鎖定（見下方限流）不擋它，攻擊者灌錯誤密碼也鎖不住擁有者
const DEVICE_COOKIE = 'ml_device';
const DEVICE_DAYS = 90;
// 密碼太短時啟動會警告（不拒絕啟動，避免換密碼前一部署就讓播放器停擺）
const MIN_PASSWORD_LENGTH = 12;

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

function mountWebAuth(app, { libSecret }) {
  const PASSWORD = process.env.WEB_PLAYER_PASSWORD || '';
  if (!PASSWORD) return null;

  if (PASSWORD.length < MIN_PASSWORD_LENGTH) {
    console.error(`⚠️ [WebAuth] WEB_PLAYER_PASSWORD 只有 ${PASSWORD.length} 個字元，建議至少 ${MIN_PASSWORD_LENGTH} 個字元的隨機密碼（分散猜測幾週就可能猜中）`);
  }

  const secretFile = process.env.WEB_SESSION_SECRET_FILE || path.join(__dirname, '..', 'data', 'session-secret');
  const revokedFile = path.join(path.dirname(secretFile), 'session-revoked.json');
  // 🔒 一律跟密碼綁定（換密碼＝所有 Cookie 失效），不論金鑰是設定的還是自動產生的
  const SESSION_KEY = crypto
    .createHmac('sha256', process.env.WEB_SESSION_SECRET || loadOrCreateSessionSecret(secretFile))
    .update(`ml-session:${PASSWORD}`)
    .digest();
  const SESSION_HOURS = Math.max(1, parseFloat(process.env.WEB_SESSION_HOURS || '168') || 168);
  const SESSION_MS = SESSION_HOURS * 3600 * 1000;

  // 反向代理後面：讓 req.secure（Cookie 的 Secure）與 req.ip 取到代理看到的值。
  // 🔒 只信任從本機／私有網段連進來的代理：以前 trust proxy = 1 是「信任一層」，服務的埠號
  // 直接對外時，攻擊者自己帶的 X-Forwarded-For 就會被當成來源 IP，換一個值就能繞過單一來源的限流。
  // 限流用的使用者 IP 另外由 clientIp() 處理前面還有 Cloudflare 的情況。
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

  const sign = (payload) =>
    crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');

  function issueToken() {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  }

  // 已登出的 token（簽章 → 到期時間），最多保留 MAX_REVOKED 筆。
  // 🔒 同時寫進 session-revoked.json：以前只存在記憶體，每次部署（服務重新啟動）後，
  // 已登出但被複製走的 Cookie 又能用到到期為止。
  const MAX_REVOKED = 10000;
  const revoked = loadRevoked(revokedFile, MAX_REVOKED);

  function verifyToken(token) {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(mac, sign(exp)) && !revoked.has(mac);
  }

  function revokeToken(token) {
    if (!verifyToken(token)) return;
    const dot = token.indexOf('.');
    if (revoked.size >= MAX_REVOKED) revoked.delete(revoked.keys().next().value);
    revoked.set(token.slice(dot + 1), Number(token.slice(0, dot)));
    saveRevoked(revokedFile, revoked);
  }

  // 🔒 SameSite=Strict：別的網站連過來（包含頂層導覽）都不會帶上登入 Cookie。
  // 播放器頁面本身（/player）不需要登入，開啟後的 API 請求是同站的，所以從 Discord 點連結進來不受影響。
  function cookieString(req, name, value, maxAgeSec) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  // 信任裝置 Cookie：<到期時間>.<簽章>，簽章金鑰同 session（換密碼＝失效）
  function issueDeviceToken() {
    const exp = String(Date.now() + DEVICE_DAYS * 86400e3);
    return `${exp}.${sign(`device:${exp}`)}`;
  }
  function isTrustedDevice(req) {
    const token = getCookie(req, DEVICE_COOKIE);
    const dot = token ? token.indexOf('.') : -1;
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    return /^\d+$/.test(exp) && Number(exp) >= Date.now() && safeEqual(token.slice(dot + 1), sign(`device:${exp}`));
  }

  // 瀏覽器明確標示是從別的網站發出的請求（Sec-Fetch-Site: cross-site）：一律不接受 Cookie 登入。
  // 例如別的網站用 <img>、表單或 location 導向 /web/play，讓已登入的使用者代為下載並寫入共用音樂庫。
  function isCrossSite(req) {
    return req.get('sec-fetch-site') === 'cross-site';
  }

  /** 這個請求的登入 Cookie 現在是否仍然有效（給長連線定期重新檢查，見 botSync/routes.js 的 SSE）。 */
  function isAuthenticated(req) {
    return !isCrossSite(req) && verifyToken(getCookie(req, COOKIE_NAME));
  }

  // 已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行
  function requireWebAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    const key = req.get('x-music-lib-key');
    if (libSecret && key && safeEqual(key, libSecret)) return next();
    if (isCrossSite(req)) return res.status(403).json({ error: '不接受從其他網站發出的請求' });
    res.status(401).json({ error: '請先登入' });
  }

  // ── 登入嘗試限流 ──────────────────────────────────────────
  //   - 每個來源 10 分鐘內最多 10 次失敗（IP 的判斷見 clientIp.js；IPv6 以 /64 為單位，換位址繞不過）
  //   - 全站 10 分鐘內最多 GLOBAL_MAX_FAILS 次失敗：大量不同 IP 一起猜時整體暫停登入。
  //     代價是攻擊期間正確密碼也要等一下才能登入，但已登入的裝置（Cookie）不受影響；
  //     🔒 成功登入過的裝置（信任裝置 Cookie）也不受全站上限影響，只受自己來源的計數限制，
  //     攻擊者灌錯誤密碼就鎖不住擁有者。
  const failures = new Map(); // key -> { count, resetAt }
  const MAX_FAILS = 10;
  const GLOBAL_MAX_FAILS = 100;
  const WINDOW_MS = 10 * 60 * 1000;
  let globalFails = { count: 0, resetAt: Date.now() + WINDOW_MS };
  setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures) if (f.resetAt <= now) failures.delete(ip);
    for (const [mac, exp] of revoked) if (exp < now) revoked.delete(mac);
  }, WINDOW_MS).unref();

  // 只有這條路由解析 JSON body，音樂庫的 PUT 上傳仍是原始串流
  app.post('/web/login', express.json({ limit: '2kb' }), (req, res) => {
    const now = Date.now();
    const ip = rateLimitKey(clientIp(req));
    let rec = failures.get(ip);
    if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + WINDOW_MS };
    if (globalFails.resetAt <= now) globalFails = { count: 0, resetAt: now + WINDOW_MS };
    const blockedUntil = rec.count >= MAX_FAILS ? rec.resetAt
      : (globalFails.count >= GLOBAL_MAX_FAILS && !isTrustedDevice(req)) ? globalFails.resetAt : 0;
    if (blockedUntil) {
      res.set('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }

    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password || !safeEqual(password, PASSWORD)) {
      rec.count += 1;
      globalFails.count += 1;
      // 記憶體上限：表滿了就不再記新的來源（全站上限仍會計數），不刪舊紀錄——否則灌入大量 IP 就能把別人的失敗次數洗掉
      if (failures.has(ip) || failures.size < 10000) failures.set(ip, rec);
      return res.status(401).json({ error: '密碼錯誤' });
    }

    failures.delete(ip);
    res.set('Set-Cookie', [
      cookieString(req, COOKIE_NAME, issueToken(), Math.floor(SESSION_MS / 1000)),
      cookieString(req, DEVICE_COOKIE, issueDeviceToken(), DEVICE_DAYS * 86400),
    ]);
    res.json({ ok: true });
  });

  app.post('/web/logout', (req, res) => {
    revokeToken(getCookie(req, COOKIE_NAME)); // 讓這個 Cookie 就算被複製走也不能再用
    // 信任裝置 Cookie 保留：這台裝置下次登入仍不受全站鎖定影響
    res.set('Set-Cookie', cookieString(req, COOKIE_NAME, '', 0));
    res.json({ ok: true });
  });

  return { requireWebAuth, isAuthenticated };
}

// 已登出 token 清單的持久化：{ "<簽章>": <到期時間> }。讀不到或格式錯誤時從空的開始（只會讓已登出的
// Cookie 在到期前又能用，不會擋掉任何人）；寫入失敗只記 log，記憶體裡的清單照樣生效。
function loadRevoked(file, max) {
  const map = new Map();
  try {
    const now = Date.now();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [mac, exp] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (typeof exp === 'number' && exp >= now && map.size < max) map.set(mac, exp);
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
    for (const [mac, exp] of map) if (exp >= now) obj[mac] = exp;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`⚠️ [WebAuth] 無法寫入已登出清單 ${file}（${err.message}），重新啟動後這些 Cookie 會再度有效`);
  }
}

module.exports = { mountWebAuth };
