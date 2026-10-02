// playlists/view.js — 播放清單畫面（總覽卡片、內頁）
import { $ } from '../core/dom.js';
import { S, offlineKeys } from '../core/state.js';
import { libSub, makeRow, onlineSub } from '../ui/rows.js';
import { markPlaying } from '../library/library.js';
import { itemKey, itemTitle, plById } from './model.js';
import { updateOfflineInfo, updatePlDetailButtons } from '../offline/paint.js';
import { playPlaylist } from './context.js';
import { openPlaylist } from './actions.js';
import { startPlDrag } from './drag.js';
import { openItemMenu } from '../ui/menus.js';

// ── 畫面 ──────────────────────────────────────────────
export function renderPlaylists() {
  const detail = S.plOpen && plById(S.plOpen);
  $('plListPane').hidden = !!detail;
  $('plDetailPane').hidden = !detail;
  document.body.classList.toggle('pl-detail', S.mode === 'playlists' && !!detail);
  if (detail) renderPlDetail(detail); else renderPlList();
  updateOfflineInfo();
}

function renderPlList() {
  const q = S.plQuery.trim().toLowerCase();
  const list = S.playlists.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('plCount').textContent = S.playlists.length ? `${S.playlists.length} 個播放清單` : '\u00a0';
  $('plEmpty').hidden = list.length > 0;
  $('plEmpty').textContent = S.playlists.length ? '沒有符合的播放清單' : '還沒有播放清單,點「＋ 新增」建立一個';
  const ul = $('plLists'); ul.textContent = '';
  const frag = document.createDocumentFragment();
  for (const p of list) frag.appendChild(plCard(p));
  ul.appendChild(frag);
}

function plItemRow(p, it, canDrag) {
  const key = itemKey(it), isLib = it.kind === 'lib';
  const f = isLib ? S.byFile.get(it.filename) : null;
  const missing = isLib && S.byFile.size > 0 && !f && !offlineKeys.has(key);
  return makeRow({
    key, iid: it.id, missing,
    title: itemTitle(it),
    sub: isLib ? (f ? libSub(f) : (missing ? '檔案已不存在' : '音樂庫'))
      : [onlineSub(it), it.duration && it.duration !== '未知' ? it.duration : ''].filter(Boolean).join(' · '),
    grip: canDrag ? (ev, li) => startPlDrag(ev, li, p.id) : false,
    btn: { icon: 'more', title: '更多', dlmenu: key, onClick: (b) => openItemMenu(b, p, it) },
    onClick: () => playPlaylist(p.id, it.id),
  });
}

function renderPlDetail(p) {
  $('plTitle').textContent = p.name;
  if (!S.plQuery && $('plSearch').value) $('plSearch').value = '';
  const q = S.plQuery.trim().toLowerCase();
  const ul = $('plItems'); ul.textContent = '';
  $('plItemsEmpty').hidden = p.items.length > 0;
  const frag = document.createDocumentFragment();
  for (const it of p.items) {
    if (q && !itemTitle(it).toLowerCase().includes(q)) continue;
    frag.appendChild(plItemRow(p, it, !q)); // 搜尋篩選時不能拖曳排序
  }
  ul.appendChild(frag);
  updatePlDetailButtons();
  markPlaying();
}

function plCard(p) {
  const nOff = p.items.filter((it) => offlineKeys.has(itemKey(it))).length;
  const li = document.createElement('li');
  li.className = 'pl-card';
  const mkPlay = (cls) => {
    const b = document.createElement('button');
    b.className = cls; b.title = '播放'; b.setAttribute('aria-label', '播放 ' + p.name);
    b.innerHTML = '<svg><use href="#i-play"/></svg>';
    b.addEventListener('click', (ev) => { ev.stopPropagation(); playPlaylist(p.id); });
    return b;
  };
  const art = document.createElement('div'); art.className = 'pl-card-art';
  const cv = document.createElement('div'); cv.className = 'cover';
  art.append(cv, mkPlay('pl-card-play'));
  const info = document.createElement('div'); info.className = 'pl-card-info';
  const t = document.createElement('div'); t.className = 't'; t.textContent = p.name; t.title = p.name;
  const a = document.createElement('div'); a.className = 'a';
  a.textContent = `${p.items.length} 首歌曲` + (nOff ? ` · 已下載 ${nOff} 首` : '');
  info.append(t, a);
  li.append(art, info, mkPlay('pl-card-pm'));
  li.addEventListener('click', () => openPlaylist(p.id));
  return li;
}
