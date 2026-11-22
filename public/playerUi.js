'use strict';
// playerUi.js
// 播放器的通用畫面元件，從 player.js 拆出，邏輯不變：
//   $ / enc / fmt / fmtSize / setIcon   小工具
//   setStatus(text, { type, sticky, action })  底部提示訊息（type:'error' 會放進另一個框、不自動消失）
//   pushLayer / dropLayer               返回鍵（瀏覽器／Android 返回）關閉最上層的畫面
//   askText / askConfirm                文字輸入、確認對話框（取代 prompt / confirm）
// 不依賴 player.js 的任何狀態。載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSize = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const setIcon = (btn, name) => btn.querySelector('use').setAttribute('href', '#i-' + name);

  // 三個產品共用的規則(ui-review DECISIONS 第 3 題):
  //   一般提示 3 秒(字多的稍微久一點);帶動作(action:{ label, fn },例如復原、查看)8 秒;
  //   滑鼠移上去、手指按住或鍵盤聚焦時暫停倒數;
  //   錯誤(type:'error')放在另一個框(#toastErr,role=alert):紅底、有關閉鈕、不自動消失,
  //   不會被後面的一般訊息蓋掉(例如串流失敗後馬上又出現「線上串流準備中…」)
  let countdown = null; // 只有一般提示(#toast)會倒數:{ timer, remaining, startedAt, paused }
  function hideToast(el) {
    if (el.id === 'toast' && countdown) { clearTimeout(countdown.timer); countdown = null; }
    el.classList.remove('show', 'has-action');
  }
  function setStatus(text, { type, sticky = false, action = null } = {}) {
    const isError = type === 'error';
    const el = $(isError ? 'toastErr' : 'toast');
    hideToast(el);
    if (!text) return;
    el.textContent = '';
    if (isError) el.insertAdjacentHTML('beforeend', '<svg class="toast-ic" aria-hidden="true"><use href="#i-alert"/></svg>');
    const msg = document.createElement('span'); msg.className = 'toast-msg'; msg.textContent = text; el.appendChild(msg);
    el.classList.toggle('has-action', !!action);
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-act'; b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', () => { hideToast(el); action.fn(); });
      el.appendChild(b);
    }
    if (isError) {
      const c = document.createElement('button');
      c.className = 'toast-close'; c.type = 'button'; c.setAttribute('aria-label', '關閉這則提示');
      c.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
      c.addEventListener('click', () => hideToast(el));
      el.appendChild(c);
    }
    el.classList.add('show');
    if (sticky || isError) return;
    const remaining = action ? 8000 : Math.min(6000, Math.max(3000, text.length * 110));
    countdown = { remaining, startedAt: Date.now(), paused: false, timer: setTimeout(() => hideToast(el), remaining) };
  }
  // 倒數中的提示:指標在上面或鍵盤焦點在裡面時暫停;兩者都離開後才繼續(至少再留 1.5 秒)
  const toastEl = $('toast');
  const pauseToast = () => {
    if (!countdown || countdown.paused) return;
    clearTimeout(countdown.timer); countdown.remaining -= Date.now() - countdown.startedAt; countdown.paused = true;
  };
  const resumeToast = () => setTimeout(() => {
    if (!countdown || !countdown.paused || toastEl.matches(':hover') || toastEl.contains(document.activeElement)) return;
    countdown.paused = false; countdown.startedAt = Date.now();
    countdown.timer = setTimeout(() => hideToast(toastEl), Math.max(1500, countdown.remaining));
  }, 0);
  toastEl.addEventListener('pointerenter', pauseToast); toastEl.addEventListener('pointerleave', resumeToast);
  toastEl.addEventListener('focusin', pauseToast); toastEl.addEventListener('focusout', resumeToast);

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
  // ok:確認鍵的文字,必填,寫具體動作(建立、重新命名、移動…),不要用「確定」
  function askText(title, initial = '', { ok } = {}) {
    if (!ok) console.warn('askText: 缺少 ok,請寫具體的動作', title);
    return new Promise((resolve) => {
      $('nameTitle').textContent = title;
      $('nameOk').textContent = ok || '儲存';
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
  // ok:確認鍵的文字,必填,寫具體動作(例如「刪除歌曲」),不要用「確定」
  // danger:確認鍵改成紅色,預設聚焦「取消」,避免連按 Enter 就執行;Esc／點遮罩 = 取消
  // delay:確認鍵要等幾毫秒後才能按(兩步確認的第二步,避免連點直接通過)
  function askConfirm(title, msg = '', { ok, danger = false, delay = 0 } = {}) {
    if (!ok) console.warn('askConfirm: 缺少 ok,請寫具體的動作', title);
    return new Promise((resolve) => {
      const dlg = $('confirmDlg'), okBtn = $('confirmOk'), cancel = $('confirmCancel');
      $('confirmTitle').textContent = title;
      $('confirmMsg').textContent = msg; $('confirmMsg').hidden = !msg;
      okBtn.textContent = ok || '繼續'; okBtn.classList.toggle('danger', danger);
      okBtn.disabled = delay > 0;
      const unlock = delay > 0 ? setTimeout(() => { okBtn.disabled = false; }, delay) : 0;
      dlg.classList.add('show');
      pushLayer('confirmDlg', () => done(false));
      // 確認鍵還不能按(delay)時也先聚焦「取消」,不然焦點會留在對話框後面的頁面
      setTimeout(() => (danger || delay > 0 ? cancel : okBtn).focus(), 50);
      const done = (v) => {
        clearTimeout(unlock); okBtn.disabled = false;
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
