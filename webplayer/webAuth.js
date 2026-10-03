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
//   WEB_SESSION_SECRET   簽 Cookie 用的金鑰，預設由密碼衍生（換密碼＝全部登出）
//   WEB_SESSION_HOURS    登入有效時數，預設 168（7 天）
//
// 路由：
//   POST /web/login          { password } → 設定 Cookie
//   POST /web/logout         清除 Cookie
//
// 回傳 { requireWebAuth }：已登入的瀏覽器（Cookie）或帶了內部金鑰的呼叫端都放行，
// 供其他網頁路由（曲目清單、線上串流、播放清單）掛在路由前面使用。

const crypto = require('crypto');
const express = require('express');

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

function mountWebAuth(app, { libSecret }) {
  const PASSWORD = process.env.WEB_PLAYER_PASSWORD || '';
  if (!PASSWORD) return null;

  const SESSION_KEY = process.env.WEB_SESSION_SECRET || sha256(`ml-session:${PASSWORD}`);
  const SESSION_HOURS = Math.max(1, parseFloat(process.env.WEB_SESSION_HOURS || '168') || 168);
  const SESSION_MS = SESSION_HOURS * 3600 * 1000;

  // 服務的反向代理後面：讓 req.ip / req.secure 取到真實值（只信任一層）
  app.set('trust proxy', 1);

  const sign = (payload) =>
    crypto.createHmac('sha256', SESSION_KEY).update(payload).digest('base64url');

  function issueToken() {
    const exp = String(Date.now() + SESSION_MS);
    return `${exp}.${sign(exp)}`;
  }

  function verifyToken(token) {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const exp = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
    return safeEqual(mac, sign(exp));
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

  // ── 登入嘗試限流（每個 IP 10 分鐘內最多 10 次失敗）──────────
  const failures = new Map(); // ip -> { count, resetAt }
  const MAX_FAILS = 10;
  const WINDOW_MS = 10 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, f] of failures) if (f.resetAt <= now) failures.delete(ip);
  }, WINDOW_MS).unref();

  // 只有這條路由解析 JSON body，音樂庫的 PUT 上傳仍是原始串流
  app.post('/web/login', express.json({ limit: '2kb' }), (req, res) => {
    const now = Date.now();
    let rec = failures.get(req.ip);
    if (!rec || rec.resetAt <= now) rec = { count: 0, resetAt: now + WINDOW_MS };
    if (rec.count >= MAX_FAILS) {
      res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ error: '嘗試次數過多，請稍後再試' });
    }

    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!password || !safeEqual(password, PASSWORD)) {
      rec.count += 1;
      failures.set(req.ip, rec);
      return res.status(401).json({ error: '密碼錯誤' });
    }

    failures.delete(req.ip);
    res.set('Set-Cookie', cookieString(req, issueToken(), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true });
  });

  app.post('/web/logout', (req, res) => {
    res.set('Set-Cookie', cookieString(req, '', 0));
    res.json({ ok: true });
  });

  return { requireWebAuth };
}

module.exports = { mountWebAuth };
