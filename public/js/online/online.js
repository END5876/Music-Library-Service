// online/online.js — 線上搜尋與線上歌曲播放（YouTube / Bilibili）
import { $ } from '../core/dom.js';
import { dbg } from '../core/debug.js';
import { mkOnline } from '../queue/model.js';
import { S, offlineKeys } from '../core/state.js';
import { enc } from '../core/util.js';
import { setStatus } from '../core/toast.js';
import { showLogin } from '../auth/auth.js';
import { makeRow, onlineSub } from '../ui/rows.js';
import { markPlaying, setNow } from '../library/library.js';
import { renderNext } from '../queue/view.js';
import { entryKey, pushHistory } from '../playback/controller.js';
import { setMode } from '../ui/nav.js';
import { onlineItem } from '../playlists/model.js';
import { loadSource } from '../offline/source.js';
import { pickPlaylist } from '../playlists/picker.js';

// ── 線上搜尋/串流 ──
export async function loadCapabilities() {
  try {
    const r = await fetch('/web/api/capabilities');
    S.onlineAvailable = r.ok && !!(await r.json()).online;
  } catch { S.onlineAvailable = false; }
  document.querySelectorAll('.needs-online').forEach(el => { el.hidden = !S.onlineAvailable; });
  if (!S.onlineAvailable && S.mode === 'online') setMode('library');
}

async function apiJson(url) {
  const r = await fetch(url);
  if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('請先登入'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

const onlineRow = (r, { onClick, btn } = {}) => makeRow({
  key: 'on:' + r.url, title: r.title, sub: onlineSub(r),
  dur: r.duration && r.duration !== '未知' ? r.duration : '', btn, onClick,
});

// 加入佇列:排在其他手動加入的線上歌曲之後、隨機歌曲之前
function addToQueue(r) {
  const i = S.queue.findIndex(e => e.kind === 'lib');
  S.queue.splice(i < 0 ? S.queue.length : i, 0, mkOnline(r));
  renderNext();
  setStatus('已加入佇列:' + r.title);
}

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (S.mode !== 'online') return; // 音樂庫搜尋是即時篩選,不需要送出
  const q = $('search').value.trim();
  S.onlineQuery = q;
  if (!q) return;
  $('search').blur();
  const box = $('onlineResults');
  box.textContent = '';
  $('onlineHint').textContent = '搜尋中…';
  try {
    const isUrl = /^https?:\/\//i.test(q);
    const j = await apiJson((isUrl ? '/web/api/info?url=' : '/web/api/search?q=') + enc(q));
    // 依推測:搜尋回 { results:[...] },網址解析回單一物件或 { item }
    const list = j.results || (j.item ? [j.item] : (j.url || j.title ? [j] : []));
    if (!list.length) { $('onlineHint').textContent = '找不到結果'; return; }
    $('onlineHint').textContent = `找到 ${list.length} 筆。點一下立即播放,「＋」加入佇列。`;
    const frag = document.createDocumentFragment();
    for (const r of list) {
      frag.appendChild(onlineRow(r, {
        onClick: () => { S.playlistCtx = null; S.history = []; playOnline(r); },
        btn: [
          { icon: 'plus', title: '加入佇列', onClick: () => addToQueue(r) },
          { icon: 'playlist-add', title: '加入播放清單', onClick: () => pickPlaylist([onlineItem(r)]) },
        ],
      }));
    }
    box.appendChild(frag);
    markPlaying();
  } catch (err) {
    $('onlineHint').textContent = '搜尋失敗:' + err.message;
  }
});

// 播放線上歌曲(交給伺服器的 /web/play 處理)
export function playOnline(item, { pushHistory: ph = true } = {}) {
  dbg('playOnline', item.title);
  const same = S.onlineCurrent && entryKey({ kind: 'online', item: S.onlineCurrent }) === entryKey({ kind: 'online', item });
  if (ph && !same) pushHistory(); // 線上歌曲也進歷史,「上一首」才回得去
  S.currentFile = null;
  S.onlineCurrent = item;
  S.endHandled = false;
  const okey = 'on:' + (item.srcUrl || item.url);
  loadSource(okey, '/web/play?url=' + enc(item.srcUrl || item.url));
  if (!offlineKeys.has(okey)) setStatus('線上串流準備中…', true);
  setNow({ title: item.title, sub: onlineSub(item) });
}
