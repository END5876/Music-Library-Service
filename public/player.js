'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const audio = $('audio');
  const REPEATS = ['all', 'one', 'off'];
  const REPEAT_LABEL = { all: '循環:全部', one: '循環:單曲', off: '不循環' };

  // 除錯:在 DevTools 執行 localStorage.ml_debug='1' 後重新整理即可開啟
  let DEBUG = false;
  try { DEBUG = localStorage.getItem('ml_debug') === '1'; } catch {}
  const t0 = Date.now();
  const dbg = (...a) => { if (DEBUG) console.log('[player +' + ((Date.now() - t0) / 1000).toFixed(1) + 's]', ...a); };

  // 預載下一首(預設關閉;只抓開頭小段 / 預熱線上 info,效果不保證,請自行實測)
  const PREFETCH = false;

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
  let playToken = 0;
  let shuffle = false;
  let repeat = 'all';
  let history = [];
  let errorStreak = 0;
  let pendingPlay = false; // 程式已要求播放、但還沒真的開始(載入中)
  let endHandled = false;  // 這次 ended 是否已處理過
  let mode = 'library';
  let folder = '';
  let libQuery = '', onlineQuery = '';
  // 佇列:統一存放「接下來要播的」項目,可拖曳排序
  // 項目:{ id, kind:'lib', filename } 或 { id, kind:'online', item }
  let queue = [];
  let qid = 0;
  const mkLib = (filename) => ({ id: ++qid, kind: 'lib', filename });
  const mkOnline = (item) => ({ id: ++qid, kind: 'online', item });

  try {
    const s = JSON.parse(localStorage.getItem('ml_prefs') || '{}');
    if (typeof s.volume === 'number') audio.volume = Math.min(1, Math.max(0, s.volume));
    shuffle = !!s.shuffle;
    if (REPEATS.includes(s.repeat)) repeat = s.repeat;
  } catch {}
  function savePrefs() {
    try { localStorage.setItem('ml_prefs', JSON.stringify({ volume: audio.volume, shuffle, repeat })); } catch {}
  }

  const enc = encodeURIComponent;
  const streamUrl = (f) => '/web/stream/' + f.split('/').map(enc).join('/');
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
  const setIcon = (btn, name) => btn.querySelector('use').setAttribute('href', '#i-' + name);

  let toastTimer = null;
  function setStatus(text, sticky = false) {
    const el = $('toast');
    clearTimeout(toastTimer);
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text;
    el.classList.add('show');
    if (!sticky) toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  // ── 背景播放穩定性 helper ──
  function setSession(state) {
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = state; } catch {} }
  }
  // 載入空檔也維持「播放中」;失敗最多重試 retries 次,之後放棄(避免 recover 無限重試)
  function tryPlay(retries = 3) {
    pendingPlay = true;
    setSession('playing');
    const p = audio.play();
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
      if (r.ok) { $('pw').value = ''; $('login').classList.remove('show'); loadList(); return; }
      const j = await r.json().catch(() => ({}));
      $('loginErr').textContent = j.error || '登入失敗';
    } catch { $('loginErr').textContent = '連線失敗'; }
  });
  $('logoutBtn').addEventListener('click', async () => {
    pendingPlay = false;
    audio.pause();
    setSession('none');
    await fetch('/web/logout', { method: 'POST' }).catch(() => {});
    all = []; view = []; queue = []; history = [];
    currentFile = null; onlineCurrent = null; playToken++;
    audio.removeAttribute('src'); audio.load();
    setNow(null); render();
    $('logoutBtn').hidden = true;
    showLogin();
  });

  // ── 列表元件 ──
  // opts:key / title / sub / dur / btn / grip / qid / onClick
  function makeRow({ key, title, sub, dur, btn, grip, qid: rowQid, onClick }) {
    const li = document.createElement('li');
    li.className = 'row';
    if (key) li.dataset.key = key;
    if (rowQid != null) li.dataset.qid = rowQid;
    const cv = document.createElement('div'); cv.className = 'cover';
    const info = document.createElement('div'); info.className = 'info';
    const t = document.createElement('div'); t.className = 't'; t.textContent = title; t.title = title;
    const a = document.createElement('div'); a.className = 'a'; a.textContent = sub;
    info.append(t, a);
    li.append(cv, info);
    if (dur) { const d = document.createElement('span'); d.className = 'dur'; d.textContent = dur; li.appendChild(d); }
    if (grip) {
      const g = document.createElement('button');
      g.className = 'grip'; g.title = '拖曳排序'; g.setAttribute('aria-label', '拖曳排序');
      g.innerHTML = '<svg><use href="#i-grip"/></svg>';
      g.addEventListener('click', (ev) => ev.stopPropagation());
      g.addEventListener('pointerdown', (ev) => startDrag(ev, li));
      li.appendChild(g);
    }
    if (btn) {
      const b = document.createElement('button');
      b.className = 'rbtn'; b.title = btn.title; b.setAttribute('aria-label', btn.title);
      b.innerHTML = `<svg><use href="#i-${btn.icon}"/></svg>`;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); btn.onClick(); });
      li.appendChild(b);
    }
    if (onClick) li.addEventListener('click', onClick);
    return li;
  }

  const folderOf = (f) => f.filename.includes('/') ? f.filename.split('/')[0] : '';
  const libSub = (f) => folderOf(f) ? '📁 ' + folderOf(f) : '音樂庫';
  const onlineSub = (r) => [r.platform, r.author].filter(Boolean).join(' · ') || '線上歌曲';

  // 使用者主動點選一首歌:重置歷史;若隨機開啟,立刻重新排出不重複的隨機佇列
  function start(filename) {
    history = [];
    play(filename);
    if (shuffle) buildShuffle();
  }
  const libRow = (f) => makeRow({
    key: 'lib:' + f.filename, title: f.name, sub: libSub(f), dur: fmtSize(f.size),
    onClick: () => start(f.filename),
  });

  function nowKey() {
    if (currentFile) return 'lib:' + currentFile;
    if (onlineCurrent) return 'on:' + (onlineCurrent.srcUrl || onlineCurrent.url);
    return null;
  }
  function markPlaying() {
    const k = nowKey();
    let firstMatch = null;
    document.querySelectorAll('.row[data-key]').forEach((r) => {
      const on = r.dataset.key === k;
      r.classList.toggle('playing', on);
      if (on && !firstMatch && r.closest('#list')) firstMatch = r;
    });
    if (firstMatch && !$('viewLibrary').hidden) firstMatch.scrollIntoView({ block: 'nearest' });
  }

  // ── 音樂庫清單 ──
  async function loadList() {
    setStatus('載入清單中…', true);
    let r;
    try { r = await fetch('/web/api/list'); } catch { return setStatus('連線失敗'); }
    if (r.status === 401) { setStatus(''); return showLogin(); }
    if (!r.ok) return setStatus('讀取清單失敗');
    all = (await r.json()).files || [];
    $('logoutBtn').hidden = false;
    setStatus('');
    renderChips();
    applyFilter();
    loadCapabilities();
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
    const q = libQuery.trim().toLowerCase();
    view = all.filter(f =>
      (!folder || f.filename.startsWith(folder + '/')) &&
      (!q || f.name.toLowerCase().includes(q) || f.filename.toLowerCase().includes(q)));
    render();
  }

  function render() {
    $('libCount').textContent = all.length ? `${view.length} / ${all.length} 首` : '\u00a0';
    const ul = $('list'); ul.textContent = '';
    $('empty').hidden = view.length > 0 || !all.length;
    const frag = document.createDocumentFragment();
    for (const f of view) frag.appendChild(libRow(f));
    ul.appendChild(frag);
    markPlaying();
    renderNext();
  }

  // ── 目前播放資訊 ──
  function setNow(n) {
    const t = n ? n.title : '尚未播放';
    const a = n ? n.sub : '從音樂庫或線上搜尋選一首歌';
    ['barTitle', 'miniTitle', 'fTitle'].forEach(id => { $(id).textContent = t; });
    ['barArtist', 'miniArtist', 'fArtist'].forEach(id => { $(id).textContent = a; });
    document.title = n ? `${n.title} · 音樂庫` : '音樂庫播放器';
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = n ? new MediaMetadata({ title: n.title, artist: n.sub.replace(/^📁 /, '') }) : null;
      } catch {}
    }
    markPlaying();
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
  // 立刻把目前清單排成一份不重複的隨機順序(排除正在播放的那首);手動加入的線上歌曲保留在最前面
  function buildShuffle() {
    const online = queue.filter(e => e.kind === 'online');
    const files = view.map(f => f.filename).filter(f => f !== currentFile);
    queue = online.concat(shuffled(files).map(mkLib));
    renderNext();
  }

  // ── 佇列畫面(全螢幕播放頁)──
  function queueRow(e) {
    const drag = { grip: true, qid: e.id };
    const remove = { icon: 'close', title: '移出佇列', onClick: () => { queue = queue.filter(x => x.id !== e.id); renderNext(); } };
    if (e.kind === 'lib') {
      const f = all.find(x => x.filename === e.filename);
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

  function renderNext() {
    const ul = $('nextList'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    let count = 0;
    for (const e of queue) { const li = queueRow(e); if (li) { frag.appendChild(li); count++; } }
    if (!shuffle && !onlineCurrent && currentFile) {
      const i = view.findIndex(f => f.filename === currentFile);
      if (i >= 0) for (const f of view.slice(i + 1, i + 31)) { frag.appendChild(libRow(f)); count++; }
    }
    if (!count) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = shuffle ? '佇列是空的,點「重新洗牌」重新排一份' : '沒有下一首了';
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    $('queueTitle').textContent = queue.length ? `佇列 · ${queue.length} 首` : '佇列';
    $('reshuffle').hidden = !shuffle;
    markPlaying();
  }
  $('reshuffle').addEventListener('click', () => { buildShuffle(); setStatus('🔀 已重新洗牌'); });

  // ── 拖曳排序(Pointer Events,滑鼠與觸控通用)──
  function startDrag(ev, li) {
    if (ev.button > 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const ul = $('nextList');
    const sc = ul.closest('.queue');
    const rows = [...ul.querySelectorAll('.row[data-qid]')].filter(r => r !== li);
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
        const id = Number(li.dataset.qid);
        const from = queue.findIndex(x => x.id === id);
        if (from >= 0) { const [item] = queue.splice(from, 1); queue.splice(Math.min(pos, queue.length), 0, item); }
      }
      renderNext();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    tick();
  }

  // ── 播放 ──
  function play(filename, { pushHistory = true } = {}) {
    const track = all.find(f => f.filename === filename); if (!track) return false;
    if (pushHistory && currentFile && currentFile !== filename) history.push(currentFile);
    dbg('play', filename);
    playToken++;
    onlineCurrent = null;
    currentFile = filename;
    endHandled = false;
    audio.src = streamUrl(filename);
    tryPlay();
    setStatus('');
    setNow({ title: track.name, sub: libSub(track) });
    return true;
  }

  function playEntry(e) {
    if (e.kind === 'online') return playOnline(e.item);
    if (!play(e.filename)) advance(); // 檔案已不存在就跳過
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
    if (queue.length) { playEntry(queue.shift()); return; }
    if (onlineCurrent) { onlineCurrent = null; markPlaying(); renderNext(); setStatus('✅ 佇列播放完畢'); return; }
    if (shuffle) {
      if (!view.length) return;
      if (repeat === 'off' && currentFile) { setStatus('✅ 隨機清單播放完畢'); return; }
      buildShuffle(); // 一輪播完:重新排出下一輪不重複的順序
      if (queue.length) playEntry(queue.shift());
      else if (currentFile) { audio.currentTime = 0; tryPlay(); }
      return;
    }
    const n = pickNext();
    if (n) play(n);
  }

  function prev() {
    if (onlineCurrent) { playOnline(onlineCurrent); return; }
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (history.length) {
      if (shuffle && currentFile) queue.unshift(mkLib(currentFile)); // 按「下一首」還能回來
      play(history.pop(), { pushHistory: false });
      renderNext();
      return;
    }
    if (shuffle) return;
    const i = view.findIndex(f => f.filename === currentFile);
    if (i > 0) play(view[i - 1].filename, { pushHistory: false });
    else if (view.length && repeat === 'all') play(view[view.length - 1].filename, { pushHistory: false });
  }

  function toggle() {
    if (!currentFile && !onlineCurrent) {
      if (!view.length) return;
      start(shuffle ? view[Math.floor(Math.random() * view.length)].filename : view[0].filename);
      return;
    }
    if (audio.paused) tryPlay(); else { pendingPlay = false; audio.pause(); }
  }

  // ── audio 事件 ──
  let dragging = false;
  const seekable = () => isFinite(audio.duration) && audio.duration > 0;

  function updateProgress() {
    const can = seekable();
    const cur = audio.currentTime || 0;
    const p = can ? Math.min(100, cur / audio.duration * 100) : 0;
    for (const r of [$('seek'), $('fSeek')]) {
      r.disabled = !can;
      if (!dragging) r.value = p * 10;
      r.style.setProperty('--p', p + '%');
    }
    const durText = can ? fmt(audio.duration) : ((currentFile || onlineCurrent) ? '串流中' : '0:00');
    $('timeText').textContent = `${fmt(cur)} / ${durText}`;
    $('fCur').textContent = fmt(cur);
    $('fDur').textContent = durText;
    $('miniProg').style.width = p + '%';
  }
  function updatePlayIcons() {
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
    dbg('ended');
    errorStreak = 0;
    if (repeat === 'one') {
      if (onlineCurrent) playOnline(onlineCurrent);
      else { audio.currentTime = 0; tryPlay(); }
    } else advance();
  }
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('emptied', () => { endHandled = false; });
  audio.addEventListener('pause', () => {
    // 真正發生 pause(使用者、來電、系統中斷):不要讓 recover() 自動恢復
    // 播放自然結束時也會先觸發 pause,那種情況不算
    if (audio.ended) return;
    pendingPlay = false;
    setSession('paused');
    dbg('pause');
  });
  audio.addEventListener('playing', () => {
    errorStreak = 0; pendingPlay = false; endHandled = false;
    setSession('playing'); setStatus('');
    dbg('playing');
    prefetchNext();
  });
  audio.addEventListener('volumechange', () => {
    $('vol').value = Math.round(audio.volume * 100);
    $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');
    savePrefs();
  });
  audio.addEventListener('error', () => {
    pendingPlay = false;
    dbg('error', audio.error && audio.error.code);
    if (onlineCurrent) {
      setStatus('線上串流失敗(可能被平台限制、影片不可用或伺服器忙碌)');
      if (queue.length) later(advance);
      return;
    }
    if (!currentFile) return;
    errorStreak += 1;
    if (audio.error && audio.error.code === 4 && errorStreak === 1) {
      fetch('/web/api/list').then(r => { if (r.status === 401) showLogin('登入已過期,請重新登入'); });
    }
    setStatus('這首無法播放,已略過');
    if (errorStreak < Math.min(view.length, 5)) later(advance);
    else setStatus('連續多首無法播放,已停止');
  });

  // ── 補救機制(頁面醒來 / 事件漏掉)──
  function recover() {
    if (!currentFile && !onlineCurrent) return;
    if (audio.ended && !endHandled) { dbg('recover: 補呼叫 ended'); onEnded(); return; }
    if (pendingPlay && audio.paused) { dbg('recover: 補打 play'); tryPlay(1); }
  }
  // interval 在背景會被節流,只在前景有用;真正的補救靠下面三個「醒來」事件
  setInterval(recover, 3000);
  document.addEventListener('visibilitychange', () => { dbg('visibility', document.visibilityState); recover(); });
  window.addEventListener('pageshow', recover);
  window.addEventListener('online', recover);

  // ── 預載下一首(PREFETCH 開啟時才啟用;不下載整首)──
  let prefetched = '';
  function prefetchNext() {
    if (!PREFETCH) return;
    if (!currentFile && !onlineCurrent) return;
    const e = queue[0];
    if (e && e.kind === 'online') {
      const u = e.item.srcUrl || e.item.url;
      if (u !== prefetched) { prefetched = u; fetch('/web/api/info?url=' + enc(u)).catch(() => {}); }
      return;
    }
    const next = e ? e.filename : (shuffle || onlineCurrent ? null : pickNext());
    if (!next || next === prefetched || next === currentFile) return;
    prefetched = next;
    // 只抓開頭 256KB,是否命中 audio 的快取不保證
    fetch(streamUrl(next), { headers: { Range: 'bytes=0-262143' } }).then(r => r.arrayBuffer()).catch(() => {});
  }

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
    if (shuffle) buildShuffle();                       // 點下去的當下就排好
    else queue = queue.filter(e => e.kind === 'online'); // 關閉:回到依清單順序,保留手動加入的線上歌曲
    syncButtons(); savePrefs();
    setStatus(shuffle ? '🔀 隨機播放:開(已排好佇列,可在「佇列」拖曳調整)' : '隨機播放:關');
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
    history = [];
    play(view[Math.floor(Math.random() * view.length)].filename);
    buildShuffle();
    syncButtons(); savePrefs();
    setStatus('🔀 已排出隨機佇列');
  });

  if ('mediaSession' in navigator) {
    const setHandler = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
    setHandler('previoustrack', prev);
    setHandler('nexttrack', advance);
    setHandler('play', () => tryPlay());
    setHandler('pause', () => { pendingPlay = false; audio.pause(); setSession('paused'); });
  }

  // 全螢幕播放頁
  const openFull = () => $('full').classList.add('open');
  const closeFull = () => $('full').classList.remove('open');
  $('nowOpen').addEventListener('click', openFull);
  $('expand').addEventListener('click', openFull);
  $('miniOpen').addEventListener('click', openFull);
  $('close').addEventListener('click', closeFull);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('full').dataset.tab = t.dataset.tab;
  }));

  document.addEventListener('keydown', (e) => {
    if ((e.target.matches && e.target.matches('input:not([type=range]), select, textarea')) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'n' || e.key === 'N') advance();
    else if (e.key === 'p' || e.key === 'P') prev();
    else if (e.key === 's' || e.key === 'S') toggleShuffle();
    else if (e.key === 'r' || e.key === 'R') cycleRepeat();
    else if (e.key === 'Escape') closeFull();
    else if (e.key === 'ArrowRight' && seekable()) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
    else if (e.key === 'ArrowLeft' && seekable()) audio.currentTime = Math.max(0, audio.currentTime - 10);
  });

  // ── 頁籤切換 ──
  function setMode(m) {
    if (m === 'online' && !onlineAvailable) m = 'library';
    mode = m;
    $('viewLibrary').hidden = m !== 'library';
    $('viewOnline').hidden = m !== 'online';
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === m));
    const s = $('search');
    if (m === 'online') { s.placeholder = '搜尋 YouTube / Bilibili,或貼上影片網址,按 Enter'; s.value = onlineQuery; }
    else { s.placeholder = '搜尋歌名…'; s.value = libQuery; markPlaying(); }
    $('main').scrollTop = 0;
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.view)));

  $('search').addEventListener('input', () => {
    if (mode === 'library') { libQuery = $('search').value; applyFilter(); }
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

  // 加入佇列:排在其他手動加入的線上歌曲之後、隨機歌曲之前
  function addToQueue(r) {
    const i = queue.findIndex(e => e.kind === 'lib');
    queue.splice(i < 0 ? queue.length : i, 0, mkOnline(r));
    renderNext();
    setStatus('已加入佇列:' + r.title);
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
          onClick: () => { history = []; playOnline(r); },
          btn: { icon: 'plus', title: '加入佇列', onClick: () => addToQueue(r) },
        }));
      }
      box.appendChild(frag);
      markPlaying();
    } catch (err) {
      $('onlineHint').textContent = '搜尋失敗:' + err.message;
    }
  });

  // 播放線上歌曲(交給伺服器的 /web/play 處理)
  function playOnline(item) {
    dbg('playOnline', item.title);
    playToken++;
    if (currentFile) history.push(currentFile);
    currentFile = null;
    onlineCurrent = item;
    endHandled = false;
    audio.src = '/web/play?url=' + enc(item.srcUrl || item.url);
    tryPlay();
    setStatus('線上串流準備中…', true);
    setNow({ title: item.title, sub: onlineSub(item) });
  }

  // ── 初始化 ──
  syncButtons();
  setNow(null);
  updateProgress();
  updatePlayIcons();
  loadList();
})();