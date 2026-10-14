'use strict';
// playerUi.js
// 播放器的通用畫面元件，從 player.js 拆出，邏輯不變：
//   $ / enc / fmt / fmtSize / setIcon   小工具
//   setStatus(text, sticky, action)     底部提示訊息（可附「復原」等按鈕）
//   pushLayer / dropLayer               返回鍵（瀏覽器／Android 返回）關閉最上層的畫面
//   askText / askConfirm                文字輸入、確認對話框（取代 prompt / confirm）
// 不依賴 player.js 的任何狀態。載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const setIcon = (btn, name) => btn.querySelector('use').setAttribute('href', '#i-' + name);

  let toastTimer = null;
  // action:{ label, fn } 在訊息旁放一個按鈕(例如「復原」),按下後執行並關閉訊息
  function setStatus(text, sticky = false, action = null) {
    const el = $('toast');
    clearTimeout(toastTimer);
    if (!text) { el.classList.remove('show', 'has-action'); return; }
    el.textContent = '';
    const msg = document.createElement('span'); msg.textContent = text; el.appendChild(msg);
    el.classList.toggle('has-action', !!action);
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-act'; b.textContent = action.label;
      b.addEventListener('click', () => { el.classList.remove('show', 'has-action'); action.fn(); });
      el.appendChild(b);
    }
    el.classList.add('show');
    if (!sticky) toastTimer = setTimeout(() => el.classList.remove('show', 'has-action'), action ? 8000 : 6000);
  }

  // ── 返回鍵(瀏覽器／Android 返回)──
  // 每打開一層(全螢幕播放頁、播放清單內頁、多選、對話框、選單)就 pushState 一筆;
  // 按返回 → popstate 關掉最上面那層。從畫面上關閉時(按 ✕、取消)呼叫 dropLayer,
  // 稍後用 window.history.go(-n) 把那幾筆消耗掉,讓歷史筆數與開著的層數保持一致。
  // 注意:這個檔案的 history 變數是「播放歷史」,瀏覽器的要寫 window.history。
  // 關掉一層後馬上又打開另一層(選單 → 對話框、對話框 → 對話框)時,新的一層直接沿用剛關掉那筆
  // (replaceState),不在 back() 還沒完成前又 pushState —— 那樣瀏覽器的處理順序不可靠。
  const layers = [];        // [{ name, close }]
  let layerPopping = false; // popstate 正在關閉某一層:這時 dropLayer 不要再動歷史
  let skipPops = 0;         // 自己呼叫 go(-n) 觸發的 popstate 要忽略
  let pendingDrops = 0;     // 已從畫面關閉、還沒從歷史消耗掉的筆數
  function pushLayer(name, close) {
    if (layers.some((l) => l.name === name)) return;
    layers.push({ name, close });
    try {
      if (pendingDrops > 0) { pendingDrops--; window.history.replaceState({ mlLayer: layers.length }, ''); }
      else window.history.pushState({ mlLayer: layers.length }, '');
    } catch {}
  }
  function dropLayer(name) {
    const i = layers.map((l) => l.name).lastIndexOf(name);
    if (i < 0) return;
    layers.splice(i, 1);
    if (layerPopping) return;
    pendingDrops++;
    setTimeout(flushDrops, 0);
  }
  function flushDrops() {
    if (!pendingDrops) return;
    const n = pendingDrops; pendingDrops = 0;
    skipPops++;
    window.history.go(-n);
  }
  window.addEventListener('popstate', () => {
    if (skipPops) { skipPops--; return; }
    const top = layers[layers.length - 1];
    if (!top) return;
    layerPopping = true;
    try { top.close(); } finally { layerPopping = false; }
    if (layers[layers.length - 1] === top) layers.pop(); // 保險:close 沒有自己 dropLayer 時
  });

  // ── 文字輸入對話框 ────────────────────────────────────
  function askText(title, initial = '') {
    return new Promise((resolve) => {
      $('nameTitle').textContent = title;
      const inp = $('nameInput'), dlg = $('nameDlg'), form = $('nameForm'), cancel = $('nameCancel');
      inp.value = initial;
      dlg.classList.add('show');
      pushLayer('nameDlg', () => done(null));
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
      const done = (v) => {
        dlg.classList.remove('show');
        form.removeEventListener('submit', onSubmit); cancel.removeEventListener('click', onCancel);
        dropLayer('nameDlg');
        resolve(v);
      };
      const onSubmit = (e) => { e.preventDefault(); done(inp.value.trim() || null); };
      const onCancel = () => done(null);
      form.addEventListener('submit', onSubmit); cancel.addEventListener('click', onCancel);
    });
  }

  // ── 確認對話框(取代瀏覽器原生 confirm)──────────────
  // danger:確定鍵改成紅色;Esc／點遮罩 = 取消
  function askConfirm(title, msg = '', { ok = '確定', danger = false } = {}) {
    return new Promise((resolve) => {
      const dlg = $('confirmDlg'), okBtn = $('confirmOk'), cancel = $('confirmCancel');
      $('confirmTitle').textContent = title;
      $('confirmMsg').textContent = msg; $('confirmMsg').hidden = !msg;
      okBtn.textContent = ok; okBtn.classList.toggle('danger', danger);
      dlg.classList.add('show');
      pushLayer('confirmDlg', () => done(false));
      setTimeout(() => okBtn.focus(), 50);
      const done = (v) => {
        dlg.classList.remove('show');
        okBtn.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel);
        dlg.removeEventListener('click', onBackdrop); window.removeEventListener('keydown', onKey, true);
        dropLayer('confirmDlg');
        resolve(v);
      };
      const onOk = () => done(true), onCancel = () => done(false);
      const onBackdrop = (e) => { if (e.target === dlg) done(false); };
      // 對話框開著時攔下按鍵,避免空白鍵等全域快捷鍵同時觸發
      const onKey = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(false); } };
      okBtn.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
      dlg.addEventListener('click', onBackdrop); window.addEventListener('keydown', onKey, true);
    });
  }

  window.MLUi = { $, enc, fmt, fmtSize, setIcon, setStatus, pushLayer, dropLayer, askText, askConfirm };
})();
