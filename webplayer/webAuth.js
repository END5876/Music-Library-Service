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
//   WEB_SESSION_SECRET   簽 Cookie 用的金鑰。未設定時自動產生一組隨機金鑰存在 WEB_SESSION_SECRET_FILE，
//                        再和密碼一起衍生出簽章金鑰（換密碼＝全部登出）。
//                        以前是直接由密碼衍生：拿到任何一個 Cookie 就能離線暴力猜密碼。
//   WEB_SESSION_SECRET_FILE  自動產生的金鑰存放位置，預設 <repo root>/data/session-secret（Docker 內為 /app/data，掛 Volume）
//   WEB_SESSION_HOURS    登入有效時數，預設 168（7 天）
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

  const SESSION_KEY = process.env.WEB_SESSION_SECRET || crypto
    .createHmac('sha256', loadOrCreateSessionSecret(
      process.env.WEB_SESSION_SECRET_FILE || path.join(__dirname, '..', 'data', 'session-secret')))
    .update(`ml-session:${PASSWORD}`)
    .digest();
  const SESSION_HOURS = Math.max(1, parseFloat(process.env.WEB_SESSION_HOURS || '168') || 168);
  const SESSION_MS = SESSION_HOURS * 3600 * 1000;

  // 部署平台的反向代理後面：讓 req.secure（Cookie 的 Secure）與 req.ip 取到平台代理看到的值（只信任一層）。
  // 限流用的使用者 IP 另外由 clientIp() 處理前面還有 Cloudflare 的情況。
  app.set('trust proxy', 1);

  const sign = (payload) =>
    crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');

  function issueToken() {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  }

  // 已登出的 token（簽章 → 到期時間）。只存在記憶體：服務重新啟動後清空，最多保留 MAX_REVOKED 筆
  const revoked = new Map();
  const MAX_REVOKED = 10000;

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
  }

  function cookieString(req, value, maxAgeSec) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
  }

  // 已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行
  function requireWebAuth(req, res, next) {
    if (verifyToken(getCookie(req, COOKIE_NAME))) return next();
    const key = req.get('x-music-lib-key');
    if (libSecret && key && safeEqual(key, libSecret)) return next();
    res.status(401).json({ error: '請先登入' });
  }

  // ── 登入嘗試限流 ──────────────────────────────────────────
  //   - 每個來源 10 分鐘內最多 10 次失敗（IP 的判斷見 clientIp.js；IPv6 以 /64 為單位，換位址繞不過）
  //   - 全站 10 分鐘內最多 GLOBAL_MAX_FAILS 次失敗：大量不同 IP 一起猜時整體暫停登入。
  //     代價是攻擊期間正確密碼也要等一下才能登入，但已登入的裝置（Cookie）不受影響。
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
      : globalFails.count >= GLOBAL_MAX_FAILS ? globalFails.resetAt : 0;
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
    res.set('Set-Cookie', cookieString(req, issueToken(), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true });
  });

  app.post('/web/logout', (req, res) => {
    revokeToken(getCookie(req, COOKIE_NAME)); // 讓這個 Cookie 就算被複製走也不能再用
    res.set('Set-Cookie', cookieString(req, '', 0));
    res.json({ ok: true });
  });

  return { requireWebAuth };
}

module.exports = { mountWebAuth };
