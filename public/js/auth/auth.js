// auth/auth.js — 登入／登出與登入狀態檢查
import { $, audio } from '../core/dom.js';
import { setSession, tryPlay } from '../audio/helpers.js';
import { loadList, render, setNow } from '../library/library.js';
import { clearDataCaches } from '../core/serviceWorker.js';
import { S } from '../core/state.js';

// ── 登入 ──
export function showLogin(msg) {
  $('login').classList.add('show');
  $('loginErr').textContent = msg || '';
  $('pw').focus();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginErr').textContent = '';
  try {
    const r = await fetch('/web/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('pw').value }),
    });
    if (r.ok) {
      $('pw').value = ''; $('login').classList.remove('show'); loadList();
      if ((S.currentFile || S.onlineCurrent) && audio.error) { audio.load(); tryPlay(); } // 播到一半登入過期:登入後接著重播
      return;
    }
    const j = await r.json().catch(() => ({}));
    $('loginErr').textContent = j.error || '登入失敗';
  } catch { $('loginErr').textContent = '連線失敗'; }
});

$('logoutBtn').addEventListener('click', async () => {
  S.pendingPlay = false;
  audio.pause();
  setSession('none');
  await fetch('/web/logout', { method: 'POST' }).catch(() => {});
  S.all = []; S.view = []; S.queue = []; S.history = []; S.byFile = new Map();
  S.playlists = []; S.plOpen = null; S.playlistCtx = null; clearDataCaches();
  S.currentFile = null; S.onlineCurrent = null;
  $('onlineResults').textContent = '';
  audio.removeAttribute('src'); audio.load();
  setNow(null); render();
  $('logoutBtn').hidden = true;
  showLogin();
});

// 任何播放錯誤都先確認登入還有效(用輕量的 capabilities,不用抓整份清單)。
// 過期就停下來要求重新登入,而不是一路「無法播放、已略過」下去。
export async function stillLoggedIn() {
  try {
    const r = await fetch('/web/api/capabilities');
    if (r.status === 401) { S.pendingPlay = false; audio.pause(); showLogin('登入已過期,請重新登入'); return false; }
  } catch {}
  return true;
}
