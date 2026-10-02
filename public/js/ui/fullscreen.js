// ui/fullscreen.js — 全螢幕播放頁開關與分頁
import { $ } from '../core/dom.js';
import { flushNext } from '../queue/view.js';
import { S } from '../core/state.js';

// 全螢幕播放頁
const openFull = () => { $('full').classList.add('open'); if (S.nextDirty) flushNext(); };

export const closeFull = () => $('full').classList.remove('open');

$('nowOpen').addEventListener('click', openFull);

$('expand').addEventListener('click', openFull);

$('miniOpen').addEventListener('click', openFull);

$('close').addEventListener('click', closeFull);

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('full').dataset.tab = t.dataset.tab;
}));
