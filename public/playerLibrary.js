'use strict';
// playerLibrary.js — 播放器：封面、列表元件、多選、音樂庫清單。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, fmt, setStatus, pushLayer, dropLayer, askConfirm } = window.MLUi;
  const { dbg } = window.MLDebug;

  // 給其他檔案用的函式
  Object.assign(P, {
    paintCover, paintPlCover, makeRow, kbRow, rowKey, start, makeSelector, setLibSelecting, nowKey, markPlaying,
    loadList, renderChips, applyFilter, render,
  });

  // ── 封面 ──
  // 歌曲沒有真正的封面圖：全部用同一個灰底＋圖示（歌曲=音符、播放清單=清單），不依歌名配色。
  // 全螢幕頁背景固定一個顏色；通知欄／鎖定畫面用 App 圖示。
  const IDLE_HUE = 250;
  function paintCover(el) {
    el.classList.remove('quad', 'pl'); el.textContent = '';
    delete el.dataset.ch;
  }
  function paintPlCover(el) { paintCover(el); el.classList.add('pl'); }
  const coverArtwork = () => [{ src: '/player-assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const fullTint = () => `hsl(${IDLE_HUE} 42% 26%)`;

  // ── 列表元件 ──
  // opts:key / title / sub / dur / idx / btn / grip / qid / onClick
  function makeRow({ key, title, sub, dur, idx, btn, grip, qid: rowQid, pv, iid, missing, onClick }) {
    const li = document.createElement('li');
    li.className = 'row';
    if (key) li.dataset.key = key;
    if (rowQid != null) li.dataset.qid = rowQid;
    if (pv) li.dataset.pv = pv; // 尚未進入佇列的「接下來」預覽列:拖曳時才轉成佇列項目
    if (iid) li.dataset.iid = iid;
    if (key && P.offlineKeys.has(key)) li.classList.add('offline');
    if (missing) li.classList.add('missing');
    if (key && key.startsWith('lib:.private/')) li.classList.add('private'); // 私人歌曲:副標題前加鎖頭圖示
    const cv = document.createElement('div'); cv.className = 'cover';
    paintCover(cv, title);
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
      g.addEventListener('pointerdown', (ev) => {
        const run = () => (typeof grip === 'function' ? grip : P.startDrag)(ev, li);
        if (ev.pointerType === 'mouse') return run();
        P.holdToDrag(ev, li, run); // 觸控:要按住一下才開始拖曳,捲動時手指剛好碰到把手不會誤觸
      });
      li.prepend(g); // 放在最左邊(電腦版另外疊在序號上,見 player.css)
    }
    for (const bt of (Array.isArray(btn) ? btn : btn ? [btn] : [])) {
      const b = document.createElement('button');
      b.className = 'rbtn'; b.title = bt.title; b.setAttribute('aria-label', bt.title);
      b.innerHTML = `<svg><use href="#i-${bt.icon}"/></svg>`;
      if (bt.dlkey) { b.dataset.dlkey = bt.dlkey; P.applyDlButton(b); }
      if (bt.dlmenu) { b.dataset.dlmenu = bt.dlmenu; P.applyMoreButton(b); }
      b.addEventListener('click', (ev) => { ev.stopPropagation(); bt.onClick(b); });
      li.appendChild(b);
    }
    if (onClick) {
      li.addEventListener('click', onClick);
      kbRow(li);
    }
    return li;
  }

  // ── 鍵盤操作清單:整列可以聚焦,Enter／空白鍵＝點一下(播放或打開),↑↓／Home／End 在列之間移動 ──
  // 同一個清單只有一列在 Tab 順序裡(roving tabindex),不然幾百首歌要按幾百次 Tab 才離得開清單
  function kbRow(el) { el.dataset.kb = '1'; el.tabIndex = -1; }
  const kbItems = (list) => [...list.children].filter((c) => c.dataset && c.dataset.kb);
  function fixRoving(list) {
    const items = kbItems(list);
    if (items.length && !items.some((c) => c.tabIndex === 0)) items[0].tabIndex = 0;
  }
  // 清單重畫(加入新列)後補回「可 Tab 進來的那一列」
  new MutationObserver((muts) => {
    const lists = new Set();
    for (const m of muts) if (m.addedNodes.length && m.target.nodeType === 1 && m.target.matches('ul, ol')) lists.add(m.target);
    lists.forEach(fixRoving);
  }).observe(document.body, { childList: true, subtree: true });
  // 回傳 true 表示這個按鍵已經處理(全域快捷鍵不要再處理)
  function rowKey(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.kb) return false;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); return true; }
    const moves = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(e.key in moves)) return false;
    e.preventDefault();
    const items = kbItems(el.parentElement);
    const i = items.indexOf(el), d = moves[e.key];
    const next = items[d === -Infinity ? 0 : d === Infinity ? items.length - 1 : Math.max(0, Math.min(items.length - 1, i + d))];
    if (next && next !== el) { el.tabIndex = -1; next.tabIndex = 0; next.focus(); }
    return true;
  }

  // ── Bot 正在播放(頁籤畫面與遠端控制在 playerBots.js)──
  const bots = window.MLBots.createBots({
    $, setStatus, askConfirm, pushLayer, dropLayer, fmt, makeRow, paintCover, showLogin: P.showLogin,
    libInfo: (fn) => { const f = P.byFile.get(fn); return f ? { name: f.name, duration: f.duration || 0 } : null; },
  });
  // ── 上傳音樂(管理員;面板在 playerUpload.js)──上傳完成後重新載入音樂庫清單
  // 頁籤上的數字徽章＝還在上傳／排隊／處理的首數
  const uploader = window.MLUpload.create({
    onUploaded: (n) => { setStatus(`${n} 首已加進音樂庫`); loadList(null, { quiet: true }); },
    // 徽章:有還沒看過的失敗時顯示「!」(打開上傳頁才清掉),否則顯示還在進行的首數
    onPending: (n, failed) => document.querySelectorAll('[data-view="upload"], #libUploadBtn').forEach((b) => {
      let badge = b.querySelector('.nav-badge');
      if (!n && !failed) { if (badge) badge.remove(); return; }
      if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge'; b.appendChild(badge); }
      badge.classList.toggle('warn', !!failed);
      badge.textContent = failed ? '!' : n > 99 ? '99+' : String(n);
      badge.title = failed ? `${failed} 首沒有加進音樂庫` : `還有 ${n} 首在上傳或等伺服器處理`;
    }),
    onFailed: (n) => setStatus(`${n} 首沒有加進音樂庫`, { type: 'error', action: { label: '查看', fn: () => { P.setMode('upload'); uploader.showFailed(); } } }),
  });
  $('libUploadBtn').addEventListener('click', () => P.setMode('upload'));
  $('libBotBtn').addEventListener('click', () => P.setMode('bots'));
  P.uploaderStarted = false;
  const UPLOAD_TAB_KEY = 'ml-upload-tab'; // 重新整理／關掉重開前停在上傳頁籤:回來時直接打開

  const folderOf = (f) => f.filename.includes('/') ? f.filename.split('/')[0] : '';
  // 私人上傳(.private/<自己的 ID>/...,只有管理員本人的清單裡會有):資料夾顯示成「私人」(列上加單色鎖頭圖示,見 player.css 的 .row.private),不能點給 Bot
  const PRIVATE_DIR = '.private';
  const isPrivateFile = (fn) => typeof fn === 'string' && fn.startsWith(PRIVATE_DIR + '/');
  const privSubdir = (fn) => fn.split('/').slice(2, -1).join('/'); // .private/<id>/<這段>/檔名
  // 公開歌曲設為私人後的路徑:保留原本的資料夾(uploads/歌.mp3 → .private/<id>/uploads/歌),避免不同資料夾的同名歌撞名
  const privateTarget = (fn) => {
    const parts = fn.split('/');
    const file = parts.pop();
    return [PRIVATE_DIR, P.me.id, ...parts, file.replace(/\.[^.]+$/, '')].join('/');
  };
  const folderLabel = (k) => (k === PRIVATE_DIR ? '私人' : k);
  const libSub = (f) => folderLabel(folderOf(f)) || '音樂庫';
  const onlineSub = (r) => [r.platform, r.author].filter(Boolean).join('・') || '線上歌曲';

  // 使用者主動點選一首歌:重置歷史;若隨機開啟,立刻重新排出不重複的隨機佇列
  function start(filename) {
    P.playlistCtx = null;
    P.history = [];
    P.play(filename);
    if (P.shuffle) P.buildShuffle();
  }
  const libRow = (f, i) => {
    const li = makeRow({
      key: 'lib:' + f.filename, title: f.name, sub: folderLabel(folderOf(f)), dur: P.libDur(f), idx: i + 1,
      btn: { icon: 'more', title: '更多', dlmenu: 'lib:' + f.filename, onClick: (b) => P.openRowMenu(b, f) },
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
    ids: () => P.view.map((f) => f.filename),
    rowId: (r) => r.dataset.key ? r.dataset.key.slice(4) : null,
  });
  function setLibSelecting(on) {
    libSel.setMode(on);
    $('selectBtn').hidden = on;
    $('selBot').hidden = !bots.hasTargets(); // 有 Bot 在語音頻道才顯示「點給 Bot」
    $('selDel').hidden = !P.me.admin || P.isOffline(); // 刪除共用音樂庫的檔案只限管理員
    $('selPriv').hidden = !P.me.admin || !P.me.id || P.isOffline();
    render();
  }
  // 多選下載離線:已經下載過的略過,其餘排進下載佇列(同播放清單的「下載離線」)
  $('selDl').addEventListener('click', () => {
    const files = P.view.filter((f) => libSel.set.has(f.filename));
    if (!files.length) return setStatus('選取的歌曲已不在音樂庫中');
    const todo = files.filter((f) => !P.offlineKeys.has('lib:' + f.filename) && !P.dlState.has('lib:' + f.filename))
      .map((f) => ({ kind: 'lib', filename: f.filename, title: f.name }));
    if (!todo.length) return setStatus('選取的歌曲都已經下載過了');
    P.enqueueDownloads(todo);
    setLibSelecting(false);
    setStatus(`開始下載 ${todo.length} 首` + (todo.length < files.length ? `（${files.length - todo.length} 首已下載，略過）` : ''));
  });
  // 多選設為私人:保留原本的資料夾結構搬進 .private/<自己的 ID>/,已經是私人的略過
  $('selPriv').addEventListener('click', async () => {
    const files = P.view.filter((f) => libSel.set.has(f.filename) && !isPrivateFile(f.filename));
    if (!files.length) return setStatus('選取的歌曲都已經是私人的');
    const names = files.slice(0, 8).map((f) => '・' + f.name).join('\n') + (files.length > 8 ? `\n…還有 ${files.length - 8} 首` : '');
    if (!await askConfirm(`把 ${files.length} 首設為私人？`,
      `只有你看得到、聽得到；其他人的播放清單裡這些歌會變成找不到，Bot 也不能再播放。之後可以在「⋮」選單公開回音樂庫。\n\n${names}`,
      { ok: `設為私人（${files.length} 首）` })) return;
    $('selPriv').disabled = true;
    setStatus(`設為私人中…（${files.length} 首）`, { sticky: true });
    try {
      const j = await P.libApi('POST', '/web/api/library/move-batch', { moves: files.map((f) => ({ from: f.filename, to: privateTarget(f.filename) })) });
      for (const m of j.moved) await P.renameLocalRefs(m.from, m.to);
      setLibSelecting(false);
      if (j.failed.length) setStatus(`已設為私人 ${j.moved.length} 首，${j.failed.length} 首失敗（${j.failed[0].error}）`, { type: 'error' });
      else setStatus(`已設為私人 ${j.moved.length} 首`);
      loadList(null, { quiet: true });
    } catch (err) {
      setStatus('無法設為私人：' + err.message, { type: 'error' });
      libSel.update();
    }
  });
  // 多選刪除:兩次確認(第一次列出內容,第二次再確認一次無法復原),再一次送給伺服器
  $('selDel').addEventListener('click', async () => {
    const files = P.view.filter((f) => libSel.set.has(f.filename));
    if (!files.length) return setStatus('選取的歌曲已不在音樂庫中');
    const priv = files.filter((f) => isPrivateFile(f.filename)).length;
    const pub = files.length - priv;
    const names = files.slice(0, 8).map((f) => '・' + f.name).join('\n') + (files.length > 8 ? `\n…還有 ${files.length - 8} 首` : '');
    const scope = [pub ? `公開 ${pub} 首` : '', priv ? `私人 ${priv} 首` : ''].filter(Boolean).join('、');
    if (!await askConfirm(`刪除選取的 ${files.length} 首歌？`, `${scope}\n\n${names}`, { ok: '下一步', danger: true })) return;
    const warn = pub ? '伺服器上的檔案會被刪除，所有人與 Bot 都無法再播放，所有人播放清單裡的這些歌會變成找不到。' : '伺服器上的私人檔案會被刪除。';
    if (!await askConfirm('再確認一次：真的要刪除？', `${files.length} 首歌將被永久刪除，無法復原。\n${warn}`, { ok: `刪除 ${files.length} 首`, danger: true, delay: 1000 })) return;
    $('selDel').disabled = true;
    setStatus(`刪除中…（${files.length} 首）`, { sticky: true });
    try {
      const j = await P.libApi('POST', '/web/api/library/delete', { files: files.map((f) => f.filename) });
      setLibSelecting(false);
      if (j.failed.length) setStatus(`已刪除 ${j.deleted.length} 首，${j.failed.length} 首失敗（${j.failed[0].error}）`, { type: 'error' });
      else setStatus(`已刪除 ${j.deleted.length} 首`);
      loadList(null, { quiet: true });
    } catch (err) {
      setStatus('無法刪除：' + err.message, { type: 'error' });
      libSel.update();
    }
  });
  $('selectBtn').addEventListener('click', () => setLibSelecting(true));
  $('selCancel').addEventListener('click', () => setLibSelecting(false));
  $('selAdd').addEventListener('click', () => {
    const items = [...libSel.set].filter((fn) => P.byFile.has(fn))
      .map((fn) => ({ kind: 'lib', filename: fn, title: P.byFile.get(fn).name }));
    if (!items.length) return setStatus('選取的歌曲已不在音樂庫中');
    P.pickPlaylist(items, () => setLibSelecting(false));
  });
  // 多選後一次點給 Bot（依音樂庫目前的排序送出）
  $('selBot').addEventListener('click', () => {
    const items = P.view.filter((f) => libSel.set.has(f.filename))
      .map((f) => ({ kind: 'lib', filename: f.filename, title: f.name }));
    if (!items.length) return setStatus('選取的歌曲已不在音樂庫中');
    bots.sendToBot(items, () => setLibSelecting(false));
  });
  // 非隨機模式下佇列畫面裡「接下來播什麼」的預覽列:可以拖曳
  const previewRow = (f) => makeRow({
    key: 'lib:' + f.filename, title: f.name, sub: libSub(f), dur: P.libDur(f),
    grip: true, pv: f.filename, onClick: () => start(f.filename),
  });

  function nowKey() {
    if (P.currentFile) return 'lib:' + P.currentFile;
    if (P.onlineCurrent) return 'on:' + (P.onlineCurrent.srcUrl || P.onlineCurrent.url);
    return null;
  }
  // 不再逐列 toggle:只清掉舊的 .playing,再用屬性選擇器找出目前這首
  // scroll=true 才捲動(只有換歌時需要,搜尋輸入／重畫清單時不該一直把畫面拉回去)
  function markPlaying(scroll = false) {
    const k = nowKey();
    document.querySelectorAll('.row.playing').forEach((r) => { if (r.dataset.key !== k) { r.classList.remove('playing'); r.removeAttribute('aria-current'); } });
    if (!k) return;
    let firstMatch = null;
    document.querySelectorAll(`.row[data-key="${CSS.escape(k)}"]`).forEach((r) => {
      r.classList.add('playing'); r.setAttribute('aria-current', 'true');
      if (!firstMatch && r.closest('#list')) firstMatch = r;
    });
    if (scroll && firstMatch && !$('viewLibrary').hidden) firstMatch.scrollIntoView({ block: 'nearest' });
  }

  // ── 音樂庫清單 ──
  // listReq:可傳入已經發出的請求(初始化時與 IndexedDB 掃描同時進行,省一段等待)
  // quiet:管理動作(移動、改名、刪除、設為私人、上傳完成)後的重新載入,不動提示訊息,免得結果一出現就被蓋掉
  async function loadList(listReq, { quiet = false } = {}) {
    if (!quiet) setStatus('載入清單中…', { sticky: true });
    let r;
    try { r = await (listReq || fetch('/web/api/list')); } catch (err) {
      dbg('loadList 連線失敗', err);
      P.serverDown = true; P.updateNetState();
      if (P.offlineKeys.size && P.mode === 'library' && !autoOfflineDone) { autoOfflineDone = true; P.setMode('offline'); return setStatus('目前無法連線，已切換到離線歌曲'); }
      return setStatus('連線失敗，請檢查網路後再試一次', { type: 'error' });
    }
    if (r.status === 401) { setStatus(''); return P.showLogin(); }
    if (!r.ok) return setStatus('讀取清單失敗，請重新整理頁面再試一次', { type: 'error' });
    // Service Worker 在伺服器沒回應時會改給快取的清單(帶 X-ML-Cached):手機有網路卻拿到快取＝連不上音樂庫
    const cached = r.headers.get('X-ML-Cached') === '1';
    const j = await r.json();
    if (cached) { if (!P.serverDown && navigator.onLine !== false) { P.serverDown = true; P.updateNetState(); } }
    else if (P.serverDown) { P.serverDown = false; P.updateNetState(); }
    P.all = j.files || [];
    for (const f of P.all) f.q = zhFold(f.name + '\n' + f.filename); // 搜尋用,先算好小寫+繁轉簡,打字時不必每個字都重算
    P.byFile = new Map(P.all.map(f => [f.filename, f]));
    P.queue = P.queue.filter(e => e.kind !== 'lib' || P.libAvailable(e.filename)); // 已被刪除(且沒有離線檔)的檔案移出佇列
    $('acctBtn').hidden = false;
    if (!quiet) setStatus('');
    renderChips();
    applyFilter();
    P.loadCapabilities();
    // 先確認是哪個帳號(換帳號時會先清掉上一個人的資料)再載入播放清單;管理員才會接著更新 Bot 狀態
    P.loadMe().finally(P.loadPlaylists);
    scheduleDurations(j.durationsPending);
    autoOpenOffline();
  }

  // 沒網路(或連不上音樂庫)時從主畫面打開:直接帶到離線歌曲,不要停在大半淡掉的音樂庫。
  // 每次開啟只自動切一次,使用者自己切回音樂庫後就不再切
  let autoOfflineDone = false;
  function autoOpenOffline() {
    if (autoOfflineDone || !P.isOffline() || !P.offlineKeys.size || P.mode !== 'library') return;
    autoOfflineDone = true;
    P.setMode('offline');
    setStatus(navigator.onLine === false ? '目前沒有網路，已為你打開離線歌曲' : '暫時連不上音樂庫，已為你打開離線歌曲');
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
      const f = P.byFile.get(nf.filename);
      if (f && nf.duration && f.duration !== nf.duration) { f.duration = nf.duration; changed = true; }
    }
    if (changed) paintDurations();
    scheduleDurations(j.durationsPending);
  }
  function paintDurations() {
    document.querySelectorAll('.row[data-key^="lib:"]').forEach((row) => {
      const text = P.libDur(P.byFile.get(row.dataset.key.slice(4)));
      if (!text) return;
      let d = row.querySelector('.dur');
      if (!d) { d = document.createElement('span'); d.className = 'dur'; row.querySelector('.info').after(d); }
      d.textContent = text;
    });
  }

  // 上方標籤:全部／公開／私人。私人歌曲只會出現在管理員本人的清單裡,
  // 所以只有管理員(或清單裡真的有私人歌曲時)才顯示;要找某個資料夾的歌,直接在搜尋列打資料夾名稱
  const SCOPES = [['', '全部'], ['public', '公開'], ['private', '私人']];
  function renderChips() {
    const box = $('chips'); box.textContent = '';
    box.hidden = !P.me.admin && !P.all.some((f) => isPrivateFile(f.filename));
    if (box.hidden) P.folder = '';
    for (const [key, label] of SCOPES) {
      const b = document.createElement('button');
      b.className = 'chip' + (key === P.folder ? ' active' : '') + (key === 'private' ? ' lock' : '');
      b.textContent = label;
      b.addEventListener('click', () => { P.folder = key; renderChips(); applyFilter(); });
      box.appendChild(b);
    }
  }

  function applyFilter() {
    const q = zhFold(P.libQuery.trim());
    P.view = P.all.filter(f =>
      (!P.folder || (P.folder === 'private') === isPrivateFile(f.filename)) &&
      (!q || f.q.includes(q)));
    P.libLimit = P.LIB_PAGE;
    if (P.shuffle) P.syncShuffleQueue(); // 篩選條件變了,隨機佇列要跟著畫面上的清單走(重新開頁時也靠這裡排好)
    render();
  }

  // 清單底部放一個看不見的哨兵列,快捲到(提前 800px)時接著畫下一批,只追加、不重畫已經有的列
  const libMoreObs = 'IntersectionObserver' in window
    ? new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) renderMoreLib(); }, { root: $('main'), rootMargin: '0px 0px 800px 0px' })
    : null;
  function renderMoreLib() {
    const ul = $('list'), sentinel = ul.querySelector('.lib-sentinel');
    if (!sentinel) return;
    const start = P.libLimit;
    P.libLimit += P.LIB_PAGE;
    const frag = document.createDocumentFragment();
    P.view.slice(start, P.libLimit).forEach((f, i) => frag.appendChild(libRow(f, start + i)));
    sentinel.before(frag);
    libMoreObs.unobserve(sentinel);
    if (P.view.length <= P.libLimit) sentinel.remove();
    else libMoreObs.observe(sentinel); // 重新觀察:畫完如果哨兵還在可視範圍內,會立刻再觸發一次
    markPlaying();
  }
  function render() {
    const nf = (n) => n.toLocaleString();
    $('libCount').textContent = !P.all.length ? '' : P.view.length === P.all.length ? `${nf(P.all.length)} 首` : `${nf(P.view.length)} / ${nf(P.all.length)} 首`;
    const ul = $('list'); ul.textContent = '';
    $('empty').hidden = P.view.length > 0 || !P.all.length;
    if (!P.view.length && P.all.length) {
      // 搜不到：說清楚是音樂庫裡沒有，線上搜尋能用時直接帶著關鍵字過去找
      const q = P.libQuery.trim();
      const canOnline = !!q && P.onlineAvailable && !P.isOffline();
      $('emptyText').textContent = q ? `音樂庫裡沒有「${q}」。` : '這個分類沒有歌。';
      $('emptyHint').textContent = !q ? '切回「全部」看看。' : canOnline ? '可以到線上搜尋找找看。' : '換個關鍵字試試，或清除搜尋。';
      $('emptyOnline').hidden = !canOnline;
      $('emptyOnline').lastChild.textContent = `到線上搜尋「${q}」`;
      $('emptyClear').hidden = !q;
    }
    const frag = document.createDocumentFragment();
    P.view.slice(0, P.libLimit).forEach((f, i) => frag.appendChild(libRow(f, i)));
    if (libMoreObs) libMoreObs.disconnect();
    if (P.view.length > P.libLimit) {
      if (libMoreObs) {
        const s = document.createElement('li');
        s.className = 'lib-sentinel'; s.setAttribute('aria-hidden', 'true');
        frag.appendChild(s);
      } else P.view.slice(P.libLimit).forEach((f, i) => frag.appendChild(libRow(f, P.libLimit + i))); // 不支援 IntersectionObserver:全部畫出
    }
    ul.appendChild(frag);
    const sentinel = ul.querySelector('.lib-sentinel');
    if (sentinel) libMoreObs.observe(sentinel);
    markPlaying();
    P.renderNext();
    if (libSel.on) libSel.update();
  }

  Object.assign(P, {
    coverArtwork, themeMeta, fullTint, bots, uploader, UPLOAD_TAB_KEY, folderOf, PRIVATE_DIR, isPrivateFile,
    privSubdir, privateTarget, folderLabel, libSub, onlineSub, libSel, previewRow,
  });
})();
