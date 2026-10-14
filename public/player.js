'use strict';
// player.js — 網頁播放器前端的核心（單一 IIFE：佇列、播放、清單、播放清單、離線下載共用同一組閉包狀態）。
// 不碰這些狀態的部分已拆成獨立檔案，透過 window.ML* 取用（見下方「相依腳本」）。
// 區塊索引（依序，搜尋 "// ── " 或 "//  " 標題可跳轉）：
//   狀態與偏好 → 背景播放 helper → 登入 → 列表元件(makeRow) → 音樂庫清單 → 目前播放資訊
//   → 隨機佇列 → 佇列畫面 → 拖曳排序 → 播放(play/advance/prev) → audio 事件 → 補救機制 → 預載
//   → 控制項 → 頁籤 → 線上搜尋/串流 → 播放清單 + 離線下載 → 音樂庫管理(收藏/改名/刪除) → 初始化
// 相依腳本（player.html 中需先載入，sw.js 的 SHELL_URLS 也要列出）：
//   offlineStore.js（IndexedDB）、downloader.js（下載引擎）、playerUi.js（提示訊息、返回鍵層級、對話框）、
//   playerDebug.js（除錯模式與面板）、playerPlatform.js（Android 判斷、靜音保活）、playerGestures.js（手機手勢）、
//   playerBots.js（「Bot 正在播放」頁籤與點歌給 Bot）
(() => {
  const { $, enc, fmt, fmtSize, setIcon, setStatus, pushLayer, dropLayer, askText, askConfirm } = window.MLUi; // playerUi.js
  const { DEBUG_UI, dbg, setupDebugPanel } = window.MLDebug;                                                // playerDebug.js
  const { ANDROID_BY, IS_ANDROID, KEEP, keep, keepOn, keepOff } = window.MLPlatform;                         // playerPlatform.js
  const audio = $('audio');

  const REPEATS = ['all', 'one', 'off'];
  const REPEAT_LABEL = { all: '循環:全部', one: '循環:單曲', off: '不循環' };

  // 拖曳排序的提示線(CSS 檔不用再改)
  const st = document.createElement('style');
  st.textContent = '.row.drop-before{box-shadow:0 -2px 0 var(--accent)}.row.drop-after{box-shadow:0 2px 0 var(--accent)}.row.dragging{pointer-events:none}';
  document.head.appendChild(st);

  // ── 狀態 ──
  let all = [];            // 全部曲目
  let view = [];           // 目前篩選後的清單
  let currentFile = null;  // 目前播放的音樂庫 filename
  let onlineCurrent = null;
  let onlineAvailable = false;
  let byFile = new Map();  // filename -> 曲目(O(1) 查詢,取代 all.find)
  let nextDirty = true;    // 佇列畫面是否需要重畫(全螢幕頁沒開時不畫)
  const LIB_PAGE = 100;    // 音樂庫清單一次畫幾列;捲到接近底部時自動再畫下一批
  const QUEUE_MAX_ROWS = 100; // 佇列畫面一次最多畫幾列
  let libLimit = LIB_PAGE;
  let shuffle = false;
  let repeat = 'all';
  let history = [];
  let errorStreak = 0;
  let waitingNet = '';        // 網路中斷時,正在等待恢復的曲目 key
  let netProbeAt = 0;         // 上次探測網路的時間
  let waitingSince = 0;       // 開始「緩衝中」的時間(串流中途卡住的偵測用)
  let netChecking = false;
  let resumeAt = null;        // 網路恢復後要接著播的位置 { key, t }
  let errorRetry = 0, errorRetryKey = '';
  const ERROR_RETRIES = 2;    // 網路正常但這首載入失敗:先重試同一首這麼多次,才算一次失敗
  let pendingPlay = false; // 程式已要求播放、但還沒真的開始(載入中)
  let switchPending = false; // 已載入新音源、尚未真正開始播(tryPlay 放棄後仍保留,供 recover 補救)
  let userPaused = false;    // 使用者(含鎖屏／耳機按鍵)明確按了暫停
  let autoSwitchAt = 0;      // 最近一次「播完自動換歌」的時間
  let lastPlayingAt = 0;     // 最近一次 playing 事件的時間
  const RESUME_DELAYS = [0, 600]; // 實測每次補打都只多播約 0.1 秒又被系統暫停,多試無益(還會聽到「滋」一聲),只留 2 次
  let resumeTimer = 0;
  let autoResumes = 0;       // 自動換歌後被非使用者暫停,已自動恢復的次數
  const inAutoWindow = () => autoSwitchAt > 0 && Date.now() - autoSwitchAt < 8000;
  let lastSrc = null;        // { key, url } 最近一次 loadSource,必要時重新載入
  let endHandled = false;  // 這次 ended 是否已處理過
  let mode = 'library';
  let folder = '';
  let libQuery = '', onlineQuery = '', offQuery = '';
  // 佇列:統一存放「接下來要播的」項目,可拖曳排序
  // 項目:{ id, kind:'lib', filename } 或 { id, kind:'online', item }
  let queue = [];
  let qid = 0;
  const mkLib = (filename, title) => ({ id: ++qid, kind: 'lib', filename, title });
  const mkOnline = (item) => ({ id: ++qid, kind: 'online', item });
  // 播放清單(存在伺服器,跨裝置共用)
  let playlists = [];
  let plOpen = null;        // 目前打開的播放清單 id
  let plQuery = '';
  let playlistCtx = null;   // 目前正在播放的播放清單:{ id, items }
  // 離線下載(IndexedDB)
  const offlineKeys = new Set();  // 已下載的 key('lib:<filename>' / 'on:<url>')
  const dlState = new Map();      // key -> { pct, active }(排隊中／下載中)
  const libAvailable = (fn) => byFile.has(fn) || offlineKeys.has('lib:' + fn);

  try {
    const s = JSON.parse(localStorage.getItem('ml_prefs') || '{}');
    if (typeof s.volume === 'number') audio.volume = Math.min(1, Math.max(0, s.volume));
    shuffle = !!s.shuffle;
    if (REPEATS.includes(s.repeat)) repeat = s.repeat;
  } catch {}
  function savePrefs() {
    try { localStorage.setItem('ml_prefs', JSON.stringify({ volume: audio.volume, shuffle, repeat })); } catch {}
  }

  const streamUrl = (f) => '/web/stream/' + f.split('/').map(enc).join('/');
  const libDur = (f) => (f && f.duration ? fmt(f.duration) : ''); // 音樂庫曲目的歌曲長度(伺服器還沒讀到時為空)
  // 線上即時串流要不要請伺服器直接送 WebM/Opus(YouTube 只換封裝、不重新編碼,見 streamPlayer.js)。
  // Apple 的 WebKit(Safari、iOS 上所有瀏覽器)對 <audio> 直接播 WebM 串流不可靠,一律維持 mp3。
  // 離線下載(downloader.js)不帶這個參數:WebM 串流沒有索引,存成檔案後不好拖曳進度。
  const WEBM_OK = (() => {
    const ua = navigator.userAgent || '';
    const appleWebKit = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      || (/Safari\//.test(ua) &&!/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/.test(ua));
    try { return !appleWebKit && audio.canPlayType('audio/webm; codecs="opus"') !== ''; } catch { return false; }
  })();

  // ── 背景播放穩定性 helper ──
  function setSession(state) {
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = state; } catch {} }
  }
  // 支援 Audio Session API 的瀏覽器（含新版 Safari）可據此把本頁視為音樂播放。
  // 不支援時完全不影響既有播放流程；它不能繞過瀏覽器或系統的背景執行限制。
  function configureAudioSession() {
    if (!('audioSession' in navigator)) return;
    try {
      if (navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
      dbg('audioSession', navigator.audioSession.type);
    } catch (err) {
      dbg('audioSession 設定失敗', err && err.name);
    }
  }
  // 載入空檔也維持「播放中」;失敗最多重試 retries 次,之後放棄(避免 recover 無限重試)
  function tryPlay(retries = 3) {
    configureAudioSession();
    keepOn();
    pendingPlay = true;
    setSession('playing');
    const p = audio.play();
    if (p && p.then) p.then(() => dbg('play() 成功'));
    if (p && p.catch) p.catch((err) => {
      dbg('play() 被拒絕', err && err.name, '剩餘重試', retries);
      if (err && err.name === 'AbortError') return; // 被新的 load 取代,正常
      if (retries > 0 && pendingPlay) { setTimeout(() => tryPlay(retries - 1), 600); return; }
      pendingPlay = false;
      setSession('paused');
      setStatus('無法自動播放,請按播放鍵');
    });
  }
  // 背景分頁的 timer 會被節流甚至凍結:hidden 時直接同步執行
  // (error / ended 都是非同步觸發的事件,同步呼叫不會造成遞迴)
  const later = (fn) => { if (document.hidden) fn(); else setTimeout(fn, 800); };

  // ── 登入 ──
  function showLogin(msg) {
    $('login').classList.add('show');
    $('loginErr').textContent = msg || '';
    $('pw').focus();
  }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      const r = await fetch('/web/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('pw').value }),
      });
      if (r.ok) {
        $('pw').value = ''; $('login').classList.remove('show'); loadList();
        if ((currentFile || onlineCurrent) && audio.error) { audio.load(); tryPlay(); } // 播到一半登入過期:登入後接著重播
        return;
      }
      const j = await r.json().catch(() => ({}));
      $('loginErr').textContent = j.error || '登入失敗';
    } catch { $('loginErr').textContent = '連線失敗'; }
  });
  $('logoutBtn').addEventListener('click', async () => {
    pendingPlay = false; switchPending = false; userPaused = true;
    audio.pause(); keepOff();
    setSession('none');
    await fetch('/web/logout', { method: 'POST' }).catch(() => {});
    all = []; view = []; queue = []; history = []; byFile = new Map();
    playlists = []; plOpen = null; playlistCtx = null; clearDataCaches(); bots.hide();
    currentFile = null; onlineCurrent = null;
    dropPreload(); keepOff();
    $('onlineResults').textContent = '';
    audio.removeAttribute('src'); audio.load();
    setNow(null); render();
    $('logoutBtn').hidden = true;
    showLogin();
  });

  // ── 列表元件 ──
  // opts:key / title / sub / dur / idx / btn / grip / qid / onClick
  function makeRow({ key, title, sub, dur, idx, btn, grip, qid: rowQid, pv, iid, missing, onClick }) {
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
    if (idx != null) { const n = document.createElement('span'); n.className = 'idx'; n.textContent = idx; li.appendChild(n); }
    li.append(cv, info);
    // 有 key 的列一律放時間欄:已下載標記掛在它前面,之後補上的長度也直接填進來
    if (dur || key) { const d = document.createElement('span'); d.className = 'dur'; d.textContent = dur || ''; li.appendChild(d); }
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

  // ── Bot 正在播放(頁籤畫面與遠端控制在 playerBots.js)──
  const bots = window.MLBots.createBots({
    $, setStatus, askConfirm, pushLayer, dropLayer, fmt, makeRow, showLogin,
    libInfo: (fn) => { const f = byFile.get(fn); return f ? { name: f.name, duration: f.duration || 0 } : null; },
  });

  const folderOf = (f) => f.filename.includes('/') ? f.filename.split('/')[0] : '';
  const libSub = (f) => folderOf(f) || '音樂庫';
  const onlineSub = (r) => [r.platform, r.author].filter(Boolean).join(' · ') || '線上歌曲';

  // 使用者主動點選一首歌:重置歷史;若隨機開啟,立刻重新排出不重複的隨機佇列
  function start(filename) {
    playlistCtx = null;
    history = [];
    play(filename);
    if (shuffle) buildShuffle();
  }
  const libRow = (f, i) => {
    const li = makeRow({
      key: 'lib:' + f.filename, title: f.name, sub: folderOf(f), dur: libDur(f), idx: i + 1,
      btn: { icon: 'more', title: '更多', dlmenu: 'lib:' + f.filename, onClick: (b) => openRowMenu(b, f) },
      onClick: (ev) => libSel.on ? libSel.toggle(f.filename, ev.shiftKey) : start(f.filename),
    });
    if (libSel.on && libSel.set.has(f.filename)) li.classList.add('selected');
    return li;
  };

  // ── 多選(音樂庫批次加入、播放清單批次移除共用)──
  // ids():目前畫面篩選後、依顯示順序的全部 id;rowId(row):從列取得 id(取不到回 null)
  // set 依點選順序保存;Shift+點擊可選取上一次點的那首到這首之間的範圍
  function makeSelector({ name, exit, list, bar, ids, rowId }) {
    const s = { on: false, set: new Set(), anchor: null };
    s.paint = () => list.querySelectorAll('.row').forEach((r) => {
      const id = rowId(r);
      if (id != null) r.classList.toggle('selected', s.set.has(id));
    });
    s.update = () => {
      const all = ids();
      bar.querySelector('.sel-count').textContent = `已選 ${s.set.size} 首`;
      bar.querySelectorAll('.sel-act').forEach((b) => { b.disabled = !s.set.size; });
      bar.querySelector('.sel-all').textContent = all.length && all.every((id) => s.set.has(id)) ? '取消全選' : '全選';
    };
    s.setMode = (on) => {
      const was = s.on;
      s.on = on; s.set.clear(); s.anchor = null;
      if (on && !was) pushLayer(name, exit); else if (!on && was) dropLayer(name);
      list.classList.toggle('selecting', on);
      bar.hidden = !on;
      s.update();
    };
    s.toggle = (id, range) => {
      const all = range && s.anchor != null ? ids() : [];
      const ai = all.indexOf(s.anchor), bi = all.indexOf(id);
      if (ai >= 0 && bi >= 0) {
        const on = !s.set.has(id);
        for (const x of all.slice(Math.min(ai, bi), Math.max(ai, bi) + 1)) on ? s.set.add(x) : s.set.delete(x);
      } else if (s.set.has(id)) s.set.delete(id); else s.set.add(id);
      s.anchor = id;
      s.paint(); s.update();
    };
    bar.querySelector('.sel-all').addEventListener('click', () => {
      const all = ids();
      const allOn = all.length && all.every((id) => s.set.has(id));
      for (const id of all) allOn ? s.set.delete(id) : s.set.add(id);
      s.paint(); s.update();
    });
    return s;
  }

  const libSel = makeSelector({
    name: 'libSel', exit: () => setLibSelecting(false),
    list: $('list'), bar: $('selBar'),
    ids: () => view.map((f) => f.filename),
    rowId: (r) => r.dataset.key ? r.dataset.key.slice(4) : null,
  });
  function setLibSelecting(on) {
    libSel.setMode(on);
    $('selectBtn').hidden = on;
    $('selBot').hidden = !bots.hasTargets(); // 有 Bot 在語音頻道才顯示「點給 Bot」
    render();
  }
  $('selectBtn').addEventListener('click', () => setLibSelecting(true));
  $('selCancel').addEventListener('click', () => setLibSelecting(false));
  $('selAdd').addEventListener('click', () => {
    const items = [...libSel.set].filter((fn) => byFile.has(fn))
      .map((fn) => ({ kind: 'lib', filename: fn, title: byFile.get(fn).name }));
    if (!items.length) return setStatus('選取的歌曲已不在音樂庫中');
    pickPlaylist(items, () => setLibSelecting(false));
  });
  // 多選後一次點給 Bot（依音樂庫目前的排序送出）
  $('selBot').addEventListener('click', () => {
    const items = view.filter((f) => libSel.set.has(f.filename))
      .map((f) => ({ kind: 'lib', filename: f.filename, title: f.name }));
    if (!items.length) return setStatus('選取的歌曲已不在音樂庫中');
    bots.sendToBot(items, () => setLibSelecting(false));
  });
  // 非隨機模式下佇列畫面裡「接下來播什麼」的預覽列:可以拖曳
  const previewRow = (f) => makeRow({
    key: 'lib:' + f.filename, title: f.name, sub: libSub(f), dur: libDur(f),
    grip: true, pv: f.filename, onClick: () => start(f.filename),
  });

  function nowKey() {
    if (currentFile) return 'lib:' + currentFile;
    if (onlineCurrent) return 'on:' + (onlineCurrent.srcUrl || onlineCurrent.url);
    return null;
  }
  // 不再逐列 toggle:只清掉舊的 .playing,再用屬性選擇器找出目前這首
  // scroll=true 才捲動(只有換歌時需要,搜尋輸入／重畫清單時不該一直把畫面拉回去)
  function markPlaying(scroll = false) {
    const k = nowKey();
    document.querySelectorAll('.row.playing').forEach((r) => { if (r.dataset.key !== k) r.classList.remove('playing'); });
    if (!k) return;
    let firstMatch = null;
    document.querySelectorAll(`.row[data-key="${CSS.escape(k)}"]`).forEach((r) => {
      r.classList.add('playing');
      if (!firstMatch && r.closest('#list')) firstMatch = r;
    });
    if (scroll && firstMatch && !$('viewLibrary').hidden) firstMatch.scrollIntoView({ block: 'nearest' });
  }

  // ── 音樂庫清單 ──
  // listReq:可傳入已經發出的請求(初始化時與 IndexedDB 掃描同時進行,省一段等待)
  async function loadList(listReq) {
    setStatus('載入清單中…', true);
    let r;
    try { r = await (listReq || fetch('/web/api/list')); } catch (err) {
      dbg('loadList 連線失敗', err);
      serverDown = true; updateNetState();
      if (offlineKeys.size && mode === 'library') { setMode('offline'); return setStatus('目前無法連線,已切換到離線歌曲'); }
      return setStatus('連線失敗');
    }
    if (r.status === 401) { setStatus(''); return showLogin(); }
    if (!r.ok) return setStatus('讀取清單失敗');
    const j = await r.json();
    if (serverDown) { serverDown = false; updateNetState(); }
    all = j.files || [];
    for (const f of all) f.q = zhFold(f.name + '\n' + f.filename); // 搜尋用,先算好小寫+繁轉簡,打字時不必每個字都重算
    byFile = new Map(all.map(f => [f.filename, f]));
    queue = queue.filter(e => e.kind !== 'lib' || libAvailable(e.filename)); // 已被刪除(且沒有離線檔)的檔案移出佇列
    $('logoutBtn').hidden = false;
    setStatus('');
    renderChips();
    applyFilter();
    loadCapabilities();
    loadPlaylists();
    bots.refresh();
    scheduleDurations(j.durationsPending);
  }

  // ── 歌曲長度:伺服器第一次用 ffprobe 讀整個音樂庫需要一點時間,讀到的陸續補進畫面(只改文字,不重畫列表)──
  let durTimer = 0, durTries = 0;
  function scheduleDurations(pending) {
    clearTimeout(durTimer);
    if (!pending) { durTries = 0; return; }
    if (++durTries > 40) return; // 最多約 10 分鐘,之後等下次開頁
    durTimer = setTimeout(refreshDurations, 15000);
  }
  async function refreshDurations() {
    let j;
    try { const r = await fetch('/web/api/list'); if (!r.ok) return; j = await r.json(); } catch { return; }
    let changed = false;
    for (const nf of j.files || []) {
      const f = byFile.get(nf.filename);
      if (f && nf.duration && f.duration !== nf.duration) { f.duration = nf.duration; changed = true; }
    }
    if (changed) paintDurations();
    scheduleDurations(j.durationsPending);
  }
  function paintDurations() {
    document.querySelectorAll('.row[data-key^="lib:"]').forEach((row) => {
      const text = libDur(byFile.get(row.dataset.key.slice(4)));
      if (!text) return;
      let d = row.querySelector('.dur');
      if (!d) { d = document.createElement('span'); d.className = 'dur'; row.querySelector('.info').after(d); }
      d.textContent = text;
    });
  }

  function renderChips() {
    const folders = [...new Set(all.map(folderOf).filter(Boolean))].sort();
    if (folder && !folders.includes(folder)) folder = '';
    const box = $('chips'); box.textContent = '';
    box.hidden = folders.length === 0;
    for (const f of ['', ...folders]) {
      const b = document.createElement('button');
      b.className = 'chip' + (f === folder ? ' active' : '');
      b.textContent = f || '全部';
      b.addEventListener('click', () => { folder = f; renderChips(); applyFilter(); });
      box.appendChild(b);
    }
  }

  function applyFilter() {
    const q = zhFold(libQuery.trim());
    view = all.filter(f =>
      (!folder || f.filename.startsWith(folder + '/')) &&
      (!q || f.q.includes(q)));
    libLimit = LIB_PAGE;
    if (shuffle) syncShuffleQueue(); // 篩選條件變了,隨機佇列要跟著畫面上的清單走(重新開頁時也靠這裡排好)
    render();
  }

  // 清單底部放一個看不見的哨兵列,快捲到(提前 800px)時接著畫下一批,只追加、不重畫已經有的列
  const libMoreObs = 'IntersectionObserver' in window
    ? new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) renderMoreLib(); }, { root: $('main'), rootMargin: '0px 0px 800px 0px' })
    : null;
  function renderMoreLib() {
    const ul = $('list'), sentinel = ul.querySelector('.lib-sentinel');
    if (!sentinel) return;
    const start = libLimit;
    libLimit += LIB_PAGE;
    const frag = document.createDocumentFragment();
    view.slice(start, libLimit).forEach((f, i) => frag.appendChild(libRow(f, start + i)));
    sentinel.before(frag);
    libMoreObs.unobserve(sentinel);
    if (view.length <= libLimit) sentinel.remove();
    else libMoreObs.observe(sentinel); // 重新觀察:畫完如果哨兵還在可視範圍內,會立刻再觸發一次
    markPlaying();
  }
  function render() {
    const nf = (n) => n.toLocaleString();
    $('libCount').textContent = !all.length ? '' : view.length === all.length ? `${nf(all.length)} 首` : `${nf(view.length)} / ${nf(all.length)} 首`;
    const ul = $('list'); ul.textContent = '';
    $('empty').hidden = view.length > 0 || !all.length;
    const frag = document.createDocumentFragment();
    view.slice(0, libLimit).forEach((f, i) => frag.appendChild(libRow(f, i)));
    if (libMoreObs) libMoreObs.disconnect();
    if (view.length > libLimit) {
      if (libMoreObs) {
        const s = document.createElement('li');
        s.className = 'lib-sentinel'; s.setAttribute('aria-hidden', 'true');
        frag.appendChild(s);
      } else view.slice(libLimit).forEach((f, i) => frag.appendChild(libRow(f, libLimit + i))); // 不支援 IntersectionObserver:全部畫出
    }
    ul.appendChild(frag);
    const sentinel = ul.querySelector('.lib-sentinel');
    if (sentinel) libMoreObs.observe(sentinel);
    markPlaying();
    renderNext();
    if (libSel.on) libSel.update();
  }

  // ── 目前播放資訊 ──
  function setNow(n) {
    const t = n ? n.title : '尚未播放';
    const a = n ? n.sub : '從音樂庫或線上搜尋選一首歌';
    ['barTitle', 'miniTitle', 'fTitle'].forEach(id => { $(id).textContent = t; });
    ['barArtist', 'miniArtist', 'fArtist'].forEach(id => { $(id).textContent = a; });
    document.title = n ? `${n.title} · 裊器音樂` : '裊器音樂';
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = n ? new MediaMetadata({ title: n.title, artist: n.sub }) : null;
      } catch {}
    }
    markPlaying(true);
    renderNext();
  }

  // ── 隨機佇列 ──
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  // 立刻把目前清單排成一份不重複的隨機順序;手動加入的線上歌曲保留在最前面
  // includeCurrent:新一輪開始時要把剛播完的那首也排進去(否則每一輪都會少一首)
  function buildShuffle({ includeCurrent = false, render = true } = {}) {
    const online = queue.filter(e => e.user || e.kind === 'online'); // 手動排的歌保留在最前面
    let files = view.map(f => f.filename);
    if (!includeCurrent) files = files.filter(f => f !== currentFile);
    const order = shuffled(files);
    // 新一輪的第一首不要正好是剛播完的那首(清單只有一首時除外)
    if (includeCurrent && order.length > 1 && order[0] === currentFile) {
      const j = 1 + Math.floor(Math.random() * (order.length - 1));
      [order[0], order[j]] = [order[j], order[0]];
    }
    queue = online.concat(order.map(mkLib));
    if (render) renderNext();
  }
  // 篩選變動時:只有「清單內容」真的變了才重排,避免打字搜尋時每個字都洗牌、也保留使用者拖曳過的順序
  function syncShuffleQueue() {
    if (playlistCtx) return; // 播放清單有自己的隨機佇列
    const want = new Set(view.map(f => f.filename));
    want.delete(currentFile);
    const have = queue.filter(e => e.kind === 'lib' && !e.user);
    const same = have.length === want.size && have.every(e => want.has(e.filename));
    if (!same) buildShuffle({ render: false });
  }

  // ── 佇列畫面(全螢幕播放頁)──
  function queueRow(e) {
    const drag = { grip: true, qid: e.id };
    const remove = { icon: 'close', title: '移出佇列', onClick: () => { queue = queue.filter(x => x.id !== e.id); renderNext(); } };
    if (e.kind === 'lib') {
      const f = byFile.get(e.filename) || (e.title ? { filename: e.filename, name: e.title, size: 0 } : null);
      if (!f) return null;
      return makeRow({ ...drag, key: 'lib:' + f.filename, title: f.name, sub: libSub(f), dur: libDur(f), btn: remove, onClick: () => playFromQueue(e.id) });
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
  function renderNext() {
    nextDirty = true;
    if (isFullOpen()) flushNext();
  }
  function flushNext() {
    nextDirty = false;
    queue = queue.filter(e => e.kind !== 'lib' || libAvailable(e.filename)); // 數量與畫面列數保持一致
    const ul = $('nextList'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    let count = 0;
    // 隨機模式的佇列可能有上千首,只畫前 100 列;非隨機模式的佇列只含使用者手動排的項目,全部畫出來
    const cap = shuffle ? QUEUE_MAX_ROWS : Infinity;
    for (const e of queue.slice(0, cap)) { const li = queueRow(e); if (li) { frag.appendChild(li); count++; } }
    if (queue.length > cap) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = `…還有 ${queue.length - QUEUE_MAX_ROWS} 首`;
      frag.appendChild(li);
    }
    // 非隨機模式:佇列用完之後會接著播「最後一首」的下一首,預覽就從那裡開始(與 pickNext 的行為一致)
    let anchor = null;
    // 播放清單／離線歌曲播放中:佇列播完後不會接到音樂庫,所以不顯示音樂庫的預覽
    if (!shuffle && !playlistCtx) {
      for (let k = queue.length - 1; k >= 0; k--) if (queue[k].kind === 'lib') { anchor = queue[k].filename; break; }
      if (!anchor && !onlineCurrent && currentFile) anchor = currentFile;
    }
    if (anchor) {
      const i = view.findIndex(f => f.filename === anchor);
      if (i >= 0) for (const f of view.slice(i + 1, i + 31)) { frag.appendChild(previewRow(f)); count++; }
    }
    if (!count) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = playlistCtx ? (repeat === 'off' ? '播完這首就結束了' : '播完後從第一首重新開始')
        : shuffle ? '佇列是空的,點「重新洗牌」重新排一份' : '沒有下一首了';
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    $('queueTitle').textContent = queue.length ? `佇列 · ${queue.length} 首` : '佇列';
    $('reshuffle').hidden = !shuffle;
    markPlaying();
  }
  $('reshuffle').addEventListener('click', () => { buildShuffle(); setStatus('已重新洗牌'); });

  // ── 拖曳排序(Pointer Events,滑鼠與觸控通用;佇列與播放清單共用)──
  // rows:拖曳中的列以外、可以放置的列;sc:捲動容器;onEnd(dropped, pos):放開或取消時呼叫
  // 每一幀(requestAnimationFrame,跟螢幕更新同步)只改 transform:被拖的列跟著手指,
  // 其他列滑開讓出空位,看得出會插在哪裡。拖曳中不讀 layout、不切換 class,避免整份列表重算樣式。
  function dragSort(ev, li, rows, sc, onEnd) {
    if (ev.button > 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const startY = ev.clientY, startScroll = sc.scrollTop;
    const box = sc.getBoundingClientRect(); // 捲動容器拖曳中不會移動,量一次就好
    // 各列中點換算成捲動內容座標,只量一次
    const mids = rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 + startScroll; });
    const lb = li.getBoundingClientRect();
    const liMid = lb.top + lb.height / 2 + startScroll;
    const from = mids.filter((m) => m < liMid).length; // 被拖的列原本的位置
    // 讓位的距離 = 列高 + 列與列之間的間距
    const next = li.nextElementSibling, prevEl = li.previousElementSibling;
    const step = next ? next.getBoundingClientRect().top - lb.top
      : prevEl ? lb.top - prevEl.getBoundingClientRect().top : lb.height;
    const shift = rows.map(() => 0);
    const list = li.parentElement;
    let y = startY, pos = from, raf = 0;
    li.classList.add('dragging');
    list.classList.add('drag-active');

    const frame = () => {
      raf = requestAnimationFrame(frame);
      // 靠近上下邊緣自動捲動,越靠近越快
      const edge = 60;
      if (y < box.top + edge) sc.scrollTop -= Math.ceil((box.top + edge - y) / 4);
      else if (y > box.bottom - edge) sc.scrollTop += Math.ceil((y - box.bottom + edge) / 4);
      const st = sc.scrollTop;
      li.style.transform = `translate3d(0,${y - startY + st - startScroll}px,0)`;
      const at = y + st;
      let p = 0;
      while (p < mids.length && mids[p] < at) p++;
      if (p === pos) return;
      pos = p;
      // 往上拖:[pos, from) 往下讓位;往下拖:[from, pos) 往上讓位
      for (let i = 0; i < rows.length; i++) {
        const t = i >= pos && i < from ? step : i >= from && i < pos ? -step : 0;
        if (t !== shift[i]) { shift[i] = t; rows[i].style.transform = t ? `translate3d(0,${t}px,0)` : ''; }
      }
    };
    const move = (e) => { y = e.clientY; };
    const end = (e) => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      list.classList.remove('drag-active');
      li.style.transform = '';
      rows.forEach((r) => { r.style.transform = ''; });
      onEnd(e.type === 'pointerup', pos);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    frame();
  }

  function startDrag(ev, li) {
    const ul = $('nextList');
    const rows = [...ul.querySelectorAll('.row[data-qid], .row[data-pv]')].filter(r => r !== li);
    dragSort(ev, li, rows, ul.closest('.queue'), (dropped, pos) => {
      if (dropped) {
        // 依畫面上的列順序重建佇列;預覽列(data-pv)在這一刻才轉成真正的佇列項目,
        // 所以非隨機模式的「接下來」也能拖曳。沒畫出來的(隨機模式超過 100 列的)項目維持在後面。
        const toEntry = (r) => r.dataset.qid != null
          ? queue.find(x => x.id === Number(r.dataset.qid))
          : (byFile.has(r.dataset.pv) ? mkLib(r.dataset.pv) : null);
        const moved = toEntry(li);
        if (moved) {
          const shown = rows.map(toEntry).filter(Boolean);
          shown.splice(Math.min(pos, shown.length), 0, moved);
          const used = new Set(shown.map(x => x.id));
          queue = shown.concat(queue.filter(x => !used.has(x.id)));
        }
      }
      renderNext();
    });
  }

  // ── 播放 ──
  // 歷史與佇列使用同一種項目格式({kind:'lib',filename} / {kind:'online',item}),「上一首」才能回到線上歌曲
  const entryKey = (e) => e.kind === 'lib' ? 'lib:' + e.filename : 'on:' + (e.item.srcUrl || e.item.url);
  function currentEntry() {
    if (currentFile) return { kind: 'lib', filename: currentFile };
    if (onlineCurrent) return { kind: 'online', item: onlineCurrent };
    return null;
  }
  function pushHistory() {
    const c = currentEntry(); if (!c) return;
    history.push(c);
    if (history.length > 200) history.shift();
  }

  function play(filename, { pushHistory: ph = true, title } = {}) {
    const track = byFile.get(filename)
      || (offlineKeys.has('lib:' + filename) ? { filename, name: title || filename.split('/').pop(), size: 0 } : null);
    if (!track) return false;
    if (ph && currentFile !== filename) pushHistory();
    dbg('play', filename);
    onlineCurrent = null;
    currentFile = filename;
    endHandled = false;
    loadSource('lib:' + filename, streamUrl(filename));
    setStatus('');
    setNow({ title: track.name, sub: libSub(track) });
    return true;
  }

  function playEntry(e, opts) {
    if (e.kind === 'online') return playOnline(e.item, opts);
    if (!play(e.filename, { ...opts, title: e.title })) advance(); // 檔案已不存在就跳過
  }
  function playFromQueue(id) {
    const i = queue.findIndex(x => x.id === id);
    if (i < 0) return;
    const [e] = queue.splice(i, 1);
    playEntry(e);
  }

  function pickNext() { // 非隨機模式:依清單順序
    if (!view.length) return null;
    const i = view.findIndex(f => f.filename === currentFile);
    if (i < 0) return view[0].filename;
    if (i + 1 < view.length) return view[i + 1].filename;
    return repeat === 'all' ? view[0].filename : null;
  }

  function advance() {
    dbg('advance, queue=', queue.length);
    if (isOffline()) return advanceOffline();
    if (queue.length) { playEntry(queue.shift()); return; }
    if (playlistCtx) {
      if (repeat === 'off') { setStatus('播放清單播放完畢'); return; }
      refillFromCtx(true); // 循環:新一輪
      if (queue.length) { playEntry(queue.shift()); return; }
      playlistCtx = null;
    }
    if (onlineCurrent) { onlineCurrent = null; markPlaying(); renderNext(); setStatus('佇列播放完畢'); return; }
    if (shuffle) {
      if (!view.length) return;
      if (repeat === 'off' && currentFile) { setStatus('隨機清單播放完畢'); return; }
      buildShuffle({ includeCurrent: true }); // 一輪播完:排出下一輪(剛播完的那首也要在裡面)
      if (queue.length) playEntry(queue.shift());
      else if (currentFile) { audio.currentTime = 0; tryPlay(); }
      return;
    }
    const n = pickNext();
    if (n) play(n);
  }

  function prev() {
    dbg('prev');
    // 已播放超過 3 秒:回到開頭(線上串流不能拖曳,就重新串流)
    if ((currentFile || onlineCurrent) && audio.currentTime > 3) {
      if (seekable()) audio.currentTime = 0;
      else if (onlineCurrent) playOnline(onlineCurrent, { pushHistory: false });
      return;
    }
    while (history.length) {
      const e = history.pop();
      if (e.kind === 'lib' && !byFile.has(e.filename)) continue; // 檔案已不存在:再往前找
      const cur = currentEntry();
      // 隨機模式或目前是線上歌曲:把目前這首放回佇列最前面,按「下一首」還能回來(先去重,避免連按「上一首」出現重複項)
      if (cur && (shuffle || cur.kind === 'online')) {
        queue = queue.filter(x => entryKey(x) !== entryKey(cur));
        queue.unshift(cur.kind === 'lib' ? mkLib(cur.filename) : mkOnline(cur.item));
      }
      playEntry(e, { pushHistory: false });
      renderNext();
      return;
    }
    if (onlineCurrent) { playOnline(onlineCurrent, { pushHistory: false }); return; }
    if (shuffle) return;
    const i = view.findIndex(f => f.filename === currentFile);
    if (i > 0) play(view[i - 1].filename, { pushHistory: false });
    else if (view.length && repeat === 'all') play(view[view.length - 1].filename, { pushHistory: false });
  }

  function toggle() {
    if (!currentFile && !onlineCurrent) {
      if (queue.length) { advance(); return; } // 佇列(含重開頁面時排好的隨機佇列、手動加入的線上歌曲)優先
      if (!view.length) return;
      start(shuffle ? view[Math.floor(Math.random() * view.length)].filename : view[0].filename);
      return;
    }
    if (audio.paused) { userPaused = false; tryPlay(); } else { pendingPlay = false; switchPending = false; userPaused = true; audio.pause(); keepOff(); }
  }

  // ── audio 事件 ──
  let dragging = false;
  const seekable = () => isFinite(audio.duration) && audio.duration > 0;

  // 通知欄／鎖屏的進度條:明確告訴系統「這首歌」的長度與位置。
  // 靜音保活元素(1 秒循環)也在播放,不主動設定的話系統可能拿它的長度而不是歌曲的,導致不顯示總長、不能拖曳。
  let lastPosDur = 0, lastPosAt = 0;
  function updatePositionState() {
    if (!IS_ANDROID || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    lastPosAt = Date.now();
    try {
      if (seekable()) {
        lastPosDur = audio.duration;
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(Math.max(0, audio.currentTime || 0), audio.duration),
        });
      } else {
        lastPosDur = 0;
        navigator.mediaSession.setPositionState(); // 串流中沒有總長度:清除
      }
    } catch (err) { dbg('setPositionState 失敗', err); }
  }

  function updateProgress() {
    const can = seekable();
    if (can && (audio.duration !== lastPosDur || Date.now() - lastPosAt > 4000)) updatePositionState();
    const cur = audio.currentTime || 0;
    const p = can ? Math.min(100, cur / audio.duration * 100) : 0;
    for (const r of [$('seek'), $('fSeek')]) {
      r.disabled = !can;
      if (!dragging) r.value = p * 10;
      r.style.setProperty('--p', p + '%');
    }
    const durText = can ? fmt(audio.duration) : ((currentFile || onlineCurrent) ? '串流中' : '0:00');
    $('barCur').textContent = fmt(cur);
    $('barDur').textContent = durText;
    $('fCur').textContent = fmt(cur);
    $('fDur').textContent = durText;
    $('miniProg').style.width = p + '%';
  }
  function updatePlayIcons() {
    updatePositionState();
    const name = audio.paused ? 'play' : 'pause';
    ['toggle', 'miniToggle', 'fToggle'].forEach(id => setIcon($(id), name));
    $('bigCover').classList.toggle('paused', audio.paused);
  }
  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied', 'seeked']) audio.addEventListener(ev, updateProgress);
  for (const ev of ['play', 'pause', 'ended', 'emptied']) audio.addEventListener(ev, updatePlayIcons);

  // ended 可重入:事件漏掉時 recover() 也能安全補呼叫,且同一次結束只處理一次
  function onEnded() {
    if (endHandled) return;
    endHandled = true;
    autoSwitchAt = Date.now(); autoResumes = 0;
    dbg('ended', 'hidden=', document.hidden, 'time=', audio.currentTime);
    errorStreak = 0;
    if (repeat === 'one') {
      if (onlineCurrent) playOnline(onlineCurrent);
      else { audio.currentTime = 0; tryPlay(); }
    } else advance();
  }
  audio.addEventListener('canplay', () => {
    if (IS_ANDROID && switchPending && audio.paused && !audio.ended) { dbg('canplay: 補打 play'); tryPlay(1); }
  });
  if (DEBUG_UI) for (const ev of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'waiting', 'stalled', 'suspend', 'abort', 'error', 'emptied', 'seeking', 'seeked']) {
    audio.addEventListener(ev, () => dbg('audio:' + ev,
      'rs=' + audio.readyState, 'ns=' + audio.networkState, 'paused=' + audio.paused,
      't=' + (audio.currentTime || 0).toFixed(1) + '/' + (isFinite(audio.duration) ? audio.duration.toFixed(1) : '?'),
      ev === 'error' && audio.error ? 'code=' + audio.error.code + ' ' + (audio.error.message || '') : ''));
  }
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('emptied', () => { endHandled = false; });
  audio.addEventListener('pause', () => {
    // 真正發生 pause(使用者、來電、系統中斷):不要讓 recover() 自動恢復
    // 播放自然結束時也會先觸發 pause,那種情況不算
    if (audio.ended) return;
    // 自動換歌後數秒內、不是使用者按的暫停(多半是 Android 在背景換歌時把媒體暫停):
    // 視為「換歌後沒播起來」,直接補打 play,並留著 switchPending 讓解鎖時 recover() 再補一次
    // 實測系統會在剛換歌後連續暫停好幾次(間隔約 10~100ms,持續 ~0.3 秒),所以用遞增延遲重試,最多 8 次
    const inWin = IS_ANDROID && !userPaused && inAutoWindow() && (currentFile || onlineCurrent);
    const spurious = inWin && autoResumes < RESUME_DELAYS.length;
    dbg('pause', 'hidden=', document.hidden, 'time=', audio.currentTime, 'userPaused=', userPaused,
      spurious ? '→ 非使用者暫停,自動恢復 #' + (autoResumes + 1) + '(' + RESUME_DELAYS[autoResumes] + 'ms 後)' : (inWin ? '→ 恢復次數用完,留待解鎖／回前景補救' : ''));
    if (spurious) {
      const delay = RESUME_DELAYS[autoResumes++];
      switchPending = true; pendingPlay = true;
      setSession('playing');
      const tok = srcTok;
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        if (tok !== srcTok || userPaused || !audio.paused) return;
        dbg('自動恢復:play()');
        tryPlay(3);
      }, delay);
      return;
    }
    if (inWin) switchPending = true; // 放棄自動恢復,但保留旗標:回到前景時 recover() 會再補打 play
    pendingPlay = false;
    keepOff();
    setSession('paused');
  });
  audio.addEventListener('playing', () => {
    lastPlayingAt = Date.now();
    switchPending = false; errorStreak = 0; pendingPlay = false; endHandled = false;
    setSession('playing'); setStatus('');
    dbg('playing');
    preloadNext();
  });
  audio.addEventListener('volumechange', () => {
    $('vol').value = Math.round(audio.volume * 100);
    $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');
    savePrefs();
  });
  // 任何播放錯誤都先確認登入還有效(用輕量的 capabilities,不用抓整份清單)。
  // 過期就停下來要求重新登入,而不是一路「無法播放、已略過」下去。
  async function stillLoggedIn() {
    try {
      const r = await fetch('/web/api/capabilities');
      if (r.status === 401) { pendingPlay = false; audio.pause(); showLogin('登入已過期,請重新登入'); return false; }
    } catch {}
    return true;
  }
  // 網路探測:用不經過 Service Worker 快取的 /health(任何回應都代表連得上伺服器)
  async function netOk() {
    if (navigator.onLine === false) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try { await fetch('/health?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal }); return true; }
    catch { return false; }
    finally { clearTimeout(timer); }
  }
  // 網路不通:停在目前這首等待恢復,不跳歌、不計入失敗次數
  function waitForNetwork(key) {
    waitingNet = key; waitingSince = 0; pendingPlay = false;
    if (currentFile && audio.currentTime > 3) resumeAt = { key, t: audio.currentTime };
    setStatus('網路連線中斷,恢復後會自動繼續播放', true);
    dbg('等待網路恢復', key);
  }
  async function checkNetWait() {
    if (!waitingNet || Date.now() - netProbeAt < 4000) return;
    netProbeAt = Date.now();
    const key = waitingNet;
    if (!(await netOk())) return;
    if (nowKey() !== key) { waitingNet = ''; return; } // 等待期間已經換歌了
    if (waitingNet !== key || !lastSrc) return;
    dbg('網路恢復,重新載入目前這首');
    setStatus('網路已恢復,繼續播放');
    loadSource(lastSrc.key, lastSrc.url);
  }
  audio.addEventListener('loadedmetadata', () => {
    if (resumeAt && resumeAt.key === nowKey() && seekable()) { try { audio.currentTime = Math.max(0, Math.min(resumeAt.t, audio.duration - 1)); } catch {} }
    resumeAt = null;
  });
  audio.addEventListener('waiting', () => { if (!waitingSince) waitingSince = Date.now(); });
  for (const ev of ['playing', 'pause', 'emptied']) audio.addEventListener(ev, () => { waitingSince = 0; });
  audio.addEventListener('error', async () => {
    pendingPlay = false;
    dbg('error', audio.error && audio.error.code, 'hidden=', document.hidden, 'time=', audio.currentTime);
    if (!currentFile && !onlineCurrent) return;
    const key = nowKey();
    if (!(await stillLoggedIn())) return;
    if (nowKey() !== key) return; // 等待期間已經換歌了
    // 先確認是不是網路問題:連不上就等,不要一直跳歌
    if (!(await netOk())) {
      if (nowKey() === key) waitForNetwork(key);
      return;
    }
    if (nowKey() !== key) return;
    if (onlineCurrent) {
      setStatus('線上串流失敗(可能被平台限制、影片不可用或伺服器忙碌)');
      if (queue.length) later(advance);
      return;
    }
    // 網路正常、只有這首失敗:先重試同一首,連續失敗多次才略過
    if (errorRetryKey !== key) { errorRetryKey = key; errorRetry = 0; }
    if (errorRetry < ERROR_RETRIES && lastSrc) {
      errorRetry += 1;
      setStatus(`這首載入失敗,重試中(${errorRetry}/${ERROR_RETRIES})…`);
      dbg('載入失敗,重試同一首', errorRetry + '/' + ERROR_RETRIES);
      setTimeout(() => { if (nowKey() === key && lastSrc) loadSource(lastSrc.key, lastSrc.url); }, 1500 * errorRetry);
      return;
    }
    errorRetryKey = '';
    errorStreak += 1;
    if (errorStreak < Math.min(view.length, 5)) { setStatus('這首無法播放,已略過'); later(advance); }
    else setStatus('連續多首無法播放,已停止');
  });

  // ── 補救機制(頁面醒來 / 事件漏掉)──
  function recover() {
    // 網路中斷等待中:只負責探測網路,恢復了就重新載入這首(不做其他補救,避免互相干擾)
    if (waitingNet) { checkNetWait(); return; }
    // 沒有任何播放意圖了(播完、使用者暫停、放棄恢復):停掉靜音保活元素
    if (!keep.paused && (audio.paused || audio.ended) && !pendingPlay && !switchPending) { dbg('保活元素:無播放意圖,停止'); keepOff(); }
    if (!currentFile && !onlineCurrent) return;
    // 串流中途卡在緩衝超過 12 秒:確認是不是斷網,是的話停下來等,不是就繼續等(重新計時)
    if (waitingSince && !audio.paused && !netChecking && Date.now() - waitingSince > 12000) {
      netChecking = true;
      const k = nowKey();
      netOk().then((ok) => {
        netChecking = false;
        if (nowKey() !== k) return;
        if (!ok) waitForNetwork(k); else waitingSince = Date.now();
      });
    }
    if (audio.ended && !endHandled) { dbg('recover: 補呼叫 ended'); onEnded(); return; }
    if (IS_ANDROID && switchPending && currentFile && audio.readyState === 0 && lastSrc && Date.now() - loadAt > 10000) {
      dbg('recover: 載入逾時(>10s),重新載入'); loadSource(lastSrc.key, lastSrc.url); return;
    }
    if (IS_ANDROID && switchPending && audio.paused && !audio.ended) {
      // readyState 0 且沒在載入(networkState 2 = LOADING):請求已經死了,重新載入
      if (audio.readyState === 0 && audio.networkState !== 2 && lastSrc) {
        dbg('recover: 音源未載入,重新載入'); loadSource(lastSrc.key, lastSrc.url); return;
      }
      dbg('recover: 已換歌但未播放,補打 play'); tryPlay(1); return;
    }
    if (pendingPlay && audio.paused) { dbg('recover: 補打 play'); tryPlay(1); }
  }
  // interval 在背景會被節流,只在前景有用;真正的補救靠下面三個「醒來」事件
  setInterval(recover, 3000);
  document.addEventListener('visibilitychange', () => { dbg('visibility', document.visibilityState); recover(); });
  window.addEventListener('pageshow', recover);
  window.addEventListener('online', () => { netProbeAt = 0; recover(); });

  // ── 控制項 ──
  function syncButtons() {
    ['shuffle', 'fShuffle'].forEach(id => $(id).classList.toggle('on', shuffle));
    ['repeat', 'fRepeat'].forEach(id => {
      $(id).classList.toggle('on', repeat !== 'off');
      setIcon($(id), repeat === 'one' ? 'repeat1' : 'repeat');
      $(id).title = REPEAT_LABEL[repeat];
    });
    renderNext();
  }
  const cycleRepeat = () => { repeat = REPEATS[(REPEATS.indexOf(repeat) + 1) % REPEATS.length]; syncButtons(); savePrefs(); setStatus(REPEAT_LABEL[repeat]); };
  function toggleShuffle() {
    shuffle = !shuffle;
    if (playlistCtx) refillFromCtx(); else if (shuffle) buildShuffle();                       // 點下去的當下就排好
    else queue = queue.filter(e => e.kind === 'online'); // 關閉:回到依清單順序,保留手動加入的線上歌曲
    syncButtons(); savePrefs();
    setStatus(shuffle ? '隨機播放:開(已排好佇列,可在「佇列」拖曳調整)' : '隨機播放:關');
  }

  ['toggle', 'miniToggle', 'fToggle'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); toggle(); }));
  ['next', 'miniNext', 'fNext'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); advance(); }));
  ['prev', 'fPrev'].forEach(id => $(id).addEventListener('click', prev));
  ['shuffle', 'fShuffle'].forEach(id => $(id).addEventListener('click', toggleShuffle));
  ['repeat', 'fRepeat'].forEach(id => $(id).addEventListener('click', cycleRepeat));

  for (const id of ['seek', 'fSeek']) {
    const r = $(id);
    r.addEventListener('pointerdown', () => { dragging = true; });
    const end = () => { dragging = false; };
    r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end); r.addEventListener('blur', end);
    r.addEventListener('input', (e) => {
      if (!seekable()) return;
      audio.currentTime = e.target.value / 1000 * audio.duration;
      updateProgress();
    });
  }
  $('vol').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
  $('vol').value = Math.round(audio.volume * 100);
  $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');

  $('shuffleAll').addEventListener('click', () => {
    if (!view.length) return;
    shuffle = true;
    playlistCtx = null;
    history = [];
    play(view[Math.floor(Math.random() * view.length)].filename);
    buildShuffle();
    syncButtons(); savePrefs();
    setStatus('已排出隨機佇列');
  });

  if ('mediaSession' in navigator) {
    const setHandler = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
    setHandler('previoustrack', () => { dbg('mediaSession:previoustrack'); prev(); });
    setHandler('nexttrack', () => { dbg('mediaSession:nexttrack'); advance(); });
    if (IS_ANDROID) {
    // 通知欄進度條拖曳／快轉快退(沒有 seekto 處理器的話,系統不會開放拖曳)
    setHandler('seekto', (d) => {
      dbg('mediaSession:seekto', d && d.seekTime);
      if (!seekable() || !d || typeof d.seekTime !== 'number') return;
      audio.currentTime = Math.min(Math.max(0, d.seekTime), audio.duration);
      updatePositionState();
    });
    setHandler('seekbackward', (d) => {
      if (!seekable()) return;
      audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); updatePositionState();
    });
    setHandler('seekforward', (d) => {
      if (!seekable()) return;
      audio.currentTime = Math.min(audio.duration, audio.currentTime + ((d && d.seekOffset) || 10)); updatePositionState();
    });
    }
    setHandler('play', () => { dbg('mediaSession:play'); userPaused = false; tryPlay(); });
    setHandler('pause', () => {
      // 自動換歌剛開始播的 1.5 秒內、頁面在背景收到的 pause 動作:不是使用者按的,忽略
      const spurious = IS_ANDROID && document.hidden && inAutoWindow() && Date.now() - lastPlayingAt < 1500;
      dbg('mediaSession:pause', spurious ? '(換歌後立即收到,忽略)' : '');
      if (spurious) return;
      pendingPlay = false; switchPending = false; userPaused = true; audio.pause(); keepOff(); setSession('paused');
    });
  }

  // 全螢幕播放頁
  function openFull() {
    if (isFullOpen()) return;
    $('full').classList.add('open'); if (nextDirty) flushNext();
    pushLayer('full', closeFull);
  }
  function closeFull() {
    if (!isFullOpen()) return;
    $('full').classList.remove('open');
    dropLayer('full');
  }
  $('nowOpen').addEventListener('click', openFull);
  $('expand').addEventListener('click', openFull);
  $('miniOpen').addEventListener('click', openFull);
  $('close').addEventListener('click', closeFull);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('full').dataset.tab = t.dataset.tab;
  }));

  const skipKey = (e) => (e.target.matches && e.target.matches('input:not([type=range]), select, textarea')) || e.ctrlKey || e.metaKey || e.altKey;
  // 空白鍵在按鈕上會在 keyup 觸發 click,與上面的全域播放／暫停疊加成「按了沒反應」
  document.addEventListener('keyup', (e) => { if (e.key === ' ' && !skipKey(e)) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if (skipKey(e)) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'n' || e.key === 'N') advance();
    else if (e.key === 'p' || e.key === 'P') prev();
    else if (e.key === 's' || e.key === 'S') toggleShuffle();
    else if (e.key === 'r' || e.key === 'R') cycleRepeat();
    else if (e.key === '?') toggleHelp(true);
    else if (e.key === 'Escape') {
      if ($('helpDlg').classList.contains('show')) toggleHelp(false);
      else if ($('pickPl').classList.contains('show')) closePick();
      else if ($('full').classList.contains('open')) closeFull();
      else if (plSel.on) setPlSelecting(false); else if (libSel.on) setLibSelecting(false);
    }
    // 焦點在進度條時瀏覽器本身也會處理方向鍵(±0.1%),要 preventDefault 才不會蓋掉 ±10 秒;音量條則保留原生行為
    else if (e.key === 'ArrowRight' && seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
    else if (e.key === 'ArrowLeft' && seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 10); }
  });

  // ── 頁籤切換 ──
  // 每個頁面(播放清單內頁依清單分開)各自記住捲動位置,切回來時還原
  const scrollPos = new Map();
  const scrollKey = () => (mode === 'playlists' && plOpen ? 'pl:' + plOpen : mode);
  function saveScroll() { scrollPos.set(scrollKey(), $('main').scrollTop); }
  function restoreScroll() {
    const y = scrollPos.get(scrollKey()) || 0;
    $('main').scrollTop = y;
    requestAnimationFrame(() => { $('main').scrollTop = y; }); // 列表剛重畫完,下一幀再補一次
  }
  function setMode(m) {
    if (m === 'online' && !onlineAvailable) m = 'library';
    if (m === mode) { $('main').scrollTo({ top: 0, behavior: 'smooth' }); return; } // 再點一次目前的頁籤:回到最上面
    saveScroll();
    if (libSel.on) setLibSelecting(false);
    if (plSel.on) setPlSelecting(false);
    if (mode === 'playlists' && plOpen) dropLayer('pl'); // 內頁保留,但返回鍵不該在別的頁籤關掉看不到的內頁
    mode = m;
    if (m === 'playlists' && plOpen && plById(plOpen)) pushLayer('pl', closePlDetail);
    $('viewLibrary').hidden = m !== 'library';
    $('viewOnline').hidden = m !== 'online';
    $('viewPlaylists').hidden = m !== 'playlists';
    $('viewOffline').hidden = m !== 'offline';
    $('viewBots').hidden = m !== 'bots';
    if (m === 'bots') bots.show(); else bots.hide();
    document.body.classList.toggle('pl-detail', m === 'playlists' && !!plOpen && !!plById(plOpen));
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === m));
    const s = $('search');
    s.disabled = m === 'bots'; // Bot 頁籤沒有可搜尋的內容:找歌請到音樂庫／線上搜尋,再從「⋮」點給 Bot
    if (m === 'bots') { s.placeholder = '到「音樂庫」或「線上搜尋」找歌,從「⋮」點給 Bot'; s.value = ''; }
    else if (m === 'online') { s.placeholder = '搜尋 YouTube / Bilibili,或貼上影片網址,按 Enter'; s.value = onlineQuery; }
    else if (m === 'playlists') { s.placeholder = '搜尋播放清單…'; s.value = plQuery; renderPlaylists(); }
    else if (m === 'offline') { s.placeholder = '搜尋離線歌曲…'; s.value = offQuery; renderOffline(); updateQuota(); }
    else { s.placeholder = '搜尋歌名…'; s.value = libQuery; markPlaying(); }
    updateNetState();
    restoreScroll();
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.view)));

  // 音樂庫篩選每次都要重畫最多 300 列:連續打字時合併成停頓 100ms 後畫一次
  let filterTimer = 0;
  $('search').addEventListener('input', () => {
    if (mode === 'library') {
      libQuery = $('search').value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(applyFilter, 100);
    }
    else if (mode === 'playlists') { plQuery = $('search').value; renderPlaylists(); }
    else if (mode === 'offline') { offQuery = $('search').value; renderOffline(); }
    else onlineQuery = $('search').value;
  });

  // ── 線上搜尋/串流 ──
  async function loadCapabilities() {
    try {
      const r = await fetch('/web/api/capabilities');
      onlineAvailable = r.ok && !!(await r.json()).online;
    } catch { onlineAvailable = false; }
    document.querySelectorAll('.needs-online').forEach(el => { el.hidden = !onlineAvailable; });
    if (!onlineAvailable && mode === 'online') setMode('library');
  }

  async function apiJson(url) {
    const r = await fetch(url);
    if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('請先登入'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  const onlineRow = (r, { onClick, btn } = {}) => makeRow({
    key: 'on:' + r.url, title: r.title, sub: onlineSub(r),
    dur: r.duration && r.duration !== '未知' ? r.duration : '', btn, onClick,
  });

  // 手動排歌:next=true「下一首播放」放最前面;否則「加入佇列」排在其他手動排的歌之後、
  // 自動排的歌(隨機佇列、播放清單剩下的)之前。同一首歌不會重複出現在手動佇列裡。
  function enqueue(e, title, next) {
    e.user = true;
    const k = entryKey(e);
    queue = queue.filter((x) => !(x.user && entryKey(x) === k));
    if (next) queue.unshift(e);
    else { const i = queue.findIndex((x) => !x.user); queue.splice(i < 0 ? queue.length : i, 0, e); }
    renderNext();
    setStatus((next ? '下一首播放:' : '已加入佇列:') + title);
  }
  // it:音樂庫 { kind:'lib', filename, title } 或線上 { kind:'online', url, title, ... }(播放清單項目同格式)
  const queueItem = (it, next) => enqueue(it.kind === 'lib' ? mkLib(it.filename, it.title) : mkOnline(it), itemTitle(it), next);
  function addToQueue(r) { enqueue(mkOnline(r), r.title, false); }
  function queueMenuItems(it) {
    menuItem('play-next', '下一首播放', () => queueItem(it, true));
    menuItem('queue-add', '加入佇列', () => queueItem(it, false));
    if (bots.hasTargets()) menuItem('bot', '點給 Bot 播放', () => bots.sendToBot(it));
  }

  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (mode !== 'online') return; // 音樂庫搜尋是即時篩選,不需要送出
    const q = $('search').value.trim();
    onlineQuery = q;
    if (!q) return;
    $('search').blur();
    const box = $('onlineResults');
    box.textContent = '';
    $('onlineHint').textContent = '搜尋中…';
    try {
      const isUrl = /^https?:\/\//i.test(q);
      const j = await apiJson((isUrl ? '/web/api/info?url=' : '/web/api/search?q=') + enc(q));
      // 依推測:搜尋回 { results:[...] },網址解析回單一物件或 { item }
      const list = j.results || (j.item ? [j.item] : (j.url || j.title ? [j] : []));
      if (!list.length) { $('onlineHint').textContent = '找不到結果'; return; }
      $('onlineHint').textContent = `找到 ${list.length} 筆。點一下立即播放,「＋」加入佇列。`;
      const frag = document.createDocumentFragment();
      for (const r of list) {
        frag.appendChild(onlineRow(r, {
          onClick: () => { playlistCtx = null; history = []; playOnline(r); },
          btn: [
            { icon: 'plus', title: '加入佇列', onClick: () => addToQueue(r) },
            { icon: 'playlist-add', title: '加入播放清單', onClick: () => pickPlaylist([onlineItem(r)]) },
            ...(bots.hasTargets() ? [{ icon: 'bot', title: '點給 Bot 播放', onClick: () => bots.sendToBot(onlineItem(r)) }] : []),
          ],
        }));
      }
      box.appendChild(frag);
      markPlaying();
    } catch (err) {
      $('onlineHint').textContent = '搜尋失敗:' + err.message;
    }
  });

  // 播放線上歌曲(交給伺服器的 /web/play 處理)
  function playOnline(item, { pushHistory: ph = true } = {}) {
    dbg('playOnline', item.title);
    const same = onlineCurrent && entryKey({ kind: 'online', item: onlineCurrent }) === entryKey({ kind: 'online', item });
    if (ph && !same) pushHistory(); // 線上歌曲也進歷史,「上一首」才回得去
    currentFile = null;
    onlineCurrent = item;
    endHandled = false;
    const okey = 'on:' + (item.srcUrl || item.url);
    loadSource(okey, '/web/play?url=' + enc(item.srcUrl || item.url) + (WEBM_OK ? '&fmt=webm' : ''));
    if (!offlineKeys.has(okey)) setStatus('線上串流準備中…', true);
    setNow({ title: item.title, sub: onlineSub(item) });
  }

  // ════════════════════════════════════════════════════════
  //  播放清單 + 離線下載
  //  (狀態變數 playlists / plOpen / playlistCtx / offlineKeys / dlState 宣告在檔案上方)
  // ════════════════════════════════════════════════════════
  const PL_API = '/web/api/playlists';
  const itemKey = (it) => it.kind === 'lib' ? 'lib:' + it.filename : 'on:' + (it.srcUrl || it.url);
  const onlineItem = (r) => ({
    kind: 'online', url: r.srcUrl || r.url, title: r.title, author: r.author, platform: r.platform, duration: r.duration,
  });
  const itemTitle = (it) => it.kind === 'lib'
    ? ((byFile.get(it.filename) || {}).name || it.title || it.filename.split('/').pop())
    : (it.title || '未知標題');
  const plById = (id) => playlists.find((p) => p.id === id);
  function upsertPlaylist(p) {
    const i = playlists.findIndex((x) => x.id === p.id);
    if (i >= 0) playlists[i] = p; else playlists.push(p);
  }

  // ── 離線儲存(IndexedDB)──────────────────────────────
  const offlineSizes = new Map(); // key -> bytes
  const offlineMeta = new Map();  // key -> { title, at, author, platform, duration }(離線歌曲頁用,沒網路也看得到歌名)
  const { offlineGet, offlinePut, offlineDel, offlineClearAll, offlineScan } = window.MLOfflineStore; // 來自 offlineStore.js
  function offlineInit() {
    return offlineScan()
      .then((list) => {
        for (const r of list) {
          offlineKeys.add(r.key); offlineSizes.set(r.key, r.size);
          offlineMeta.set(r.key, { title: r.title, at: r.at, author: r.author, platform: r.platform, duration: r.duration });
        }
      })
      .catch(() => {});
  }

  // 載入音源:有離線檔就播離線的(blob URL,可拖曳),沒有才走網路
  let srcTok = 0, blobUrl = null, loadAt = 0;

  // ── 背景預載整首 ──
  // 實測 Android 鎖屏時,換歌那一刻才由 <audio> 發出的網路請求可能卡住(stalled)。
  // 頁面在背景時,趁目前這首正在播(系統不會限制網路),先把下一首整個抓成 blob,換歌時直接用 blob URL 播,
  // 完全不碰網路。前景不預載(省流量);只預載音樂庫曲目(線上串流長度未知)。
  let preload = null;          // { key, url }
  let preloadingKey = '';
  function dropPreload() {
    if (!preload) return;
    try { URL.revokeObjectURL(preload.url); } catch {}
    preload = null;
  }
  function nextLibFilename() {
    const e = queue[0];
    if (e) return e.kind === 'lib' ? e.filename : null;
    if (shuffle || onlineCurrent || !currentFile) return null;
    return pickNext();
  }
  async function preloadNext() {
    if (!IS_ANDROID || !document.hidden || !currentFile) return;
    const fn = nextLibFilename();
    if (!fn || fn === currentFile) return;
    const key = 'lib:' + fn;
    if (offlineKeys.has(key) || (preload && preload.key === key) || preloadingKey) return;
    const f = byFile.get(fn);
    if (!f || f.size > 40 * 1048576) return;
    preloadingKey = key;
    const t = Date.now();
    try {
      const r = await fetch(streamUrl(fn));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      dropPreload();
      preload = { key, url: URL.createObjectURL(blob) };
      dbg('預載完成', key, fmtSize(blob.size), (Date.now() - t) + 'ms');
    } catch (err) {
      dbg('預載失敗', key, err);
    } finally {
      preloadingKey = '';
    }
  }
  function loadSource(key, url) {
    const tok = ++srcTok;
    dbg('loadSource', key, offlineKeys.has(key) ? '(離線)' : '(網路)');
    switchPending = true; userPaused = false; loadAt = Date.now();
    waitingNet = ''; waitingSince = 0;
    lastSrc = { key, url };
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    if (preload && preload.key === key) { // 背景預載好的整首:不用再靠背景網路
      blobUrl = preload.url; preload = null;
      dbg('使用預載的檔案', key);
      audio.src = blobUrl; tryPlay(); return;
    }
    dropPreload();
    if (!offlineKeys.has(key)) { audio.src = url; tryPlay(); return; }
    if (!(IS_ANDROID && audio.ended)) { audio.removeAttribute('src'); audio.load(); } // 等 blob 讀出來之前不要讓舊的音源繼續播(剛播完時保留,避免元素完全空窗)
    pendingPlay = true; setSession('playing');
    offlineGet(key).then((blob) => {
      if (tok !== srcTok) return;
      if (blob) { blobUrl = URL.createObjectURL(blob); audio.src = blobUrl; } else audio.src = url;
      tryPlay();
    }).catch(() => { if (tok === srcTok) { audio.src = url; tryPlay(); } });
  }

  // ── 下載(引擎在 downloader.js;最多同時 2 首,可整批取消)──────
  const { enqueueDownloads: enqueueRaw, cancelDownloads, dlBusy, getBatch } = window.MLDownloader.createDownloader({
    offlineKeys, offlineSizes, offlineMeta, dlState, itemKey, streamUrl, enc, offlinePut, setStatus, showLogin, refreshDl,
  });

  const enqueueDownloads = (items) => enqueueRaw(items.map((it) =>
    it.kind === 'lib' && !it.duration && libDur(byFile.get(it.filename)) ? { ...it, duration: libDur(byFile.get(it.filename)) } : it));

  // ── 離線模式:沒網路(或連不到伺服器)時顯示提示、淡化沒下載的歌,點了直接說明 ──
  let serverDown = false;
  const isOffline = () => navigator.onLine === false || serverDown;
  const entryPlayable = (e) => !isOffline() || offlineKeys.has(entryKey(e));
  function updateNetState() {
    const off = isOffline();
    document.body.classList.toggle('is-offline', off);
    $('netBanner').hidden = !off;
    $('netGoOff').hidden = mode === 'offline' || !offlineKeys.size;
  }
  window.addEventListener('offline', () => {
    updateNetState();
    const c = currentEntry();
    if (c && !audio.paused && !offlineKeys.has(entryKey(c))) {
      setStatus('網路中斷了,這首歌沒有下載,播放可能會停止', false,
        offlineKeys.size ? { label: '改播離線歌曲', fn: () => { setMode('offline'); playCtx(OFF_CTX, offView, null, false); } } : null);
    } else setStatus('網路中斷了,目前只能播放已下載的歌曲');
  });
  window.addEventListener('online', () => {
    const wasDown = serverDown; serverDown = false;
    updateNetState();
    setStatus('已恢復連線');
    if (wasDown || !all.length) loadList();
  });
  $('netGoOff').addEventListener('click', () => setMode('offline'));
  // 離線時點到沒下載的歌:在列自己的點擊處理之前攔下來
  document.addEventListener('click', (e) => {
    if (!isOffline()) return;
    const row = e.target.closest('.row[data-key]');
    if (!row || row.classList.contains('offline') || row.closest('.selecting')) return;
    if (e.target.closest('.rbtn, .grip')) return; // ⋮ 選單、拖曳照常可用
    e.stopPropagation(); e.preventDefault();
    setStatus('目前離線,這首歌還沒下載');
  }, true);
  // 離線時「下一首」:跳過沒下載的歌,在目前的播放範圍裡找下一首已下載的
  function advanceOffline() {
    const qi = queue.findIndex(entryPlayable);
    if (qi >= 0) { const [e] = queue.splice(qi, 1); playEntry(e); return; }
    const pool = playlistCtx ? playlistCtx.items.filter(ctxPlayable).map(ctxEntry) : view.map((f) => mkLib(f.filename, f.name));
    const cur = currentEntry(), ck = cur ? entryKey(cur) : null;
    const ok = pool.filter((e) => entryPlayable(e) && entryKey(e) !== ck);
    if (!ok.length) { setStatus('目前離線,沒有其他已下載的歌曲'); return; }
    let next;
    if (shuffle) next = ok[Math.floor(Math.random() * ok.length)];
    else {
      const ci = pool.findIndex((e) => entryKey(e) === ck);
      next = pool.slice(ci + 1).find((e) => entryPlayable(e) && entryKey(e) !== ck) || (repeat === 'all' ? ok[0] : null);
    }
    if (!next) { setStatus('目前離線,後面沒有已下載的歌曲'); return; }
    playEntry(next);
  }

  async function removeOffline(items) {
    for (const it of items) {
      const k = itemKey(it);
      if (!offlineKeys.has(k)) continue;
      try { await offlineDel(k); offlineKeys.delete(k); offlineSizes.delete(k); offlineMeta.delete(k); } catch {}
    }
    refreshDl();
  }

  // 移除單首離線檔案:先把音檔留在記憶體,提示裡按「復原」就寫回去(不必重新下載)
  async function removeOfflineUndoable(it) {
    const k = itemKey(it);
    if (!offlineKeys.has(k)) return;
    let blob = null;
    try { blob = await offlineGet(k); } catch {}
    const size = offlineSizes.get(k) || 0, meta = offlineMeta.get(k) || {};
    await removeOffline([it]);
    setStatus('已移除離線檔案', false, blob && { label: '復原', fn: async () => {
      try {
        await offlinePut({ key: k, blob, size, ...meta });
        offlineKeys.add(k); offlineSizes.set(k, size); offlineMeta.set(k, meta);
        refreshDl(); setStatus('已復原');
      } catch (err) { setStatus('復原失敗:' + (err.message || err)); }
    } });
  }

  function toggleOffline(it) {
    const k = itemKey(it);
    if (offlineKeys.has(k)) removeOfflineUndoable(it);
    else if (dlState.has(k)) setStatus('下載中,請稍候');
    else enqueueDownloads([it]);
  }

  // ── 下載狀態的畫面更新(合併成每個 frame 最多一次)──────
  let dlRaf = 0;
  function refreshDl() {
    if (dlRaf) return;
    dlRaf = requestAnimationFrame(() => { dlRaf = 0; paintDl(); });
  }
  function applyDlButton(b) {
    const k = b.dataset.dlkey, st = dlState.get(k);
    const off = offlineKeys.has(k);
    b.classList.toggle('done', off);
    b.style.fontSize = '';
    if (off) { b.innerHTML = '<svg><use href="#i-downloaded"/></svg>'; b.title = '已下載(點擊移除)'; }
    else if (st) {
      b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
      b.style.fontSize = '11px';
      b.title = st.active ? '下載中' : '等待下載';
    } else { b.innerHTML = '<svg><use href="#i-download"/></svg>'; b.title = '下載離線'; }
  }
  let offSig = '', quotaText = '';
  function updateOfflineInfo() {
    const n = offlineKeys.size;
    let bytes = 0; offlineSizes.forEach((v) => { bytes += v; });
    $('offlineInfo').textContent = (n ? `已下載 ${n} 首,共 ${fmtSize(bytes)}` : '尚未下載任何歌曲') + quotaText;
    $('offlineClear').hidden = n === 0;
    $('offCount').textContent = n ? `${n} 首` : '';
    // 內容有變(下載完成/移除)才重畫離線歌曲頁
    const sig = n + ':' + bytes;
    if (sig !== offSig) { offSig = sig; if (mode === 'offline') renderOffline(); updateQuota(); }
  }
  // 裝置剩餘空間(瀏覽器估算值,不支援就不顯示)
  function updateQuota() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(({ usage = 0, quota = 0 }) => {
      quotaText = quota ? ` · 裝置可用約 ${fmtSize(Math.max(0, quota - usage))}` : '';
      const n = offlineKeys.size;
      let bytes = 0; offlineSizes.forEach((v) => { bytes += v; });
      $('offlineInfo').textContent = (n ? `已下載 ${n} 首,共 ${fmtSize(bytes)}` : '尚未下載任何歌曲') + quotaText;
    }).catch(() => {});
  }
  function updatePlDetailButtons() {
    const p = plOpen && plById(plOpen);
    if (!p) return;
    const nOff = p.items.filter((it) => offlineKeys.has(itemKey(it))).length;
    $('plMeta').textContent = `${p.items.length} 首歌曲` + (nOff ? ` · 已下載 ${nOff} 首` : '');
    const b = $('plDownloadAll');
    const dls = p.items.filter(plDownloadable);
    const busy = dlBusy(), allOff = dls.length > 0 && dls.every((it) => offlineKeys.has(itemKey(it)));
    b.classList.toggle('done', !busy && allOff);
    b.style.fontSize = '';
    if (busy) { b.textContent = `${getBatch().done + getBatch().failed}/${getBatch().total}`; b.style.fontSize = '12px'; b.title = '取消下載'; }
    else { b.innerHTML = `<svg><use href="#i-${allOff ? 'downloaded' : 'download'}"/></svg>`; b.title = allOff ? '已下載(點擊移除)' : '下載離線'; }
  }
  function paintDl() {
    document.querySelectorAll('.row[data-key]').forEach((r) => r.classList.toggle('offline', offlineKeys.has(r.dataset.key)));
    document.querySelectorAll('[data-dlkey]').forEach(applyDlButton);
    document.querySelectorAll('[data-dlmenu]').forEach(applyMoreButton);
    updatePlDetailButtons();
    updateOfflineInfo();
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/player-sw.js', { scope: '/' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) setStatus('播放器已有新版，重新整理後生效');
          });
        });
      })
      .catch((err) => dbg('SW 註冊失敗', err && err.message));
  }
  function clearDataCaches() {
    if (!window.caches) return;
    caches.keys().then((ks) => ks.filter((k) => k.startsWith('ml-data-')).forEach((k) => caches.delete(k))).catch(() => {});
  }

  // ── 播放清單 API ───────────────────────────────────────
  async function plApi(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('連線失敗(離線時無法編輯播放清單)'); }
    if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('請先登入'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    if (method !== 'GET') fetch(PL_API).catch(() => {}); // 順便刷新 Service Worker 的離線快取
    return j;
  }

  async function loadPlaylists() {
    try { playlists = (await plApi('GET', PL_API)).playlists || []; } catch { return; }
    if (plOpen && !plById(plOpen)) { plOpen = null; dropLayer('pl'); }
    if (playlistCtx && plById(playlistCtx.id)) playlistCtx.items = plById(playlistCtx.id).items;
    renderPlaylists();
  }

  // ── 播放清單 → 佇列 ───────────────────────────────────
  const ctxEntry = (it) => {
    const e = it.kind === 'lib' ? mkLib(it.filename, it.title) : mkOnline(it);
    e.src = it.id;
    return e;
  };
  const ctxPlayable = (it) => it.kind === 'online' || libAvailable(it.filename);
  // 依目前的隨機/循環設定,把播放清單剩下的歌排進佇列
  // full=true:新一輪(包含目前這首)
  function refillFromCtx(full = false) {
    if (!playlistCtx) return;
    const cur = currentEntry(), ck = cur ? entryKey(cur) : null;
    let list = playlistCtx.items.filter(ctxPlayable).map(ctxEntry);
    if (shuffle) {
      if (!full && ck) list = list.filter((e) => entryKey(e) !== ck);
      list = shuffled(list);
      if (full && ck && list.length > 1 && entryKey(list[0]) === ck) {
        const j = 1 + Math.floor(Math.random() * (list.length - 1));
        [list[0], list[j]] = [list[j], list[0]];
      }
    } else if (!full && ck) {
      const i = list.findIndex((e) => entryKey(e) === ck);
      if (i >= 0) list = list.slice(i + 1);
    }
    queue = queue.filter((e) => e.user).concat(list); // 手動排的歌不受影響
    renderNext();
  }
  // 播放清單內容變動(加入/移除/排序)時,讓進行中的播放跟著更新
  function syncCtx(pid, { added = [], removedId = null, reordered = false } = {}) {
    if (!playlistCtx || playlistCtx.id !== pid) return;
    const p = plById(pid);
    playlistCtx.items = p ? p.items : [];
    if (removedId) queue = queue.filter((e) => e.src !== removedId);
    for (const it of added) {
      if (!ctxPlayable(it)) continue;
      const e = ctxEntry(it);
      if (shuffle) queue.splice(Math.floor(Math.random() * (queue.length + 1)), 0, e); else queue.push(e);
    }
    if (reordered && !shuffle) refillFromCtx();
    renderNext();
  }

  function playPlaylist(pid, startId, { shuffleStart = false } = {}) {
    const p = plById(pid); if (!p) return;
    if (!playCtx(pid, p.items, startId, shuffleStart)) return setStatus('這個播放清單沒有可播放的歌曲');
    if (shuffleStart) setStatus('隨機播放「' + p.name + '」');
  }
  // 以一組項目(播放清單或離線歌曲)作為播放範圍開始播;沒有可播的回 false
  function playCtx(id, all, startId, shuffleStart) {
    const items = all.filter(ctxPlayable);
    if (!items.length) return false;
    if (shuffleStart) { shuffle = true; syncButtons(); savePrefs(); }
    let first;
    if (startId) first = items.find((it) => it.id === startId) || items[0];
    else if (shuffleStart) first = items[Math.floor(Math.random() * items.length)];
    else first = items[0]; // ▶ 一律從第一首開始(隨機開啟時,後面的順序才會打亂)
    playlistCtx = { id, items: all };
    history = [];
    queue = [];
    playEntry(first.kind === 'lib' ? { kind: 'lib', filename: first.filename, title: first.title } : { kind: 'online', item: first });
    refillFromCtx();
    return true;
  }

  // ── 離線歌曲頁 ────────────────────────────────────────
  // 資料完全來自這台裝置的 IndexedDB(offlineKeys / offlineMeta),沒有網路也能列出與播放
  const OFF_CTX = '__offline';
  let offSort = 'recent', offView = [];
  function offItem(key) {
    const m = offlineMeta.get(key) || {};
    if (key.startsWith('lib:')) {
      const filename = key.slice(4), f = byFile.get(filename);
      return { id: key, kind: 'lib', filename, title: (f && f.name) || m.title || filename.split('/').pop(), duration: libDur(f) || m.duration || '', at: m.at || 0 };
    }
    return { id: key, kind: 'online', url: key.slice(3), title: m.title || '未知標題', author: m.author, platform: m.platform, duration: m.duration, at: m.at || 0 };
  }
  const offSub = (it) => it.kind === 'lib' ? (it.filename.includes('/') ? it.filename.split('/')[0] : '音樂庫') : onlineSub(it);
  function renderOffline() {
    const q = zhFold(offQuery.trim());
    let list = [...offlineKeys].map(offItem);
    if (q) list = list.filter((it) => zhFold(it.title + '\n' + offSub(it)).includes(q));
    if (offSort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
    else list.sort((a, b) => b.at - a.at);
    offView = list;
    const ul = $('offList'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    list.forEach((it, i) => frag.appendChild(makeRow({
      key: it.id, idx: i + 1, title: it.title, sub: offSub(it), dur: it.duration && it.duration !== '未知' ? it.duration : '',
      btn: { icon: 'more', title: '更多', onClick: (b) => openOffMenu(b, it) },
      onClick: () => playCtx(OFF_CTX, offView, it.id, false),
    })));
    ul.appendChild(frag);
    const none = offlineKeys.size === 0;
    $('offEmpty').hidden = list.length > 0;
    $('offEmptyText').textContent = none ? '還沒有離線歌曲' : '沒有符合的離線歌曲';
    $('offEmptyHint').hidden = !none; $('offGoPl').hidden = !none;
    $('offSort').hidden = none;
    $('offPlay').hidden = $('offShuffle').hidden = none; // 沒有離線歌曲時不顯示播放鈕
    $('offPlay').disabled = $('offShuffle').disabled = !list.length;
    markPlaying();
  }
  function openOffMenu(anchor, it) {
    if (menuAnchor === anchor) return closeRowMenu();
    menuAnchor = anchor;
    menuEl.textContent = '';
    const item = it.kind === 'lib' ? { kind: 'lib', filename: it.filename, title: it.title }
      : { kind: 'online', url: it.url, title: it.title, author: it.author, platform: it.platform, duration: it.duration };
    queueMenuItems(item);
    menuItem('playlist-add', '加入播放清單', () => pickPlaylist([item]));
    menuItem('delete', '移除離線檔案', () => removeOfflineUndoable(item), 'danger');
    const at = it.at ? new Date(it.at).toLocaleString() : '';
    menuInfo([
      ['來源:', offSub(it)],
      ...(it.duration ? [['長度:', it.duration]] : []),
      ['檔案大小:', fmtSize(offlineSizes.get(it.id) || 0)],
      ...(at ? [['下載時間:', at]] : []),
    ]);
    placeMenu(anchor);
  }
  $('offPlay').addEventListener('click', () => playCtx(OFF_CTX, offView, null, false));
  $('offShuffle').addEventListener('click', () => { if (playCtx(OFF_CTX, offView, null, true)) setStatus('隨機播放離線歌曲'); });
  $('offGoPl').addEventListener('click', () => setMode('playlists'));
  $('offSort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    offSort = b.dataset.sort;
    $('offSort').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
    renderOffline();
  });

  function toggleHelp(show) {
    if (show === $('helpDlg').classList.contains('show')) return;
    $('helpDlg').classList.toggle('show', show);
    if (show) { $('helpClose').focus(); pushLayer('help', () => toggleHelp(false)); } else dropLayer('help');
  }
  $('helpBtn').addEventListener('click', () => toggleHelp(true));
  $('helpClose').addEventListener('click', () => toggleHelp(false));
  $('helpDlg').addEventListener('click', (e) => { if (e.target === $('helpDlg')) toggleHelp(false); });

  // ── 播放清單操作 ──────────────────────────────────────
  async function createPlaylist(name, items) {
    const j = await plApi('POST', PL_API, { name, items });
    upsertPlaylist(j.playlist);
    return j.playlist;
  }
  async function addToPlaylist(pid, items) {
    const before = new Set((plById(pid) || { items: [] }).items.map((x) => x.id));
    const j = await plApi('POST', `${PL_API}/${pid}/items`, { items });
    upsertPlaylist(j.playlist);
    syncCtx(pid, { added: j.playlist.items.filter((x) => !before.has(x.id)) });
    renderPlaylists();
    return j;
  }
  async function removeFromPlaylist(pid, iid) {
    try {
      const j = await plApi('DELETE', `${PL_API}/${pid}/items/${iid}`);
      upsertPlaylist(j.playlist);
    } catch (err) { return setStatus(err.message); }
    syncCtx(pid, { removedId: iid });
    renderPlaylists();
    return true;
  }
  // 移出後在提示裡提供「復原」:把歌加回去,再照原本的順序排好
  async function removeWithUndo(pid, its) {
    const p = plById(pid); if (!p || !its.length) return false;
    const beforeOrder = p.items.map((x) => x.id);
    const ok = its.length === 1 ? await removeFromPlaylist(pid, its[0].id) : await removeManyFromPlaylist(pid, its.map((x) => x.id), true);
    if (!ok) return false;
    setStatus(its.length === 1 ? `已從「${p.name}」移出` : `已從「${p.name}」移出 ${its.length} 首`, false, {
      label: '復原', fn: () => restoreItems(pid, its, beforeOrder),
    });
    return true;
  }
  async function restoreItems(pid, its, beforeOrder) {
    const p = plById(pid); if (!p) return setStatus('播放清單已不存在');
    const had = new Set(p.items.map((x) => x.id));
    const strip = ({ id, ...rest }) => rest;
    try { await addToPlaylist(pid, its.map(strip)); } catch (err) { return setStatus('復原失敗:' + err.message); }
    // 加回去的項目會拿到新 id:用歌曲 key 對回原本的 id,再依原順序重排
    const now = plById(pid); if (!now) return;
    const newIdByKey = new Map(now.items.filter((x) => !had.has(x.id)).map((x) => [itemKey(x), x.id]));
    const newIdByOld = new Map(its.map((x) => [x.id, newIdByKey.get(itemKey(x))]));
    const exists = new Set(now.items.map((x) => x.id));
    const order = beforeOrder.map((id) => newIdByOld.get(id) || id).filter((id) => exists.has(id));
    for (const x of now.items) if (!order.includes(x.id)) order.push(x.id); // 期間新加入的(別台裝置)放最後
    await reorderPlaylist(pid, order);
    setStatus('已復原');
  }
  async function removeManyFromPlaylist(pid, ids, quiet = false) {
    let j;
    try { j = await plApi('POST', `${PL_API}/${pid}/items/remove`, { ids }); }
    catch (err) { setStatus(err.message); return false; }
    upsertPlaylist(j.playlist);
    if (playlistCtx && playlistCtx.id === pid) { const gone = new Set(ids); queue = queue.filter((e) => !gone.has(e.src)); }
    syncCtx(pid);
    renderPlaylists();
    if (!quiet) setStatus(`已移出 ${j.removed} 首`);
    return true;
  }
  async function reorderPlaylist(pid, ids) {
    const p = plById(pid); if (!p) return;
    const map = new Map(p.items.map((it) => [it.id, it]));
    const old = p.items;
    p.items = ids.map((i) => map.get(i)).filter(Boolean);
    syncCtx(pid, { reordered: true });
    renderPlaylists();
    try {
      const j = await plApi('PUT', `${PL_API}/${pid}/order`, { order: ids });
      upsertPlaylist(j.playlist);
      syncCtx(pid); renderPlaylists();
    } catch (err) {
      p.items = old; syncCtx(pid);
      setStatus(err.message); loadPlaylists();
    }
  }

  function openPlaylist(id) {
    if (plSel.on) plSel.setMode(false);
    saveScroll();
    plOpen = id; plQuery = ''; $('search').value = '';
    renderPlaylists();
    $('main').scrollTop = 0;
    pushLayer('pl', closePlDetail);
  }
  function closePlDetail() {
    if (plSel.on) plSel.setMode(false);
    plOpen = null; plQuery = ''; $('search').value = '';
    renderPlaylists(); restoreScroll();
    dropLayer('pl');
  }

  // ── 畫面 ──────────────────────────────────────────────
  function renderPlaylists() {
    const detail = plOpen && plById(plOpen);
    $('plListPane').hidden = !!detail;
    $('plDetailPane').hidden = !detail;
    document.body.classList.toggle('pl-detail', mode === 'playlists' && !!detail);
    if (detail) renderPlDetail(detail); else renderPlList();
    updateOfflineInfo();
  }

  function renderPlList() {
    const q = zhFold(plQuery.trim());
    const list = playlists.filter((p) => !q || zhFold(p.name).includes(q));
    $('plCount').textContent = playlists.length ? `${playlists.length} 個` : '';
    $('plEmpty').hidden = list.length > 0;
    $('plEmptyText').textContent = playlists.length ? '沒有符合的播放清單' : '還沒有播放清單';
    $('plEmptyNew').hidden = playlists.length > 0;
    const ul = $('plLists'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    for (const p of list) frag.appendChild(plCard(p));
    ul.appendChild(frag);
  }

  function plItemRow(p, it, canDrag, i) {
    const key = itemKey(it), isLib = it.kind === 'lib';
    const f = isLib ? byFile.get(it.filename) : null;
    const missing = isLib && byFile.size > 0 && !f && !offlineKeys.has(key);
    return makeRow({
      key, iid: it.id, missing, idx: i + 1,
      title: itemTitle(it),
      sub: isLib ? (f ? libSub(f) : (missing ? '檔案已不存在' : '音樂庫')) : onlineSub(it),
      dur: isLib ? libDur(f) : (it.duration && it.duration !== '未知' ? it.duration : ''),
      grip: canDrag && !plSel.on ? (ev, li) => startPlDrag(ev, li, p.id) : false,
      btn: { icon: 'more', title: '更多', dlmenu: key, onClick: (b) => openItemMenu(b, p, it) },
      onClick: (ev) => plSel.on ? plSel.toggle(it.id, ev.shiftKey) : playPlaylist(p.id, it.id),
    });
  }
  // 播放清單內頁目前看得到的項目(套用頂部搜尋)
  function plVisible(p) {
    const q = zhFold(plQuery.trim());
    return q ? p.items.filter((it) => zhFold(itemTitle(it)).includes(q)) : p.items;
  }

  function renderPlDetail(p) {
    $('plTitle').textContent = p.name;
    if (!plQuery && $('plSearch').value) $('plSearch').value = '';
    const ul = $('plItems'); ul.textContent = '';
    $('plItemsEmpty').hidden = p.items.length > 0;
    const frag = document.createDocumentFragment();
    plVisible(p).forEach((it, i) => frag.appendChild(plItemRow(p, it, !plQuery.trim(), i))); // 搜尋篩選時不能拖曳排序
    ul.appendChild(frag);
    if (plSel.on) {
      for (const id of [...plSel.set]) if (!p.items.some((it) => it.id === id)) plSel.set.delete(id); // 已被移除(例如別台裝置)的不再算選取
      plSel.paint(); plSel.update();
    }
    updatePlDetailButtons();
    markPlaying();
  }

  // 拖曳排序(播放清單版,共用 dragSort)
  function startPlDrag(ev, li, pid) {
    const rows = [...$('plItems').querySelectorAll('.row[data-iid]')].filter((r) => r !== li);
    dragSort(ev, li, rows, $('main'), (dropped, pos) => {
      if (!dropped) return renderPlaylists();
      const ids = rows.map((r) => r.dataset.iid);
      ids.splice(Math.min(pos, ids.length), 0, li.dataset.iid);
      reorderPlaylist(pid, ids);
    });
  }

  // ── 「加入播放清單」選單 ──────────────────────────────
  let pickItems = null, pickDone = null;
  function closePick() {
    if (!$('pickPl').classList.contains('show')) return;
    $('pickPl').classList.remove('show');
    dropLayer('pick');
  }
  // onDone:成功加入後呼叫(多選模式用來結束選取)
  function pickPlaylist(items, onDone) {
    if (!items || !items.length) return;
    pickItems = items; pickDone = onDone || null;
    $('pickPl').querySelector('.ttl').textContent = items.length > 1 ? `加入播放清單(${items.length} 首)` : '加入播放清單';
    const ul = $('pickList'); ul.textContent = '';
    if (!playlists.length) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = '還沒有播放清單,先建立一個吧'; ul.appendChild(li);
    }
    for (const p of playlists) {
      ul.appendChild(makeRow({
        title: p.name, sub: `${p.items.length} 首`,
        onClick: async () => {
          const its = pickItems, done = pickDone; closePick();
          try {
            const j = await addToPlaylist(p.id, its);
            const dup = its.length - j.added;
            setStatus(!j.added ? `「${p.name}」已經有${its.length > 1 ? '這些歌' : '這首歌'}了`
              : `已加入「${p.name}」` + (its.length > 1 ? `(${j.added} 首` + (dup > 0 ? `,略過 ${dup} 首重複` : '') + ')' : ''));
            if (done) done();
          } catch (err) { setStatus(err.message); }
        },
      }));
    }
    $('pickPl').classList.add('show');
    pushLayer('pick', closePick);
  }
  $('pickClose').addEventListener('click', closePick);
  $('pickNew').addEventListener('click', async () => {
    const its = pickItems, done = pickDone; closePick();
    const name = await askText('新增播放清單');
    if (!name) return;
    try {
      const p = await createPlaylist(name, its);
      renderPlaylists();
      setStatus(`已建立「${p.name}」並加入 ${p.items.length} 首`);
      if (done) done();
    } catch (err) { setStatus(err.message); }
  });
  $('fAddPl').addEventListener('click', () => {
    const c = currentEntry();
    if (!c) return setStatus('目前沒有播放中的歌曲');
    pickPlaylist([c.kind === 'lib'
      ? { kind: 'lib', filename: c.filename, title: (byFile.get(c.filename) || {}).name }
      : onlineItem(c.item)]);
  });

  // ── 播放清單頁面的按鈕 ────────────────────────────────
  $('plNew').addEventListener('click', async () => {
    const name = await askText('新增播放清單');
    if (!name) return;
    try { const p = await createPlaylist(name); openPlaylist(p.id); } catch (err) { setStatus(err.message); }
  });
  $('plEmptyNew').addEventListener('click', () => $('plNew').click());
  $('plGoLib').addEventListener('click', () => setMode('library'));
  $('plBack').addEventListener('click', closePlDetail);
  $('plPlay').addEventListener('click', () => { if (plOpen) playPlaylist(plOpen); });
  $('plShuffle').addEventListener('click', () => { if (plOpen) playPlaylist(plOpen, null, { shuffleStart: true }); });
  // 播放清單內頁多選:批次移出 / 加入其他清單
  const plSel = makeSelector({
    name: 'plSel', exit: () => setPlSelecting(false),
    list: $('plItems'), bar: $('plSelBar'),
    ids: () => { const p = plOpen && plById(plOpen); return p ? plVisible(p).map((it) => it.id) : []; },
    rowId: (r) => r.dataset.iid || null,
  });
  function setPlSelecting(on) { plSel.setMode(on); $('plSelBot').hidden = !bots.hasTargets(); renderPlaylists(); }
  const plSelItems = () => {
    const p = plOpen && plById(plOpen); if (!p) return [];
    const byId = new Map(p.items.map((it) => [it.id, it]));
    return [...plSel.set].map((id) => byId.get(id)).filter(Boolean);
  };
  $('plSelect').addEventListener('click', () => setPlSelecting(true));
  $('plSelCancel').addEventListener('click', () => setPlSelecting(false));
  $('plSelRemove').addEventListener('click', async () => {
    const p = plOpen && plById(plOpen); const its = plSelItems();
    if (!p || !its.length) return;
    if (await removeWithUndo(p.id, its)) setPlSelecting(false);
  });
  $('plSelAdd').addEventListener('click', () => {
    const its = plSelItems().map((it) => it.kind === 'lib'
      ? { kind: 'lib', filename: it.filename, title: it.title }
      : { kind: 'online', url: it.url, title: it.title, author: it.author, platform: it.platform, duration: it.duration });
    pickPlaylist(its, () => setPlSelecting(false));
  });
  // 播放清單 → 點給 Bot：多選的幾首，或整份（依清單順序；音樂庫已刪除的歌由伺服器略過）
  const plToBotItem = (it) => (it.kind === 'lib'
    ? { kind: 'lib', filename: it.filename, title: it.title }
    : { kind: 'online', url: it.url, title: it.title, author: it.author, platform: it.platform, duration: it.duration });
  $('plSelBot').addEventListener('click', () => {
    const p = plOpen && plById(plOpen); if (!p) return;
    const sel = new Set(plSelItems().map((it) => it.id));
    bots.sendToBot(p.items.filter((it) => sel.has(it.id)).map(plToBotItem), () => setPlSelecting(false));
  });
  $('plToBot').addEventListener('click', () => {
    const p = plOpen && plById(plOpen); if (!p) return;
    if (!p.items.length) return setStatus('這個播放清單是空的');
    bots.sendToBot(p.items.map(plToBotItem));
  });

  $('plRename').addEventListener('click', async () => {
    const p = plOpen && plById(plOpen); if (!p) return;
    const name = await askText('重新命名', p.name);
    if (!name || name === p.name) return;
    try { upsertPlaylist((await plApi('PATCH', `${PL_API}/${p.id}`, { name })).playlist); renderPlaylists(); }
    catch (err) { setStatus(err.message); }
  });
  $('plDelete').addEventListener('click', async () => {
    const p = plOpen && plById(plOpen); if (!p) return;
    if (!await askConfirm(`刪除播放清單「${p.name}」?`, '歌曲本身不會被刪除。', { ok: '刪除', danger: true })) return;
    try { await plApi('DELETE', `${PL_API}/${p.id}`); } catch (err) { return setStatus(err.message); }
    playlists = playlists.filter((x) => x.id !== p.id);
    if (playlistCtx && playlistCtx.id === p.id) playlistCtx = null;
    if (plSel.on) plSel.setMode(false);
    plOpen = null; renderPlaylists(); dropLayer('pl');
    setStatus('已刪除播放清單');
  });
  $('plDownloadAll').addEventListener('click', async () => {
    const p = plOpen && plById(plOpen); if (!p) return;
    if (dlBusy()) { cancelDownloads(); return; }
    const dls = p.items.filter(plDownloadable);
    if (!dls.length) return setStatus('沒有可下載的歌曲');
    // 全部都已下載:再按一次就是移除
    if (dls.every((it) => offlineKeys.has(itemKey(it)))) {
      if (!await askConfirm('移除這個播放清單的離線檔案?', '之後需要網路才能播放這些歌曲。', { ok: '移除', danger: true })) return;
      removeOffline(p.items).then(() => setStatus('已移除離線檔案'));
      return;
    }
    enqueueDownloads(dls);
  });
  $('offlineClear').addEventListener('click', async () => {
    if (!await askConfirm('清除全部離線檔案?', '這個裝置上下載的所有歌曲都會被移除。', { ok: '清除', danger: true })) return;
    try { await offlineClearAll(); offlineKeys.clear(); offlineSizes.clear(); offlineMeta.clear(); setStatus('已清除全部離線檔案'); }
    catch (err) { setStatus('清除失敗:' + err.message); }
    refreshDl();
  });

  // ── 歌曲列的「⋮」選單(下載離線 / 加入播放清單 / 歌曲資訊)──────
  const menuEl = document.createElement('div');
  menuEl.className = 'row-menu'; menuEl.hidden = true;
  document.body.appendChild(menuEl);
  let menuAnchor = null;

  function closeRowMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true; menuAnchor = null;
    dropLayer('menu');
  }

  // 下載中時,⋮ 按鈕顯示百分比;平常顯示三點圖示
  function applyMoreButton(b) {
    const st = dlState.get(b.dataset.dlmenu);
    if (st) {
      b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
      b.style.fontSize = '11px';
    } else {
      b.innerHTML = '<svg><use href="#i-more"/></svg>';
      b.style.fontSize = '';
    }
  }

  function openRowMenu(anchor, f) {
    if (menuAnchor === anchor) return closeRowMenu();
    menuAnchor = anchor;
    const key = 'lib:' + f.filename;
    const item = { kind: 'lib', filename: f.filename, title: f.name };
    const isOff = offlineKeys.has(key);
    menuEl.textContent = '';

    queueMenuItems(item);
    menuItem(isOff ? 'close' : 'download',
      isOff ? '移除離線檔案' : (dlState.has(key) ? '下載中…' : '下載離線'),
      () => toggleOffline(item));
    menuItem('playlist-add', '加入播放清單', () => pickPlaylist([item]));
    if (!isOffline()) {
      if (!folderOf(f)) menuItem('downloaded', '收藏(移到資料夾)', () => moveLibFile(f, 'folder'));
      else menuItem('lib', '移到其他資料夾', () => moveLibFile(f, 'folder'));
      menuItem('edit', '重新命名', () => moveLibFile(f, 'rename'));
      menuItem('delete', '從音樂庫刪除', () => deleteLibFile(f), 'danger');
    }
    menuInfo([
      ['資料夾:', folderOf(f) || '(音樂庫根目錄)'],
      ...(f.duration ? [['長度:', fmt(f.duration)]] : []),
      ['檔案大小:', fmtSize(f.size)],
      ['離線狀態:', isOff ? '已下載到此裝置' : (dlState.has(key) ? '下載中' : '未下載')],
      ...(!folderOf(f) ? [['提醒:', '根目錄的歌是快取,空間不夠時會被自動清掉;收藏到資料夾就會保留']] : []),
    ]);
    placeMenu(anchor);
  }

  // ── 音樂庫管理:收藏到資料夾 / 重新命名 / 刪除(伺服器 /web/api/library/*)──────
  async function libApi(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error('連線失敗'); }
    if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('請先登入'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // 檔名改了:佇列、播放歷史、目前播放、播放中的清單、離線檔都跟著換成新路徑(伺服器端的播放清單已由 API 改好)
  async function renameLocalRefs(from, to) {
    const fix = (e) => { if (e && e.kind === 'lib' && e.filename === from) e.filename = to; };
    queue.forEach(fix); history.forEach(fix);
    if (playlistCtx) playlistCtx.items.forEach(fix);
    if (currentFile === from) currentFile = to;
    if (preload && preload.key === 'lib:' + from) dropPreload();
    const oldKey = 'lib:' + from, newKey = 'lib:' + to;
    if (!offlineKeys.has(oldKey)) return;
    try {
      const blob = await offlineGet(oldKey);
      if (!blob) return;
      const meta = offlineMeta.get(oldKey) || {};
      await offlinePut({ key: newKey, blob, size: blob.size, ...meta });
      await offlineDel(oldKey);
      offlineKeys.delete(oldKey); offlineKeys.add(newKey);
      offlineSizes.set(newKey, offlineSizes.get(oldKey) || blob.size); offlineSizes.delete(oldKey);
      offlineMeta.set(newKey, meta); offlineMeta.delete(oldKey);
    } catch (err) { dbg('離線檔改名失敗', err); }
  }

  // how:'folder' 移到資料夾(保留檔名)／'rename' 改檔名(保留資料夾)
  async function moveLibFile(f, how) {
    const parts = f.filename.split('/');
    const file = parts.pop();
    const ext = (file.match(/\.[^.]+$/) || [''])[0];
    const stem = file.slice(0, file.length - ext.length);
    const dir = parts.join('/');
    let to;
    if (how === 'folder') {
      const folders = [...new Set(all.map(folderOf).filter(Boolean))];
      const hint = folders.length ? '(現有:' + folders.slice(0, 5).join('、') + (folders.length > 5 ? '…' : '') + ')' : '';
      const d = await askText('移到哪個資料夾?' + hint, dir || 'favorites');
      if (d === null) return;
      const clean = d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!clean) return setStatus('請輸入資料夾名稱(根目錄的歌會被快取清理)');
      to = clean + '/' + stem;
    } else {
      const n = await askText('新的檔名', stem);
      if (n === null || n === stem) return;
      to = (dir ? dir + '/' : '') + n;
    }
    try {
      const j = await libApi('POST', '/web/api/library/move', { from: f.filename, to });
      await renameLocalRefs(j.from, j.to);
      setStatus(how === 'folder' ? '已收藏到「' + j.to.split('/').slice(0, -1).join('/') + '」' : '已重新命名');
      loadList();
    } catch (err) { setStatus('移動失敗:' + err.message); }
  }

  async function deleteLibFile(f) {
    if (!await askConfirm('從音樂庫刪除這首歌?', f.name + '\n伺服器上的檔案會被刪除,所有裝置與 Bot 都無法再播放,無法復原。', { ok: '刪除', danger: true })) return;
    try {
      await libApi('DELETE', streamUrl(f.filename).replace('/web/stream/', '/web/api/library/file/'));
      setStatus('已刪除');
      loadList();
    } catch (err) { setStatus('刪除失敗:' + err.message); }
  }

  document.addEventListener('pointerdown', (e) => {
    if (menuEl.hidden) return;
    if (menuEl.contains(e.target) || (menuAnchor && menuAnchor.contains(e.target))) return; // 按鈕自己的 click 負責開關
    closeRowMenu();
  }, true);
  window.addEventListener('scroll', () => { if (!menuEl.hidden) closeRowMenu(); }, true);
  window.addEventListener('resize', closeRowMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });
  $('search').addEventListener('input', closeRowMenu);

  // ── 選單 helper(音樂庫與播放清單的 ⋯ 選單共用)與播放清單內頁:頂部搜尋、⋯ 下拉選單、每首歌的 ⋯ 選單 ──────
  function menuItem(icon, text, fn, cls) {
    const b = document.createElement('button');
    b.className = 'menu-item' + (cls ? ' ' + cls : '');
    b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    const s = document.createElement('span'); s.textContent = text; b.appendChild(s);
    b.addEventListener('click', (ev) => { ev.stopPropagation(); closeRowMenu(); fn(); });
    menuEl.appendChild(b);
  }
  function menuInfo(lines) {
    const sep = document.createElement('div'); sep.className = 'menu-sep'; menuEl.appendChild(sep);
    const info = document.createElement('div'); info.className = 'menu-info';
    for (const [label, value] of lines) {
      const d = document.createElement('div');
      const b = document.createElement('b'); b.textContent = label;
      d.append(b, document.createTextNode(value));
      info.appendChild(d);
    }
    menuEl.appendChild(info);
  }
  function placeMenu(anchor) {
    if (menuEl.hidden) pushLayer('menu', closeRowMenu);
    menuEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    const left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  // 播放清單內每首歌的 ⋯ 選單:下載離線 / 移出播放清單 / 歌曲資訊
  function openItemMenu(anchor, p, it) {
    if (menuAnchor === anchor) return closeRowMenu();
    menuAnchor = anchor;
    const key = itemKey(it), isOff = offlineKeys.has(key);
    menuEl.textContent = '';
    queueMenuItems(it);
    menuItem(isOff ? 'close' : 'download',
      isOff ? '移除離線檔案' : (dlState.has(key) ? '下載中…' : '下載離線'),
      () => toggleOffline(it));
    menuItem('close', '移出播放清單', () => removeWithUndo(p.id, [it]), 'danger');
    const lines = [];
    if (it.kind === 'lib') {
      const f = byFile.get(it.filename);
      lines.push(['資料夾:', it.filename.includes('/') ? it.filename.split('/')[0] : '(音樂庫根目錄)']);
      if (libDur(f)) lines.push(['長度:', libDur(f)]);
      if (f) lines.push(['檔案大小:', fmtSize(f.size)]);
    } else {
      lines.push(['來源:', it.platform || '線上']);
      if (it.author) lines.push(['作者:', it.author]);
      if (it.duration && it.duration !== '未知') lines.push(['長度:', it.duration]);
    }
    lines.push(['離線狀態:', isOff ? '已下載到此裝置' : (dlState.has(key) ? '下載中' : '未下載')]);
    menuInfo(lines);
    placeMenu(anchor);
  }

  // 頁面上方 ⋯ 下拉選單(重新命名 / 移除離線 / 刪除)
  function setPlMenu(show) {
    if (show === $('plMenu').classList.contains('show')) return;
    $('plMenu').classList.toggle('show', show);
    if (show) pushLayer('plMenu', () => setPlMenu(false)); else dropLayer('plMenu');
  }
  $('plMoreBtn').addEventListener('click', (e) => { e.stopPropagation(); setPlMenu(!$('plMenu').classList.contains('show')); });
  document.addEventListener('click', () => setPlMenu(false));
  $('plSearch').addEventListener('input', () => { plQuery = $('plSearch').value; renderPlaylists(); });

  // ── 播放清單總覽:卡片(電腦版為封面網格,手機版為列表)+ 下載按鈕判斷 ──────
  const plDownloadable = (it) => it.kind === 'online' || byFile.has(it.filename);

  function plCard(p) {
    const nOff = p.items.filter((it) => offlineKeys.has(itemKey(it))).length;
    const li = document.createElement('li');
    li.className = 'pl-card';
    const mkPlay = (cls) => {
      const b = document.createElement('button');
      b.className = cls; b.title = '播放'; b.setAttribute('aria-label', '播放 ' + p.name);
      b.innerHTML = '<svg><use href="#i-play"/></svg>';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); playPlaylist(p.id); });
      return b;
    };
    const art = document.createElement('div'); art.className = 'pl-card-art';
    const cv = document.createElement('div'); cv.className = 'cover';
    art.append(cv, mkPlay('pl-card-play'));
    const info = document.createElement('div'); info.className = 'pl-card-info';
    const t = document.createElement('div'); t.className = 't'; t.textContent = p.name; t.title = p.name;
    const a = document.createElement('div'); a.className = 'a';
    a.textContent = `${p.items.length} 首歌曲` + (nOff ? ` · 已下載 ${nOff} 首` : '');
    info.append(t, a);
    li.append(art, info, mkPlay('pl-card-pm'));
    li.addEventListener('click', () => openPlaylist(p.id));
    return li;
  }

  if (DEBUG_UI) setupDebugPanel({ $, setStatus, IS_ANDROID, ANDROID_BY, KEEP });
  // 切到背景時預載下一首(只在 Android 生效,見 preloadNext)
  document.addEventListener('visibilitychange', () => { if (document.hidden) preloadNext(); });

  // ── 初始化 ──
  syncButtons();
  setNow(null);
  updateProgress();
  updatePlayIcons();
  // 清單請求與離線清單掃描同時進行;等離線清單讀完才畫畫面,才能正確標示已下載的歌
  const listReq = fetch('/web/api/list');
  listReq.catch(() => {}); // 失敗交給 loadList 處理,這裡只避免「未處理的 Promise 錯誤」
  window.MLGestures.setupGestures({ $, libSel, plSel, setLibSelecting, setPlSelecting, isFullOpen, openFull, closeFull, advance, prev });

  offlineInit().finally(() => { updateNetState(); loadList(listReq); });
  // 「點給 Bot 播放」選單項目只在有 Bot 在語音頻道時出現:頁面開著時每分鐘更新一次(Bot 頁籤開著時由 SSE 即時更新)
  setInterval(() => { if (!document.hidden && mode !== 'bots' && $('logoutBtn').hidden === false) bots.refresh(); }, 60 * 1000);
  registerSW();
})();