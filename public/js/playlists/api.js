// playlists/api.js — 播放清單 API 與載入
import { showLogin } from '../auth/auth.js';
import { PL_API, plById } from './model.js';
import { renderPlaylists } from './view.js';
import { S } from '../core/state.js';

// ── 播放清單 API ───────────────────────────────────────
export async function plApi(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('連線失敗(離線時無法編輯播放清單)'); }
  if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('請先登入'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  if (method !== 'GET') fetch(PL_API).catch(() => {}); // 順便刷新 Service Worker 的離線快取
  return j;
}

export async function loadPlaylists() {
  try { S.playlists = (await plApi('GET', PL_API)).playlists || []; } catch { return; }
  if (S.plOpen && !plById(S.plOpen)) S.plOpen = null;
  if (S.playlistCtx && plById(S.playlistCtx.id)) S.playlistCtx.items = plById(S.playlistCtx.id).items;
  renderPlaylists();
}
