'use strict';
// playerDebug.js
// 除錯模式：/player?debug=1 開啟一次後記在這個瀏覽器（ml_debug_ui），右上角出現 🐞 面板。
// 從 player.js 拆出，邏輯不變。
//   DEBUG_UI                 是否顯示除錯介面（沒開啟時不建立按鈕、不掛監聽、不寫日誌）
//   dbg(...args)             寫一行日誌（除錯模式關閉時什麼都不做）
//   setupDebugPanel(deps)    建立 🐞 面板；deps = { $, setStatus, IS_ANDROID, ANDROID_BY, KEEP }
// 載入順序：playerUi.js 之後、playerPlatform.js 與 player.js 之前。
(() => {
  // 除錯功能預設完全關閉。用 /player?debug=1 開啟一次後會記在這個瀏覽器(ml_debug_ui),之後安裝成 PWA 也看得到;
  // /player?debug=0 關閉並清除日誌。沒開啟時不會建立按鈕、不掛任何除錯監聽、不寫日誌。
  const DEBUG_UI = (() => {
    let param = null;
    try { param = new URLSearchParams(location.search).get('debug'); } catch {}
    try {
      if (param === '1') localStorage.setItem('ml_debug_ui', '1');
      else if (param === '0') ['ml_debug_ui', 'ml_debug', 'ml_log'].forEach((k) => localStorage.removeItem(k));
      return localStorage.getItem('ml_debug_ui') === '1';
    } catch { return param === '1'; }
  })();
  // 靜音保活:Android 預設開啟(只有在除錯面板裡手動關掉才會關)

  // ── 除錯模式 ──
  // 網址加 ?debug=1 後,右上角出現 🐞 面板。開啟後記錄播放流程,
  // 日誌存在記憶體並同步寫入 localStorage.ml_log(最多 500 行,鎖屏／重新整理後仍在),可在面板複製或匯出。
  let DEBUG = false;
  if (DEBUG_UI) { try { DEBUG = localStorage.getItem('ml_debug') === '1'; } catch {} }
  const LOG_MAX = 500;
  let logBuf = [];
  if (DEBUG_UI) { try { const l = JSON.parse(localStorage.getItem('ml_log') || '[]'); if (Array.isArray(l)) logBuf = l.slice(-LOG_MAX); } catch {} }
  let logLive = null;   // 面板開著時的即時刷新函式
  let logSaveTimer = 0;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  const logStr = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.name + ': ' + v.message;
    try { return String(JSON.stringify(v)); } catch { return String(v); }
  };
  function saveLog() {
    clearTimeout(logSaveTimer); logSaveTimer = 0;
    try { localStorage.setItem('ml_log', JSON.stringify(logBuf)); } catch {}
  }
  function dbg(...a) {
    if (!DEBUG) return;
    const line = stamp() + (document.hidden ? ' [背景]' : '') + ' ' + a.map(logStr).join(' ');
    logBuf.push(line);
    if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
    console.log('[player]', line);
    // 背景／鎖屏時頁面隨時可能被凍結:立刻寫入;前景則合併寫入
    if (document.hidden) saveLog(); else if (!logSaveTimer) logSaveTimer = setTimeout(saveLog, 500);
    if (logLive) logLive();
  }

  // ── 除錯面板:🐞 按鈕 → 開關除錯模式、檢視／複製／匯出／清除日誌(只有 ?debug=1 才建立)──
  function setupDebugPanel({ $, setStatus, IS_ANDROID, ANDROID_BY, KEEP }) {
  const _fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const path = u.split('?')[0];
    const t = Date.now();
    return _fetch(input, init).then((r) => {
      if (DEBUG && (!r.ok || path.includes('/web/play'))) dbg('fetch', r.status, path, (Date.now() - t) + 'ms');
      return r;
    }, (err) => {
      if (DEBUG && !(err && err.name === 'AbortError')) dbg('fetch 失敗', err, path, (Date.now() - t) + 'ms');
      throw err;
    });
  };
  window.addEventListener('error', (e) => dbg('JS 錯誤', e.message, (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => dbg('未處理的 Promise 錯誤', e.reason));
  window.addEventListener('online', () => dbg('網路:online'));
  window.addEventListener('offline', () => dbg('網路:offline'));
  window.addEventListener('pagehide', () => { dbg('pagehide'); saveLog(); });
  document.addEventListener('visibilitychange', () => { dbg('visibility', document.visibilityState); if (document.hidden) saveLog(); });
  document.addEventListener('freeze', () => { dbg('頁面被凍結(freeze)'); saveLog(); });
  document.addEventListener('resume', () => dbg('頁面解除凍結(resume)'));

  function logEnv() {
    const c = navigator.connection || {};
    dbg('── 除錯模式開啟 ──');
    dbg('環境', 'standalone=' + (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true),
      'onLine=' + navigator.onLine, 'net=' + (c.effectiveType || '?'),
      'sw=' + (navigator.serviceWorker && navigator.serviceWorker.controller ? '已控制' : '無'),
      'audioSession=' + ('audioSession' in navigator), 'mediaSession=' + ('mediaSession' in navigator),
      'android=' + IS_ANDROID + (ANDROID_BY ? '(' + ANDROID_BY + ')' : ''), 'keep=' + KEEP);
    dbg('UA', navigator.userAgent);
  }
  const fullLog = () =>
    `# 裊器音樂 除錯日誌\n# 匯出時間 ${new Date().toString()}\n# 頁面 ${location.href}\n# UA ${navigator.userAgent}\n# 除錯模式 ${DEBUG ? '開' : '關'}　共 ${logBuf.length} 行\n\n` +
    logBuf.join('\n') + '\n';

  const dbgStyle = document.createElement('style');
  dbgStyle.textContent = '.dbg-btn{width:36px;height:36px;border-radius:50%;background:var(--surface2);flex-shrink:0;margin-left:auto;font-size:16px}' +
    '.dbg-btn.on{box-shadow:inset 0 0 0 2px var(--accent)}.dbg-btn + #logoutBtn{margin-left:0}' +
    '#dbgDlg .box{max-width:560px;max-height:calc(100dvh - 32px);overflow:hidden}' +
    '#dbgText{width:100%;height:45vh;min-height:140px;background:#101010;color:#cfcfcf;border:1px solid #2a2a2a;border-radius:10px;padding:8px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;resize:none;overflow:auto;white-space:pre;-webkit-appearance:none;appearance:none}' +
    '#dbgDlg .row2{display:flex;gap:8px}#dbgDlg .row2 .go{flex:1;padding:10px 4px;font-size:14px}';
  document.head.appendChild(dbgStyle);

  const dbgBtn = document.createElement('button');
  dbgBtn.className = 'dbg-btn'; dbgBtn.id = 'dbgBtn'; dbgBtn.textContent = '🐞';
  dbgBtn.title = '除錯模式'; dbgBtn.setAttribute('aria-label', '除錯模式');
  $('logoutBtn').before(dbgBtn);

  const dlg = document.createElement('div');
  dlg.className = 'login'; dlg.id = 'dbgDlg';
  dlg.innerHTML = '<div class="box"><p class="ttl">除錯模式</p><p id="dbgInfo"></p>' +
    '<button class="go alt" id="dbgToggle" type="button"></button>' +
    '<textarea id="dbgText" readonly spellcheck="false" placeholder="尚無日誌。開啟除錯模式後重現問題,再回來複製或匯出。"></textarea>' +
    '<div class="row2"><button class="go ghost" id="dbgKeep" type="button"></button></div>' +
    '<div class="row2"><button class="go alt" id="dbgCopy" type="button">複製</button><button class="go alt" id="dbgExport" type="button">匯出</button><button class="go ghost" id="dbgClear" type="button">清除</button></div>' +
    '<button class="go ghost" id="dbgClose" type="button">關閉</button></div>';
  document.body.appendChild(dlg);
  const ta = $('dbgText');

  function paintDbg() {
    dbgBtn.classList.toggle('on', DEBUG);
    $('dbgKeep').textContent = '靜音保活:' + (KEEP ? '開' : '關');
    $('dbgToggle').textContent = DEBUG ? '● 除錯模式:開(點此關閉)' : '○ 除錯模式:關(點此開啟)';
    $('dbgInfo').textContent = `共 ${logBuf.length} 行(最多保留 ${LOG_MAX} 行,鎖屏後仍會保留)`;
  }
  let liveTimer = 0;
  function showLog() {
    const stick = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 30;
    ta.value = logBuf.join('\n');
    if (stick) ta.scrollTop = ta.scrollHeight;
    paintDbg();
  }
  logLive = () => { if (dlg.classList.contains('show') && !liveTimer) liveTimer = setTimeout(() => { liveTimer = 0; showLog(); }, 300); };

  dbgBtn.addEventListener('click', () => { dlg.classList.add('show'); showLog(); ta.scrollTop = ta.scrollHeight; });
  $('dbgClose').addEventListener('click', () => dlg.classList.remove('show'));
  const flipFlag = (k, on) => { try { localStorage.setItem(k, on ? '0' : '1'); } catch {} location.reload(); };
  $('dbgKeep').addEventListener('click', () => flipFlag('ml_keep', KEEP));
  $('dbgToggle').addEventListener('click', () => {
    DEBUG = !DEBUG;
    try { localStorage.setItem('ml_debug', DEBUG ? '1' : '0'); } catch {}
    if (DEBUG) logEnv(); else { logBuf.push(stamp() + ' ── 除錯模式關閉 ──'); saveLog(); }
    showLog();
  });
  $('dbgClear').addEventListener('click', () => { logBuf = []; saveLog(); showLog(); setStatus('已清除日誌'); });
  $('dbgCopy').addEventListener('click', async () => {
    if (!logBuf.length) return setStatus('目前沒有日誌');
    const text = fullLog();
    try { await navigator.clipboard.writeText(text); setStatus('已複製日誌(' + logBuf.length + ' 行)'); return; } catch {}
    // 後備:選取文字框後用 execCommand(沒有 Clipboard API／非 HTTPS 時)
    const old = ta.value; ta.value = text; ta.focus(); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.value = old; ta.setSelectionRange(0, 0);
    setStatus(ok ? '已複製日誌(' + logBuf.length + ' 行)' : '複製失敗,請改用「匯出」');
  });
  $('dbgExport').addEventListener('click', async () => {
    if (!logBuf.length) return setStatus('目前沒有日誌');
    const d = new Date();
    const name = `player-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
    const file = new File([fullLog()], name, { type: 'text/plain' });
    // 手機優先用系統分享(可直接傳到 LINE／雲端);不支援或取消就改成下載
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus('已匯出 ' + name);
  });

  paintDbg();
  if (DEBUG) { logEnv(); dbg('頁面載入'); }
  }

  window.MLDebug = { DEBUG_UI, dbg, setupDebugPanel };
})();
