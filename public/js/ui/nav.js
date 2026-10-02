// ui/nav.js — 音樂庫／播放清單／線上搜尋 分頁切換與搜尋框
import { $ } from '../core/dom.js';
import { applyFilter, markPlaying } from '../library/library.js';
import { plById } from '../playlists/model.js';
import { renderPlaylists } from '../playlists/view.js';
import { S } from '../core/state.js';

// ── 頁籤切換 ──
export function setMode(m) {
  if (m === 'online' && !S.onlineAvailable) m = 'library';
  S.mode = m;
  $('viewLibrary').hidden = m !== 'library';
  $('viewOnline').hidden = m !== 'online';
  $('viewPlaylists').hidden = m !== 'playlists';
  document.body.classList.toggle('pl-detail', m === 'playlists' && !!S.plOpen && !!plById(S.plOpen));
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === m));
  const s = $('search');
  if (m === 'online') { s.placeholder = '搜尋 YouTube / Bilibili,或貼上影片網址,按 Enter'; s.value = S.onlineQuery; }
  else if (m === 'playlists') { s.placeholder = '搜尋播放清單…'; s.value = S.plQuery; renderPlaylists(); }
  else { s.placeholder = '搜尋歌名…'; s.value = S.libQuery; markPlaying(); }
  $('main').scrollTop = 0;
}

document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.view)));

$('search').addEventListener('input', () => {
  if (S.mode === 'library') { S.libQuery = $('search').value; applyFilter(); }
  else if (S.mode === 'playlists') { S.plQuery = $('search').value; renderPlaylists(); }
  else S.onlineQuery = $('search').value;
});
