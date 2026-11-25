'use strict';
// playerMenus.js — 播放器：⋮ 選單、音樂庫管理、播放清單卡片。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, fmt, fmtSize, setStatus, pushLayer, dropLayer, askText, askConfirm } = window.MLUi;
  const { DEBUG_UI, dbg, setupDebugPanel } = window.MLDebug;
  const { ANDROID_BY, IS_ANDROID, KEEP } = window.MLPlatform;

  // 給其他檔案用的函式
  Object.assign(P, {
    closeRowMenu, applyMoreButton, openRowMenu, libApi, renameLocalRefs, menuItem, menuInfo, placeMenu,
    openItemMenu, plCard,
  });

  // ── 歌曲列的「⋮」選單(下載離線 / 加入播放清單 / 歌曲資訊)──────
  const menuEl = document.createElement('div');
  menuEl.className = 'row-menu'; menuEl.hidden = true;
  document.body.appendChild(menuEl);
  P.menuAnchor = null;

  function closeRowMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true; P.menuAnchor = null;
    dropLayer('menu');
  }

  // 下載中時,⋮ 按鈕顯示百分比;平常顯示三點圖示
  function applyMoreButton(b) {
    const st = P.dlState.get(b.dataset.dlmenu);
    if (st) {
      b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
      b.style.fontSize = '11px';
    } else {
      b.innerHTML = '<svg><use href="#i-more"/></svg>';
      b.style.fontSize = '';
    }
  }

  function openRowMenu(anchor, f) {
    if (P.menuAnchor === anchor) return closeRowMenu();
    P.menuAnchor = anchor;
    const key = 'lib:' + f.filename;
    const item = { kind: 'lib', filename: f.filename, title: f.name };
    const isOff = P.offlineKeys.has(key);
    menuEl.textContent = '';

    P.queueMenuItems(item);
    menuItem(isOff ? 'close' : 'download',
      isOff ? '移除離線檔案' : (P.dlState.has(key) ? '下載中…' : '下載離線'),
      () => P.toggleOffline(item));
    menuItem('playlist-add', '加入播放清單', () => P.pickPlaylist([item]));
    const priv = P.isPrivateFile(f.filename);
    if (P.me.admin && !P.isOffline()) { // 音樂庫是共用的:移動／改名／刪除只限管理員
      if (priv) {
        menuItem('lib', '移到其他私人分類', () => moveLibFile(f, 'folder'));
        menuItem('downloaded', '公開到音樂庫', () => moveLibFile(f, 'publish'));
      } else {
        if (!P.folderOf(f)) menuItem(f.cache ? 'downloaded' : 'lib', f.cache ? '收藏（移到分類）' : '移到分類', () => moveLibFile(f, 'folder'));
        else menuItem('lib', '移到其他分類', () => moveLibFile(f, 'folder'));
        if (P.me.id) menuItem('offline', '設為私人', () => moveLibFile(f, 'private'));
      }
      menuItem('edit', '重新命名', () => moveLibFile(f, 'rename'));
      menuItem('delete', priv ? '刪除私人歌曲' : '從音樂庫刪除', () => deleteLibFile(f), 'danger');
    }
    menuInfo([
      ['分類：', priv ? '私人' + (P.privSubdir(f.filename) ? ' / ' + P.privSubdir(f.filename) : '') : (P.folderOf(f) || '未分類')],
      ...(priv ? [['可見範圍：', '只有你']] : []),
      ...(f.duration ? [['長度：', fmt(f.duration)]] : []),
      ['檔案大小：', fmtSize(f.size)],
      ['離線狀態：', isOff ? '已下載到此裝置' : (P.dlState.has(key) ? '下載中' : '未下載')],
      // 只有線上播放時自動存下的歌會被清掉：管理員可以收藏，一般使用者給做得到的事
      ...(f.cache ? [['提醒：', P.me.admin
        ? '這首是線上播放時自動存下的，空間不夠時會被清掉。移到分類就會一直保留。'
        : '這首之後可能會被清掉，想隨時能聽請「下載離線」。']] : []),
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
    } catch { throw new Error(P.netErrorText()); }
    if (r.status === 401) { P.showLogin('登入已過期，請重新登入。'); throw new Error('請先登入。'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || P.httpErrorText(r.status));
    return j;
  }

  // 檔名改了:佇列、播放歷史、目前播放、播放中的清單、離線檔都跟著換成新路徑(伺服器端的播放清單已由 API 改好)
  async function renameLocalRefs(from, to) {
    const fix = (e) => { if (e && e.kind === 'lib' && e.filename === from) e.filename = to; };
    P.queue.forEach(fix); P.history.forEach(fix);
    if (P.playlistCtx) P.playlistCtx.items.forEach(fix);
    const oldKey = 'lib:' + from, newKey = 'lib:' + to;
    if (P.currentFile === from) {
      P.currentFile = to;
      // 舊網址已經 404:之後的重試、斷網恢復、補救重新載入都要改用新路徑,不然這首會被當成壞檔略過
      if (P.lastSrc && P.lastSrc.key === oldKey) P.lastSrc = { key: newKey, url: P.streamUrl(to) };
      if (P.resumeAt && P.resumeAt.key === oldKey) P.resumeAt.key = newKey;
      if (P.errorRetryKey === oldKey) P.errorRetryKey = newKey;
      if (P.waitingNet === oldKey) P.waitingNet = newKey;
    }
    if (P.preload && P.preload.key === oldKey) P.dropPreload();
    if (!P.offlineKeys.has(oldKey)) return;
    try {
      const blob = await P.offlineGet(oldKey);
      if (!blob) return;
      const meta = P.offlineMeta.get(oldKey) || {};
      await P.offlinePut({ key: newKey, blob, size: blob.size, ...meta });
      await P.offlineDel(oldKey);
      P.offlineKeys.delete(oldKey); P.offlineKeys.add(newKey);
      P.offlineSizes.set(newKey, P.offlineSizes.get(oldKey) || blob.size); P.offlineSizes.delete(oldKey);
      P.offlineMeta.set(newKey, meta); P.offlineMeta.delete(oldKey);
    } catch (err) { dbg('離線檔改名失敗', err); }
  }

  // how:'folder' 移到資料夾(保留檔名)／'rename' 改檔名(保留資料夾)
  // 另外:'publish' 私人 → 公開資料夾／'private' 公開 → 自己的私人空間
  async function moveLibFile(f, how) {
    const parts = f.filename.split('/');
    const file = parts.pop();
    const ext = (file.match(/\.[^.]+$/) || [''])[0];
    const stem = file.slice(0, file.length - ext.length);
    const dir = parts.join('/');
    const privRoot = P.PRIVATE_DIR + '/' + P.me.id;
    const cleanDir = (d) => d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    let to;
    if (how === 'private') {
      if (!await askConfirm('設為私人？', f.name + '\n只有你看得到、聽得到；其他人的播放清單裡這首會變成找不到，Bot 也不能再播放。', { ok: '設為私人' })) return;
      to = P.privateTarget(f.filename);
    } else if (how === 'folder' && P.isPrivateFile(f.filename)) {
      const d = await askText('移到哪個私人分類？', P.privSubdir(f.filename), { ok: '移到這裡', allowEmpty: true, placeholder: '留空＝未分類', maxLength: 100 });
      if (d === null) return;
      to = privRoot + '/' + (cleanDir(d) ? cleanDir(d) + '/' : '') + stem;
    } else if (how === 'folder' || how === 'publish') {
      const folders = [...new Set(P.all.map(P.folderOf).filter((k) => k && k !== P.PRIVATE_DIR))];
      const hint = folders.length ? '（現有：' + folders.slice(0, 5).join('、') + (folders.length > 5 ? '…' : '') + '）' : '';
      const d = await askText((how === 'publish' ? '公開到哪個分類？' : '移到哪個分類？') + hint, how === 'publish' ? 'uploads' : (dir || 'favorites'), { ok: how === 'publish' ? '公開到這裡' : '移到這裡', placeholder: '例如：favorites、jpop', maxLength: 100 });
      if (d === null) return;
      const clean = d.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!clean) return setStatus('請輸入分類名稱。');
      to = clean + '/' + stem;
    } else {
      const n = await askText(`重新命名「${f.name}」`, stem, { ok: '重新命名', placeholder: '新的檔名', maxLength: 180 });
      if (n === null || n === stem) return;
      to = (dir ? dir + '/' : '') + n;
    }
    try {
      const j = await libApi('POST', '/web/api/library/move', { from: f.filename, to });
      await renameLocalRefs(j.from, j.to);
      const where = P.isPrivateFile(j.to) ? '私人' + (P.privSubdir(j.to) ? ' / ' + P.privSubdir(j.to) : '') : j.to.split('/').slice(0, -1).join('/');
      setStatus(how === 'private' ? '已設為私人' : how === 'publish' ? '已公開到「' + where + '」' : how === 'folder' ? '已移到「' + where + '」' : '已重新命名');
      // 正在播的就是這首:清單重新載入後把播放資訊換成新名稱
      P.loadList(null, { quiet: true }).then(() => { const t = P.currentFile === j.to && P.byFile.get(j.to); if (t) P.setNow({ title: t.name, sub: P.libSub(t) }); });
    } catch (err) { setStatus((how === 'rename' ? '無法重新命名：' : how === 'private' ? '無法設為私人：' : how === 'publish' ? '無法公開：' : '無法移到分類：') + err.message, { type: 'error' }); }
  }

  async function deleteLibFile(f) {
    const priv = P.isPrivateFile(f.filename);
    if (!await askConfirm(priv ? '刪除這首私人歌曲？' : '從音樂庫刪除這首歌？',
      f.name + (priv ? '\n伺服器上的私人檔案會被刪除，無法復原。' : '\n伺服器上的檔案會被刪除，所有裝置與 Bot 都無法再播放，無法復原。'),
      { ok: '刪除歌曲', danger: true })) return;
    try {
      await libApi('DELETE', P.streamUrl(f.filename).replace('/web/stream/', '/web/api/library/file/'));
      setStatus(`已刪除「${f.name}」`);
      P.loadList(null, { quiet: true });
    } catch (err) { setStatus('無法刪除：' + err.message, { type: 'error' }); }
  }

  document.addEventListener('pointerdown', (e) => {
    if (menuEl.hidden) return;
    if (menuEl.contains(e.target) || (P.menuAnchor && P.menuAnchor.contains(e.target))) return; // 按鈕自己的 click 負責開關
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
    if (P.menuAnchor === anchor) return closeRowMenu();
    P.menuAnchor = anchor;
    const key = P.itemKey(it), isOff = P.offlineKeys.has(key);
    menuEl.textContent = '';
    P.queueMenuItems(it);
    menuItem(isOff ? 'close' : 'download',
      isOff ? '移除離線檔案' : (P.dlState.has(key) ? '下載中…' : '下載離線'),
      () => P.toggleOffline(it));
    menuItem('close', '移出播放清單', () => P.removeWithUndo(p.id, [it]), 'danger');
    const lines = [];
    if (it.kind === 'lib') {
      const f = P.byFile.get(it.filename);
      lines.push(['分類：', it.filename.includes('/') ? P.folderLabel(it.filename.split('/')[0]) : '未分類']);
      if (P.libDur(f)) lines.push(['長度：', P.libDur(f)]);
      if (f) lines.push(['檔案大小：', fmtSize(f.size)]);
    } else {
      lines.push(['來源：', it.platform || '線上']);
      if (it.author) lines.push(['作者：', it.author]);
      if (it.duration && it.duration !== '未知') lines.push(['長度：', it.duration]);
    }
    lines.push(['離線狀態：', isOff ? '已下載到此裝置' : (P.dlState.has(key) ? '下載中' : '未下載')]);
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
  $('plSearch').addEventListener('input', () => { P.plQuery = $('plSearch').value; P.renderPlaylists(); });

  // ── 播放清單總覽:卡片(電腦版為封面網格,手機版為列表)+ 下載按鈕判斷 ──────
  const plDownloadable = (it) => it.kind === 'online' || P.byFile.has(it.filename);

  function plCard(p) {
    const nOff = p.items.filter((it) => P.offlineKeys.has(P.itemKey(it))).length;
    const li = document.createElement('li');
    li.className = 'pl-card';
    const mkPlay = (cls) => {
      const b = document.createElement('button');
      b.className = cls; b.title = '播放'; b.setAttribute('aria-label', '播放 ' + p.name);
      b.innerHTML = '<svg><use href="#i-play"/></svg>';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); P.playPlaylist(p.id); });
      return b;
    };
    const art = document.createElement('div'); art.className = 'pl-card-art';
    const cv = document.createElement('div'); cv.className = 'cover';
    P.paintPlCover(cv, p);
    art.append(cv, mkPlay('pl-card-play'));
    const info = document.createElement('div'); info.className = 'pl-card-info';
    const t = document.createElement('div'); t.className = 't'; t.textContent = p.name; t.title = p.name;
    const a = document.createElement('div'); a.className = 'a';
    a.textContent = `${p.items.length} 首歌曲` + (nOff ? `，已下載 ${nOff} 首` : '');
    info.append(t, a);
    li.append(art, info, mkPlay('pl-card-pm'));
    li.addEventListener('click', () => P.openPlaylist(p.id));
    li.setAttribute('aria-label', `${p.name},${p.items.length} 首歌曲`);
    P.kbRow(li);
    return li;
  }

  if (DEBUG_UI) setupDebugPanel({ $, setStatus, IS_ANDROID, ANDROID_BY, KEEP, isBusy: P.isBusy });
  // 切到背景時預載下一首(只在 Android 生效,見 preloadNext)
  document.addEventListener('visibilitychange', () => { if (document.hidden) P.preloadNext(); });

  Object.assign(P, {
    menuEl, plDownloadable,
  });
})();
