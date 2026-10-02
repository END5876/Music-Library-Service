// ui/rows.js — 歌曲列元件（makeRow）與音樂庫／線上歌曲的列樣式
import { offlineKeys } from '../core/state.js';
import { fmtSize } from '../core/util.js';
import { start } from '../library/library.js';
import { startDrag } from '../queue/drag.js';
import { applyDlButton } from '../offline/paint.js';
import { applyMoreButton, openRowMenu } from './menus.js';

// ── 列表元件 ──
// opts:key / title / sub / dur / btn / grip / qid / onClick
export function makeRow({ key, title, sub, dur, btn, grip, qid: rowQid, pv, iid, missing, onClick }) {
  const li = document.createElement('li');
  li.className = 'row';
  if (key) li.dataset.key = key;
  if (rowQid != null) li.dataset.qid = rowQid;
  if (pv) li.dataset.pv = pv; // 尚未進入佇列的「接下來」預覽列:拖曳時才轉成佇列項目
  if (iid) li.dataset.iid = iid;
  if (key && offlineKeys.has(key)) li.classList.add('offline');
  if (missing) li.classList.add('missing');
  const cv = document.createElement('div'); cv.className = 'cover';
  const info = document.createElement('div'); info.className = 'info';
  const t = document.createElement('div'); t.className = 't'; t.textContent = title; t.title = title;
  const a = document.createElement('div'); a.className = 'a'; a.textContent = sub;
  info.append(t, a);
  li.append(cv, info);
  if (dur) { const d = document.createElement('span'); d.className = 'dur'; d.textContent = dur; li.appendChild(d); }
  if (grip) {
    const g = document.createElement('button');
    g.className = 'grip'; g.title = '拖曳排序'; g.setAttribute('aria-label', '拖曳排序');
    g.innerHTML = '<svg><use href="#i-grip"/></svg>';
    g.addEventListener('click', (ev) => ev.stopPropagation());
    g.addEventListener('pointerdown', (ev) => (typeof grip === 'function' ? grip : startDrag)(ev, li));
    li.appendChild(g);
  }
  for (const bt of (Array.isArray(btn) ? btn : btn ? [btn] : [])) {
    const b = document.createElement('button');
    b.className = 'rbtn'; b.title = bt.title; b.setAttribute('aria-label', bt.title);
    b.innerHTML = `<svg><use href="#i-${bt.icon}"/></svg>`;
    if (bt.dlkey) { b.dataset.dlkey = bt.dlkey; applyDlButton(b); }
    if (bt.dlmenu) { b.dataset.dlmenu = bt.dlmenu; applyMoreButton(b); }
    b.addEventListener('click', (ev) => { ev.stopPropagation(); bt.onClick(b); });
    li.appendChild(b);
  }
  if (onClick) li.addEventListener('click', onClick);
  return li;
}

export const folderOf = (f) => f.filename.includes('/') ? f.filename.split('/')[0] : '';

export const libSub = (f) => folderOf(f) ? '📁 ' + folderOf(f) : '音樂庫';

export const onlineSub = (r) => [r.platform, r.author].filter(Boolean).join(' · ') || '線上歌曲';

export const libRow = (f) => makeRow({
  key: 'lib:' + f.filename, title: f.name, sub: '',
  btn: { icon: 'more', title: '更多', dlmenu: 'lib:' + f.filename, onClick: (b) => openRowMenu(b, f) },
  onClick: () => start(f.filename),
});

// 非隨機模式下佇列畫面裡「接下來播什麼」的預覽列:可以拖曳
export const previewRow = (f) => makeRow({
  key: 'lib:' + f.filename, title: f.name, sub: libSub(f), dur: fmtSize(f.size),
  grip: true, pv: f.filename, onClick: () => start(f.filename),
});
