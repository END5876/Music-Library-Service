// queue/view.js — 佇列畫面（全螢幕播放頁內）
import { $ } from '../core/dom.js';
import { QUEUE_MAX_ROWS } from '../core/constants.js';
import { libAvailable } from './model.js';
import { setStatus } from '../core/toast.js';
import { libSub, makeRow, onlineSub, previewRow } from '../ui/rows.js';
import { markPlaying } from '../library/library.js';
import { buildShuffle } from './shuffle.js';
import { playFromQueue } from '../playback/controller.js';
import { S } from '../core/state.js';

// ── 佇列畫面(全螢幕播放頁)──
function queueRow(e) {
  const drag = { grip: true, qid: e.id };
  const remove = { icon: 'close', title: '移出佇列', onClick: () => { S.queue = S.queue.filter(x => x.id !== e.id); renderNext(); } };
  if (e.kind === 'lib') {
    const f = S.byFile.get(e.filename) || (e.title ? { filename: e.filename, name: e.title, size: 0 } : null);
    if (!f) return null;
    return makeRow({ ...drag, title: f.name, sub: libSub(f), btn: remove, onClick: () => playFromQueue(e.id) });
  }
  const r = e.item;
  return makeRow({
    ...drag, title: r.title, sub: onlineSub(r),
    dur: r.duration && r.duration !== '未知' ? r.duration : '', btn: remove,
    onClick: () => playFromQueue(e.id),
  });
}

// 佇列只存在於全螢幕播放頁:頁面沒開時只標記「需要重畫」,打開時才真的畫(換歌不再重建整份清單)
const isFullOpen = () => $('full').classList.contains('open');

export function renderNext() {
  S.nextDirty = true;
  if (isFullOpen()) flushNext();
}

export function flushNext() {
  S.nextDirty = false;
  S.queue = S.queue.filter(e => e.kind !== 'lib' || libAvailable(e.filename)); // 數量與畫面列數保持一致
  const ul = $('nextList'); ul.textContent = '';
  const frag = document.createDocumentFragment();
  let count = 0;
  // 隨機模式的佇列可能有上千首,只畫前 100 列;非隨機模式的佇列只含使用者手動排的項目,全部畫出來
  const cap = S.shuffle ? QUEUE_MAX_ROWS : Infinity;
  for (const e of S.queue.slice(0, cap)) { const li = queueRow(e); if (li) { frag.appendChild(li); count++; } }
  if (S.queue.length > cap) {
    const li = document.createElement('li'); li.className = 'note';
    li.textContent = `…還有 ${S.queue.length - QUEUE_MAX_ROWS} 首`;
    frag.appendChild(li);
  }
  // 非隨機模式:佇列用完之後會接著播「最後一首」的下一首,預覽就從那裡開始(與 pickNext 的行為一致)
  let anchor = null;
  if (!S.shuffle) {
    for (let k = S.queue.length - 1; k >= 0; k--) if (S.queue[k].kind === 'lib') { anchor = S.queue[k].filename; break; }
    if (!anchor && !S.onlineCurrent && S.currentFile) anchor = S.currentFile;
  }
  if (anchor) {
    const i = S.view.findIndex(f => f.filename === anchor);
    if (i >= 0) for (const f of S.view.slice(i + 1, i + 31)) { frag.appendChild(previewRow(f)); count++; }
  }
  if (!count) {
    const li = document.createElement('li'); li.className = 'note';
    li.textContent = S.shuffle ? '佇列是空的,點「重新洗牌」重新排一份' : '沒有下一首了';
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  $('queueTitle').textContent = S.queue.length ? `佇列 · ${S.queue.length} 首` : '佇列';
  $('reshuffle').hidden = !S.shuffle;
  markPlaying();
}

$('reshuffle').addEventListener('click', () => { buildShuffle(); setStatus('🔀 已重新洗牌'); });
