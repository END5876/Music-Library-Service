// playlists/drag.js — 播放清單內拖曳排序
import { $ } from '../core/dom.js';
import { reorderPlaylist } from './actions.js';
import { renderPlaylists } from './view.js';

// 拖曳排序(播放清單版;邏輯同佇列的 startDrag)
export function startPlDrag(ev, li, pid) {
  if (ev.button > 0) return;
  ev.preventDefault(); ev.stopPropagation();
  const ul = $('plItems'), sc = $('main');
  const rows = [...ul.querySelectorAll('.row[data-iid]')].filter((r) => r !== li);
  const startY = ev.clientY, startScroll = sc.scrollTop;
  let y = startY, pos = 0;
  li.classList.add('dragging');
  const tick = () => {
    const box = sc.getBoundingClientRect();
    if (y < box.top + 50) sc.scrollTop -= 12;
    else if (y > box.bottom - 50) sc.scrollTop += 12;
    li.style.transform = `translateY(${y - startY + sc.scrollTop - startScroll}px)`;
    pos = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length;
    rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (pos < rows.length) rows[pos].classList.add('drop-before');
    else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
  };
  const timer = setInterval(tick, 30);
  const move = (e) => { y = e.clientY; };
  const end = (e) => {
    clearInterval(timer);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (e.type === 'pointerup') {
      const ids = rows.map((r) => r.dataset.iid);
      ids.splice(Math.min(pos, ids.length), 0, li.dataset.iid);
      reorderPlaylist(pid, ids);
    } else renderPlaylists();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  tick();
}
