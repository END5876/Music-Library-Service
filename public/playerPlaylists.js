'use strict';
// playerPlaylists.js — 播放器：播放清單與離線歌曲頁。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, fmtSize, setStatus, pushLayer, dropLayer, askText, askConfirm } = window.MLUi;

  // 給其他檔案用的函式
  Object.assign(P, {
    loadPlaylists, refillFromCtx, playPlaylist, playCtx, renderOffline, toggleHelp, removeWithUndo, openPlaylist,
    closePlDetail, renderPlaylists, closePick, pickPlaylist, setPlSelecting,
  });

  // ── 播放清單 API ───────────────────────────────────────
  async function plApi(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error(navigator.onLine === false ? '目前沒有網路，連上網路後才能編輯播放清單。' : P.netErrorText()); }
    if (r.status === 401) { P.showLogin('登入已過期，請重新登入。'); throw new Error('請先登入。'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || P.httpErrorText(r.status));
    if (method !== 'GET') fetch(P.PL_API).catch(() => {}); // 順便刷新 Service Worker 的離線快取
    return j;
  }

  async function loadPlaylists() {
    try { P.playlists = (await plApi('GET', P.PL_API)).playlists || []; } catch { return; }
    if (P.plOpen && !P.plById(P.plOpen)) { P.plOpen = null; dropLayer('pl'); }
    if (P.playlistCtx && P.plById(P.playlistCtx.id)) P.playlistCtx.items = P.plById(P.playlistCtx.id).items;
    renderPlaylists();
  }

  // ── 播放清單 → 佇列 ───────────────────────────────────
  const ctxEntry = (it) => {
    const e = it.kind === 'lib' ? P.mkLib(it.filename, it.title) : P.mkOnline(it);
    e.src = it.id;
    return e;
  };
  const ctxPlayable = (it) => it.kind === 'online' || P.libAvailable(it.filename);
  // 依目前的隨機/循環設定,把播放清單剩下的歌排進佇列
  // full=true:新一輪(包含目前這首)
  function refillFromCtx(full = false) {
    if (!P.playlistCtx) return;
    const cur = P.currentEntry(), ck = cur ? P.entryKey(cur) : null;
    let list = P.playlistCtx.items.filter(ctxPlayable).map(ctxEntry);
    if (P.shuffle) {
      if (!full && ck) list = list.filter((e) => P.entryKey(e) !== ck);
      list = P.shuffled(list);
      if (full && ck && list.length > 1 && P.entryKey(list[0]) === ck) {
        const j = 1 + Math.floor(Math.random() * (list.length - 1));
        [list[0], list[j]] = [list[j], list[0]];
      }
    } else if (!full && ck) {
      const i = list.findIndex((e) => P.entryKey(e) === ck);
      if (i >= 0) list = list.slice(i + 1);
    }
    P.queue = P.queue.filter((e) => e.user).concat(list); // 手動排的歌不受影響
    P.renderNext();
  }
  // 播放清單內容變動(加入/移除/排序)時,讓進行中的播放跟著更新
  function syncCtx(pid, { added = [], removedId = null, reordered = false } = {}) {
    if (!P.playlistCtx || P.playlistCtx.id !== pid) return;
    const p = P.plById(pid);
    P.playlistCtx.items = p ? p.items : [];
    if (removedId) P.queue = P.queue.filter((e) => e.src !== removedId);
    for (const it of added) {
      if (!ctxPlayable(it)) continue;
      const e = ctxEntry(it);
      if (P.shuffle) P.queue.splice(Math.floor(Math.random() * (P.queue.length + 1)), 0, e); else P.queue.push(e);
    }
    if (reordered && !P.shuffle) refillFromCtx();
    P.renderNext();
  }

  function playPlaylist(pid, startId, { shuffleStart = false } = {}) {
    const p = P.plById(pid); if (!p) return;
    if (!playCtx(pid, p.items, startId, shuffleStart)) return setStatus('這個播放清單沒有可播放的歌曲');
    if (shuffleStart) setStatus('隨機播放「' + p.name + '」');
  }
  // 以一組項目(播放清單或離線歌曲)作為播放範圍開始播;沒有可播的回 false
  function playCtx(id, all, startId, shuffleStart) {
    const items = all.filter(ctxPlayable);
    if (!items.length) return false;
    if (shuffleStart) { P.shuffle = true; P.syncButtons(); P.savePrefs(); }
    let first;
    if (startId) first = items.find((it) => it.id === startId) || items[0];
    else if (shuffleStart) first = items[Math.floor(Math.random() * items.length)];
    else first = items[0]; // ▶ 一律從第一首開始(隨機開啟時,後面的順序才會打亂)
    P.playlistCtx = { id, items: all };
    P.history = [];
    P.queue = [];
    P.playEntry(first.kind === 'lib' ? { kind: 'lib', filename: first.filename, title: first.title } : { kind: 'online', item: first });
    refillFromCtx();
    return true;
  }

  // ── 離線歌曲頁 ────────────────────────────────────────
  // 資料完全來自這台裝置的 IndexedDB(offlineKeys / offlineMeta),沒有網路也能列出與播放
  const OFF_CTX = '__offline';
  P.offSort = 'recent'; P.offView = [];
  function offItem(key) {
    const m = P.offlineMeta.get(key) || {};
    if (key.startsWith('lib:')) {
      const filename = key.slice(4), f = P.byFile.get(filename);
      return { id: key, kind: 'lib', filename, title: (f && f.name) || m.title || filename.split('/').pop(), duration: P.libDur(f) || m.duration || '', at: m.at || 0 };
    }
    return { id: key, kind: 'online', url: key.slice(3), title: m.title || '未知標題', author: m.author, platform: m.platform, duration: m.duration, at: m.at || 0 };
  }
  const offSub = (it) => it.kind === 'lib' ? (it.filename.includes('/') ? P.folderLabel(it.filename.split('/')[0]) : '音樂庫') : P.onlineSub(it);
  function renderOffline() {
    const q = zhFold(P.offQuery.trim());
    let list = [...P.offlineKeys].map(offItem);
    if (q) list = list.filter((it) => zhFold(it.title + '\n' + offSub(it)).includes(q));
    if (P.offSort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hant'));
    else list.sort((a, b) => b.at - a.at);
    P.offView = list;
    const ul = $('offList'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    list.forEach((it, i) => frag.appendChild(P.makeRow({
      key: it.id, idx: i + 1, title: it.title, sub: offSub(it), dur: it.duration && it.duration !== '未知' ? it.duration : '',
      btn: { icon: 'more', title: '更多', onClick: (b) => openOffMenu(b, it) },
      onClick: () => playCtx(OFF_CTX, P.offView, it.id, false),
    })));
    ul.appendChild(frag);
    const none = P.offlineKeys.size === 0;
    $('offEmpty').hidden = list.length > 0;
    // 沒網路時不叫人去下載（現在也下載不了），改成說明連上網路後怎麼做
    $('offEmptyText').textContent = !none ? '沒有符合的離線歌曲。' : P.isOffline() ? '這台裝置還沒有下載的歌曲。' : '還沒有離線歌曲。';
    $('offEmptyHint').textContent = P.isOffline()
      ? '連上網路後，在播放清單按下載鈕，之後沒網路也能聽。'
      : '在播放清單按下載鈕，或從歌曲的「⋮」選「下載離線」。';
    $('offEmptyHint').hidden = !none; $('offGoPl').hidden = !none || P.isOffline();
    $('offSort').hidden = none;
    $('offPlay').hidden = $('offShuffle').hidden = none; // 沒有離線歌曲時不顯示播放鈕
    $('offPlay').disabled = $('offShuffle').disabled = !list.length;
    P.markPlaying();
  }
  function openOffMenu(anchor, it) {
    if (P.menuAnchor === anchor) return P.closeRowMenu();
    P.menuAnchor = anchor;
    P.menuEl.textContent = '';
    const item = it.kind === 'lib' ? { kind: 'lib', filename: it.filename, title: it.title }
      : { kind: 'online', url: it.url, title: it.title, author: it.author, platform: it.platform, duration: it.duration };
    P.queueMenuItems(item);
    P.menuItem('playlist-add', '加入播放清單', () => pickPlaylist([item]));
    P.menuItem('delete', '移除離線檔案', () => P.removeOfflineUndoable(item), 'danger');
    const at = it.at ? new Date(it.at).toLocaleString() : '';
    P.menuInfo([
      ['來源：', offSub(it)],
      ...(it.duration ? [['長度：', it.duration]] : []),
      ['檔案大小：', fmtSize(P.offlineSizes.get(it.id) || 0)],
      ...(at ? [['下載時間：', at]] : []),
    ]);
    P.placeMenu(anchor);
  }
  $('offPlay').addEventListener('click', () => playCtx(OFF_CTX, P.offView, null, false));
  $('offShuffle').addEventListener('click', () => { if (playCtx(OFF_CTX, P.offView, null, true)) setStatus('隨機播放離線歌曲'); });
  $('offGoPl').addEventListener('click', () => P.setMode('playlists'));
  // 音樂庫搜不到時的兩個按鈕
  $('emptyClear').addEventListener('click', () => { P.libQuery = ''; $('search').value = ''; P.applyFilter(); $('search').focus(); });
  $('emptyOnline').addEventListener('click', () => {
    P.onlineQuery = P.libQuery.trim();
    P.setMode('online');
    const form = $('searchForm');
    if (form.requestSubmit) form.requestSubmit(); // iOS 15 以前的 Safari 沒有 requestSubmit
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  $('offSort').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]'); if (!b) return;
    P.offSort = b.dataset.sort;
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
    const j = await plApi('POST', P.PL_API, { name, items });
    P.upsertPlaylist(j.playlist);
    return j.playlist;
  }
  async function addToPlaylist(pid, items) {
    const before = new Set((P.plById(pid) || { items: [] }).items.map((x) => x.id));
    const j = await plApi('POST', `${P.PL_API}/${pid}/items`, { items });
    P.upsertPlaylist(j.playlist);
    syncCtx(pid, { added: j.playlist.items.filter((x) => !before.has(x.id)) });
    renderPlaylists();
    return j;
  }
  async function removeFromPlaylist(pid, iid) {
    try {
      const j = await plApi('DELETE', `${P.PL_API}/${pid}/items/${iid}`);
      P.upsertPlaylist(j.playlist);
    } catch (err) { return setStatus(err.message, { type: 'error' }); }
    syncCtx(pid, { removedId: iid });
    renderPlaylists();
    return true;
  }
  // 移出後在提示裡提供「復原」:把歌加回去,再照原本的順序排好
  async function removeWithUndo(pid, its) {
    const p = P.plById(pid); if (!p || !its.length) return false;
    const beforeOrder = p.items.map((x) => x.id);
    const ok = its.length === 1 ? await removeFromPlaylist(pid, its[0].id) : await removeManyFromPlaylist(pid, its.map((x) => x.id), true);
    if (!ok) return false;
    setStatus(its.length === 1 ? `已從「${p.name}」移出` : `已從「${p.name}」移出 ${its.length} 首`, {
      action: { label: '復原', fn: () => restoreItems(pid, its, beforeOrder) },
    });
    return true;
  }
  async function restoreItems(pid, its, beforeOrder) {
    const p = P.plById(pid); if (!p) return setStatus('播放清單已不存在');
    const had = new Set(p.items.map((x) => x.id));
    const strip = ({ id, ...rest }) => rest;
    try { await addToPlaylist(pid, its.map(strip)); } catch (err) { return setStatus('沒有復原成功：' + err.message, { type: 'error' }); }
    // 加回去的項目會拿到新 id:用歌曲 key 對回原本的 id,再依原順序重排
    const now = P.plById(pid); if (!now) return;
    const newIdByKey = new Map(now.items.filter((x) => !had.has(x.id)).map((x) => [P.itemKey(x), x.id]));
    const newIdByOld = new Map(its.map((x) => [x.id, newIdByKey.get(P.itemKey(x))]));
    const exists = new Set(now.items.map((x) => x.id));
    const order = beforeOrder.map((id) => newIdByOld.get(id) || id).filter((id) => exists.has(id));
    for (const x of now.items) if (!order.includes(x.id)) order.push(x.id); // 期間新加入的(別台裝置)放最後
    await reorderPlaylist(pid, order);
    setStatus('已復原');
  }
  async function removeManyFromPlaylist(pid, ids, quiet = false) {
    let j;
    try { j = await plApi('POST', `${P.PL_API}/${pid}/items/remove`, { ids }); }
    catch (err) { setStatus(err.message, { type: 'error' }); return false; }
    P.upsertPlaylist(j.playlist);
    if (P.playlistCtx && P.playlistCtx.id === pid) { const gone = new Set(ids); P.queue = P.queue.filter((e) => !gone.has(e.src)); }
    syncCtx(pid);
    renderPlaylists();
    if (!quiet) setStatus(`已移出 ${j.removed} 首`);
    return true;
  }
  async function reorderPlaylist(pid, ids) {
    const p = P.plById(pid); if (!p) return;
    const map = new Map(p.items.map((it) => [it.id, it]));
    const old = p.items;
    p.items = ids.map((i) => map.get(i)).filter(Boolean);
    syncCtx(pid, { reordered: true });
    renderPlaylists();
    try {
      const j = await plApi('PUT', `${P.PL_API}/${pid}/order`, { order: ids });
      P.upsertPlaylist(j.playlist);
      syncCtx(pid); renderPlaylists();
    } catch (err) {
      p.items = old; syncCtx(pid);
      setStatus(err.message, { type: 'error' }); loadPlaylists();
    }
  }

  function openPlaylist(id) {
    if (plSel.on) plSel.setMode(false);
    P.saveScroll();
    P.plOpen = id; P.plQuery = ''; $('search').value = '';
    renderPlaylists();
    $('main').scrollTop = 0;
    pushLayer('pl', closePlDetail);
  }
  function closePlDetail() {
    if (plSel.on) plSel.setMode(false);
    P.plOpen = null; P.plQuery = ''; $('search').value = '';
    renderPlaylists(); P.restoreScroll();
    dropLayer('pl');
  }

  // ── 畫面 ──────────────────────────────────────────────
  function renderPlaylists() {
    const detail = P.plOpen && P.plById(P.plOpen);
    $('plListPane').hidden = !!detail;
    $('plDetailPane').hidden = !detail;
    document.body.classList.toggle('pl-detail', P.mode === 'playlists' && !!detail);
    if (detail) renderPlDetail(detail); else renderPlList();
    P.updateOfflineInfo();
  }

  function renderPlList() {
    const q = zhFold(P.plQuery.trim());
    const list = P.playlists.filter((p) => !q || zhFold(p.name).includes(q));
    $('plCount').textContent = P.playlists.length ? `${P.playlists.length} 個` : '';
    $('plEmpty').hidden = list.length > 0;
    $('plEmptyText').textContent = P.playlists.length ? '沒有符合的播放清單' : '還沒有播放清單';
    $('plEmptyNew').hidden = P.playlists.length > 0;
    const ul = $('plLists'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    for (const p of list) frag.appendChild(P.plCard(p));
    ul.appendChild(frag);
  }

  function plItemRow(p, it, canDrag, i) {
    const key = P.itemKey(it), isLib = it.kind === 'lib';
    const f = isLib ? P.byFile.get(it.filename) : null;
    const missing = isLib && P.byFile.size > 0 && !f && !P.offlineKeys.has(key);
    return P.makeRow({
      key, iid: it.id, missing, idx: i + 1,
      title: P.itemTitle(it),
      sub: isLib ? (f ? P.libSub(f) : (missing ? '檔案已不存在' : '音樂庫')) : P.onlineSub(it),
      dur: isLib ? P.libDur(f) : (it.duration && it.duration !== '未知' ? it.duration : ''),
      grip: canDrag && !plSel.on ? (ev, li) => startPlDrag(ev, li, p.id) : false,
      btn: { icon: 'more', title: '更多', dlmenu: key, onClick: (b) => P.openItemMenu(b, p, it) },
      onClick: (ev) => plSel.on ? plSel.toggle(it.id, ev.shiftKey) : playPlaylist(p.id, it.id),
    });
  }
  // 播放清單內頁目前看得到的項目(套用頂部搜尋)
  function plVisible(p) {
    const q = zhFold(P.plQuery.trim());
    return q ? p.items.filter((it) => zhFold(P.itemTitle(it)).includes(q)) : p.items;
  }

  function renderPlDetail(p) {
    $('plTitle').textContent = p.name;
    P.paintPlCover(document.querySelector('#plDetailPane .pl-cover'), p);
    if (!P.plQuery && $('plSearch').value) $('plSearch').value = '';
    const ul = $('plItems'); ul.textContent = '';
    $('plItemsEmpty').hidden = p.items.length > 0;
    const frag = document.createDocumentFragment();
    plVisible(p).forEach((it, i) => frag.appendChild(plItemRow(p, it, !P.plQuery.trim(), i))); // 搜尋篩選時不能拖曳排序
    ul.appendChild(frag);
    if (plSel.on) {
      for (const id of [...plSel.set]) if (!p.items.some((it) => it.id === id)) plSel.set.delete(id); // 已被移除(例如別台裝置)的不再算選取
      plSel.paint(); plSel.update();
    }
    P.updatePlDetailButtons();
    P.markPlaying();
  }

  // 拖曳排序(播放清單版,共用 dragSort)
  function startPlDrag(ev, li, pid) {
    const rows = [...$('plItems').querySelectorAll('.row[data-iid]')].filter((r) => r !== li);
    P.dragSort(ev, li, rows, $('main'), (dropped, pos) => {
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
    $('pickPl').querySelector('.ttl').textContent = items.length > 1 ? `加入播放清單（${items.length} 首）` : '加入播放清單';
    const ul = $('pickList'); ul.textContent = '';
    if (!P.playlists.length) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = '你還沒有播放清單。建立一個來收藏這首歌。'; ul.appendChild(li);
    }
    for (const p of P.playlists) {
      ul.appendChild(P.makeRow({
        title: p.name, sub: `${p.items.length} 首`,
        onClick: async () => {
          const its = pickItems, done = pickDone; closePick();
          try {
            const j = await addToPlaylist(p.id, its);
            const dup = its.length - j.added;
            setStatus(!j.added ? `「${p.name}」已經有${its.length > 1 ? '這些歌' : '這首歌'}了`
              : `已加入「${p.name}」` + (its.length > 1 ? `（${j.added} 首` + (dup > 0 ? `，略過 ${dup} 首重複` : '') + '）' : ''));
            if (done) done();
          } catch (err) { setStatus(err.message, { type: 'error' }); }
        },
      }));
    }
    $('pickPl').classList.add('show');
    pushLayer('pick', closePick);
  }
  $('pickClose').addEventListener('click', closePick);
  $('pickNew').addEventListener('click', async () => {
    const its = pickItems, done = pickDone; closePick();
    const name = await askText('新增播放清單', '', { ok: '建立播放清單', placeholder: '例如：通勤、讀書用', maxLength: 50 });
    if (!name) return;
    try {
      const p = await createPlaylist(name, its);
      renderPlaylists();
      setStatus(`已建立「${p.name}」並加入 ${p.items.length} 首`);
      if (done) done();
    } catch (err) { setStatus(err.message, { type: 'error' }); }
  });
  $('fAddPl').addEventListener('click', () => {
    const c = P.currentEntry();
    if (!c) return setStatus('目前沒有播放中的歌曲');
    pickPlaylist([c.kind === 'lib'
      ? { kind: 'lib', filename: c.filename, title: (P.byFile.get(c.filename) || {}).name }
      : P.onlineItem(c.item)]);
  });

  // ── 播放清單頁面的按鈕 ────────────────────────────────
  $('plNew').addEventListener('click', async () => {
    const name = await askText('新增播放清單', '', { ok: '建立播放清單', placeholder: '例如：通勤、讀書用', maxLength: 50 });
    if (!name) return;
    try { const p = await createPlaylist(name); openPlaylist(p.id); } catch (err) { setStatus(err.message, { type: 'error' }); }
  });
  $('plEmptyNew').addEventListener('click', () => $('plNew').click());
  $('plGoLib').addEventListener('click', () => P.setMode('library'));
  $('plBack').addEventListener('click', closePlDetail);
  $('plPlay').addEventListener('click', () => { if (P.plOpen) playPlaylist(P.plOpen); });
  $('plShuffle').addEventListener('click', () => { if (P.plOpen) playPlaylist(P.plOpen, null, { shuffleStart: true }); });
  // 播放清單內頁多選:批次移出 / 加入其他清單
  const plSel = P.makeSelector({
    name: 'plSel', exit: () => setPlSelecting(false),
    list: $('plItems'), bar: $('plSelBar'),
    ids: () => { const p = P.plOpen && P.plById(P.plOpen); return p ? plVisible(p).map((it) => it.id) : []; },
    rowId: (r) => r.dataset.iid || null,
  });
  function setPlSelecting(on) { plSel.setMode(on); $('plSelBot').hidden = !P.bots.hasTargets(); renderPlaylists(); }
  const plSelItems = () => {
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return [];
    const byId = new Map(p.items.map((it) => [it.id, it]));
    return [...plSel.set].map((id) => byId.get(id)).filter(Boolean);
  };
  $('plSelect').addEventListener('click', () => setPlSelecting(true));
  $('plSelCancel').addEventListener('click', () => setPlSelecting(false));
  $('plSelRemove').addEventListener('click', async () => {
    const p = P.plOpen && P.plById(P.plOpen); const its = plSelItems();
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
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return;
    const sel = new Set(plSelItems().map((it) => it.id));
    P.bots.sendToBot(p.items.filter((it) => sel.has(it.id)).map(plToBotItem), () => setPlSelecting(false));
  });
  $('plToBot').addEventListener('click', () => {
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return;
    if (!p.items.length) return setStatus('這個播放清單是空的');
    P.bots.sendToBot(p.items.map(plToBotItem));
  });

  $('plRename').addEventListener('click', async () => {
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return;
    const name = await askText(`重新命名「${p.name}」`, p.name, { ok: '儲存名稱', placeholder: '播放清單名稱', maxLength: 50 });
    if (!name || name === p.name) return;
    try { P.upsertPlaylist((await plApi('PATCH', `${P.PL_API}/${p.id}`, { name })).playlist); renderPlaylists(); }
    catch (err) { setStatus(err.message, { type: 'error' }); }
  });
  $('plDelete').addEventListener('click', async () => {
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return;
    if (!await askConfirm(`刪除播放清單「${p.name}」？`, '歌曲本身不會被刪除。', { ok: '刪除播放清單', danger: true })) return;
    try { await plApi('DELETE', `${P.PL_API}/${p.id}`); } catch (err) { return setStatus(err.message, { type: 'error' }); }
    P.playlists = P.playlists.filter((x) => x.id !== p.id);
    if (P.playlistCtx && P.playlistCtx.id === p.id) P.playlistCtx = null;
    if (plSel.on) plSel.setMode(false);
    P.plOpen = null; renderPlaylists(); dropLayer('pl');
    setStatus('已刪除播放清單');
  });
  $('plDownloadAll').addEventListener('click', async () => {
    const p = P.plOpen && P.plById(P.plOpen); if (!p) return;
    if (P.dlBusy()) { P.cancelDownloads(); return; }
    const dls = p.items.filter(P.plDownloadable);
    if (!dls.length) return setStatus('沒有可下載的歌曲');
    // 全部都已下載:再按一次就是移除
    if (dls.every((it) => P.offlineKeys.has(P.itemKey(it)))) {
      if (!await askConfirm('移除這個播放清單的離線檔案？', '之後需要網路才能播放這些歌曲。', { ok: '移除離線檔案', danger: true })) return;
      P.removeOffline(p.items).then(() => setStatus('已移除離線檔案'));
      return;
    }
    P.enqueueDownloads(dls);
  });
  $('offlineClear').addEventListener('click', async () => {
    const offNote = P.isOffline() ? '\n目前沒有網路，清除後要等連上網路才能重新下載，在那之前沒有歌可以播。' : '';
    if (!await askConfirm('清除全部離線檔案？', `這台裝置上下載的 ${P.offlineKeys.size} 首歌曲都會被移除。${offNote}`, { ok: '清除全部', danger: true })) return;
    try { await P.offlineClearAll(); P.offlineKeys.clear(); P.offlineSizes.clear(); P.offlineMeta.clear(); setStatus('已清除全部離線檔案'); }
    catch (err) { setStatus('沒有清除成功：' + err.message, { type: 'error' }); }
    P.refreshDl();
  });

  Object.assign(P, {
    ctxEntry, ctxPlayable, OFF_CTX, plSel,
  });
})();
