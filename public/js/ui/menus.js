// ui/menus.js — 歌曲列「⋮」選單、播放清單內每首歌的選單
import { $ } from '../core/dom.js';
import { S, dlState, offlineKeys } from '../core/state.js';
import { fmtSize } from '../core/util.js';
import { folderOf } from './rows.js';
import { itemKey } from '../playlists/model.js';
import { toggleOffline } from '../offline/downloads.js';
import { removeFromPlaylist } from '../playlists/actions.js';
import { pickPlaylist } from '../playlists/picker.js';

// ── 歌曲列的「⋮」選單(下載離線 / 加入播放清單 / 歌曲資訊)──────
const menuEl = document.createElement('div');

menuEl.className = 'row-menu';

menuEl.hidden = true;

document.body.appendChild(menuEl);

let menuAnchor = null;

function closeRowMenu() { menuEl.hidden = true; menuAnchor = null; }

// 下載中時,⋮ 按鈕顯示百分比;平常顯示三點圖示
export function applyMoreButton(b) {
  const st = dlState.get(b.dataset.dlmenu);
  if (st) {
    b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
    b.style.fontSize = '11px';
  } else {
    b.innerHTML = '<svg><use href="#i-more"/></svg>';
    b.style.fontSize = '';
  }
}

export function openRowMenu(anchor, f) {
  if (menuAnchor === anchor) return closeRowMenu();
  menuAnchor = anchor;
  const key = 'lib:' + f.filename;
  const item = { kind: 'lib', filename: f.filename, title: f.name };
  const isOff = offlineKeys.has(key);
  menuEl.textContent = '';

  const mk = (icon, text, fn, cls) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (cls ? ' ' + cls : '');
    b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    const s = document.createElement('span'); s.textContent = text; b.appendChild(s);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); closeRowMenu(); fn(); });
    menuEl.appendChild(b);
  };
  mk(isOff ? 'close' : 'download',
    isOff ? '移除離線檔案' : (dlState.has(key) ? '下載中…' : '下載離線'),
    () => toggleOffline(item));
  mk('playlist-add', '加入播放清單', () => pickPlaylist([item]));

  const sep = document.createElement('div'); sep.className = 'menu-sep'; menuEl.appendChild(sep);
  const info = document.createElement('div'); info.className = 'menu-info';
  const line = (label, value) => {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = label;
    d.append(b, document.createTextNode(value));
    info.appendChild(d);
  };
  line('資料夾:', folderOf(f) || '(音樂庫根目錄)');
  line('檔案大小:', fmtSize(f.size));
  line('離線狀態:', isOff ? '已下載到此裝置' : (dlState.has(key) ? '下載中' : '未下載'));
  menuEl.appendChild(info);

  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

document.addEventListener('pointerdown', (e) => {
  if (menuEl.hidden) return;
  if (menuEl.contains(e.target) || (menuAnchor && menuAnchor.contains(e.target))) return; // 按鈕自己的 click 負責開關
  closeRowMenu();
}, true);

window.addEventListener('scroll', () => { if (!menuEl.hidden) closeRowMenu(); }, true);

window.addEventListener('resize', closeRowMenu);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });

$('search').addEventListener('input', closeRowMenu);

// ── 播放清單內頁(依設計稿重做):頂部搜尋、⋯ 下拉選單、每首歌的 ⋯ 選單 ──────
function menuItem(icon, text, fn, cls) {
  const b = document.createElement('button');
  b.className = 'menu-item' + (cls ? ' ' + cls : '');
  b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
  const s = document.createElement('span'); s.textContent = text; b.appendChild(s);
  b.addEventListener('click', (ev) => { ev.stopPropagation(); closeRowMenu(); fn(); });
  menuEl.appendChild(b);
}

function menuInfo(lines) {
  const sep = document.createElement('div'); sep.className = 'menu-sep'; menuEl.appendChild(sep);
  const info = document.createElement('div'); info.className = 'menu-info';
  for (const [label, value] of lines) {
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = label;
    d.append(b, document.createTextNode(value));
    info.appendChild(d);
  }
  menuEl.appendChild(info);
}

function placeMenu(anchor) {
  menuEl.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

// 播放清單內每首歌的 ⋯ 選單:下載離線 / 移出播放清單 / 歌曲資訊
export function openItemMenu(anchor, p, it) {
  if (menuAnchor === anchor) return closeRowMenu();
  menuAnchor = anchor;
  const key = itemKey(it), isOff = offlineKeys.has(key);
  menuEl.textContent = '';
  menuItem(isOff ? 'close' : 'download',
    isOff ? '移除離線檔案' : (dlState.has(key) ? '下載中…' : '下載離線'),
    () => toggleOffline(it));
  menuItem('close', '移出播放清單', () => removeFromPlaylist(p.id, it.id), 'danger');
  const lines = [];
  if (it.kind === 'lib') {
    const f = S.byFile.get(it.filename);
    lines.push(['資料夾:', it.filename.includes('/') ? it.filename.split('/')[0] : '(音樂庫根目錄)']);
    if (f) lines.push(['檔案大小:', fmtSize(f.size)]);
  } else {
    lines.push(['來源:', it.platform || '線上']);
    if (it.author) lines.push(['作者:', it.author]);
    if (it.duration && it.duration !== '未知') lines.push(['長度:', it.duration]);
  }
  lines.push(['離線狀態:', isOff ? '已下載到此裝置' : (dlState.has(key) ? '下載中' : '未下載')]);
  menuInfo(lines);
  placeMenu(anchor);
}
