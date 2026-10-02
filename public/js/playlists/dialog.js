// playlists/dialog.js — 文字輸入對話框
import { $ } from '../core/dom.js';

// ── 文字輸入對話框 ────────────────────────────────────
export function askText(title, initial = '') {
  return new Promise((resolve) => {
    $('nameTitle').textContent = title;
    const inp = $('nameInput'), dlg = $('nameDlg'), form = $('nameForm'), cancel = $('nameCancel');
    inp.value = initial;
    dlg.classList.add('show');
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const done = (v) => {
      dlg.classList.remove('show');
      form.removeEventListener('submit', onSubmit); cancel.removeEventListener('click', onCancel);
      resolve(v);
    };
    const onSubmit = (e) => { e.preventDefault(); done(inp.value.trim() || null); };
    const onCancel = () => done(null);
    form.addEventListener('submit', onSubmit); cancel.addEventListener('click', onCancel);
  });
}
