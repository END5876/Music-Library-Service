// core/toast.js — 底部提示訊息
import { $ } from './dom.js';

let toastTimer = null;

export function setStatus(text, sticky = false) {
  const el = $('toast');
  clearTimeout(toastTimer);
  if (!text) { el.classList.remove('show'); return; }
  el.textContent = text;
  el.classList.add('show');
  if (!sticky) toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
}
