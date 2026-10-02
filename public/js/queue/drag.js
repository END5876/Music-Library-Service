// queue/drag.js — 佇列拖曳排序
import { $ } from '../core/dom.js';
import { mkLib } from './model.js';
import { renderNext } from './view.js';
import { S } from '../core/state.js';

// ── 拖曳排序(Pointer Events,滑鼠與觸控通用)──
export function startDrag(ev, li) {
  if (ev.button > 0) return;
  ev.preventDefault(); ev.stopPropagation();
  const ul = $('nextList');
  const sc = ul.closest('.queue');
  const rows = [...ul.querySelectorAll('.row[data-qid], .row[data-pv]')].filter(r => r !== li);
  const startY = ev.clientY, startScroll = sc.scrollTop;
  let y = startY, pos = 0;
  li.classList.add('dragging');

  const tick = () => {
    const box = sc.getBoundingClientRect();
    if (y < box.top + 50) sc.scrollTop -= 12;
    else if (y > box.bottom - 50) sc.scrollTop += 12;
    li.style.transform = `translateY(${y - startY + sc.scrollTop - startScroll}px)`;
    pos = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length;
    rows.forEach(r => r.classList.remove('drop-before', 'drop-after'));
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
      // 依畫面上的列順序重建佇列;預覽列(data-pv)在這一刻才轉成真正的佇列項目,
      // 所以非隨機模式的「接下來」也能拖曳。沒畫出來的(隨機模式超過 100 列的)項目維持在後面。
      const toEntry = (r) => r.dataset.qid != null
        ? S.queue.find(x => x.id === Number(r.dataset.qid))
        : (S.byFile.has(r.dataset.pv) ? mkLib(r.dataset.pv) : null);
      const moved = toEntry(li);
      if (moved) {
        const shown = rows.map(toEntry).filter(Boolean);
        shown.splice(Math.min(pos, shown.length), 0, moved);
        const used = new Set(shown.map(x => x.id));
        S.queue = shown.concat(S.queue.filter(x => !used.has(x.id)));
      }
    }
    renderNext();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  tick();
}
