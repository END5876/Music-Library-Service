// library/library.js — 音樂庫清單：載入、篩選、繪製、目前播放標記
import { $ } from '../core/dom.js';
import { LIB_PAGE } from '../core/constants.js';
import { libAvailable } from '../queue/model.js';
import { setStatus } from '../core/toast.js';
import { showLogin } from '../auth/auth.js';
import { folderOf, libRow } from '../ui/rows.js';
import { buildShuffle, syncShuffleQueue } from '../queue/shuffle.js';
import { renderNext } from '../queue/view.js';
import { play } from '../playback/controller.js';
import { loadCapabilities } from '../online/online.js';
import { loadPlaylists } from '../playlists/api.js';
import { S } from '../core/state.js';

// 使用者主動點選一首歌:重置歷史;若隨機開啟,立刻重新排出不重複的隨機佇列
export function start(filename) {
  S.playlistCtx = null;
  S.history = [];
  play(filename);
  if (S.shuffle) buildShuffle();
}

export function nowKey() {
  if (S.currentFile) return 'lib:' + S.currentFile;
  if (S.onlineCurrent) return 'on:' + (S.onlineCurrent.srcUrl || S.onlineCurrent.url);
  return null;
}

// 不再逐列 toggle:只清掉舊的 .playing,再用屬性選擇器找出目前這首
// scroll=true 才捲動(只有換歌時需要,搜尋輸入／重畫清單時不該一直把畫面拉回去)
export function markPlaying(scroll = false) {
  const k = nowKey();
  document.querySelectorAll('.row.playing').forEach((r) => { if (r.dataset.key !== k) r.classList.remove('playing'); });
  if (!k) return;
  let firstMatch = null;
  document.querySelectorAll(`.row[data-key="${CSS.escape(k)}"]`).forEach((r) => {
    r.classList.add('playing');
    if (!firstMatch && r.closest('#list')) firstMatch = r;
  });
  if (scroll && firstMatch && !$('viewLibrary').hidden) firstMatch.scrollIntoView({ block: 'nearest' });
}

// ── 音樂庫清單 ──
export async function loadList() {
  setStatus('載入清單中…', true);
  let r;
  try { r = await fetch('/web/api/list'); } catch { return setStatus('連線失敗'); }
  if (r.status === 401) { setStatus(''); return showLogin(); }
  if (!r.ok) return setStatus('讀取清單失敗');
  S.all = (await r.json()).files || [];
  S.byFile = new Map(S.all.map(f => [f.filename, f]));
  S.queue = S.queue.filter(e => e.kind !== 'lib' || libAvailable(e.filename)); // 已被刪除(且沒有離線檔)的檔案移出佇列
  $('logoutBtn').hidden = false;
  setStatus('');
  renderChips();
  applyFilter();
  loadCapabilities();
  loadPlaylists();
}

function renderChips() {
  const folders = [...new Set(S.all.map(folderOf).filter(Boolean))].sort();
  if (S.folder && !folders.includes(S.folder)) S.folder = '';
  const box = $('chips'); box.textContent = '';
  box.hidden = folders.length === 0;
  for (const f of ['', ...folders]) {
    const b = document.createElement('button');
    b.className = 'chip' + (f === S.folder ? ' active' : '');
    b.textContent = f || '全部';
    b.addEventListener('click', () => { S.folder = f; renderChips(); applyFilter(); });
    box.appendChild(b);
  }
}

export function applyFilter() {
  const q = S.libQuery.trim().toLowerCase();
  S.view = S.all.filter(f =>
    (!S.folder || f.filename.startsWith(S.folder + '/')) &&
    (!q || f.name.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q)));
  S.libLimit = LIB_PAGE;
  if (S.shuffle) syncShuffleQueue(); // 篩選條件變了,隨機佇列要跟著畫面上的清單走(重新開頁時也靠這裡排好)
  render();
}

export function render() {
  $('libCount').textContent = S.all.length ? `${S.view.length} / ${S.all.length} 首` : '\u00a0';
  const ul = $('list'); ul.textContent = '';
  $('empty').hidden = S.view.length > 0 || !S.all.length;
  const frag = document.createDocumentFragment();
  for (const f of S.view.slice(0, S.libLimit)) frag.appendChild(libRow(f));
  if (S.view.length > S.libLimit) {
    const more = document.createElement('li');
    more.className = 'row';
    more.style.justifyContent = 'center';
    more.textContent = `顯示更多(還有 ${S.view.length - S.libLimit} 首)`;
    more.addEventListener('click', () => { S.libLimit += LIB_PAGE; render(); });
    frag.appendChild(more);
  }
  ul.appendChild(frag);
  markPlaying();
  renderNext();
}

// ── 目前播放資訊 ──
export function setNow(n) {
  const t = n ? n.title : '尚未播放';
  const a = n ? n.sub : '從音樂庫或線上搜尋選一首歌';
  ['barTitle', 'miniTitle', 'fTitle'].forEach(id => { $(id).textContent = t; });
  ['barArtist', 'miniArtist', 'fArtist'].forEach(id => { $(id).textContent = a; });
  document.title = n ? `${n.title} · 音樂庫` : '音樂庫播放器';
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = n ? new MediaMetadata({ title: n.title, artist: n.sub.replace(/^📁 /, '') }) : null;
    } catch {}
  }
  markPlaying(true);
  renderNext();
}
