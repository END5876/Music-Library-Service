'use strict';
// playerSource.js — 播放器：線上搜尋與串流、離線儲存、預載、載入音源。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, enc, fmtSize, setStatus } = window.MLUi;
  const { dbg } = window.MLDebug;
  const { IS_ANDROID } = window.MLPlatform;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    loadCapabilities, netErrorText, httpErrorText, queueMenuItems, playOnline, upsertPlaylist, offlineInit,
    dropPreload, preloadNext, loadSource,
  });

  // ── 線上搜尋/串流 ──
  async function loadCapabilities() {
    try {
      const r = await fetch('/web/api/capabilities');
      P.onlineAvailable = r.ok && !!(await r.json()).online;
    } catch { P.onlineAvailable = false; }
    document.querySelectorAll('.needs-online').forEach(el => { el.hidden = !P.onlineAvailable; });
    if (!P.onlineAvailable && P.mode === 'online') P.setMode('library');
  }

  async function apiJson(url) {
    let r;
    try { r = await fetch(url); } catch { throw new Error(netErrorText()); }
    if (r.status === 401) { P.showLogin('登入已過期，請重新登入。'); throw new Error('請先登入。'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || httpErrorText(r.status));
    return j;
  }
  // 連不上（fetch 直接失敗）時的說明：分清楚是手機沒網路，還是音樂庫沒回應
  function netErrorText() {
    return navigator.onLine === false ? '目前沒有網路，連上後再試一次。' : '連不上音樂庫，請稍後再試一次。';
  }
  // 伺服器沒有給錯誤說明時，依狀態碼給一句白話的主句；狀態碼只放在句尾給查問題用
  function httpErrorText(status) {
    if (status === 429) return '操作太頻繁了，請稍等一下再試。';
    if (status === 502 || status === 503 || status === 504) return '音樂庫暫時沒有回應，請稍後再試一次。';
    if (status >= 500) return '音樂庫處理時出錯，這次沒有完成。請再試一次。';
    return `沒有完成，請再試一次。（錯誤代碼 ${status}）`;
  }

  const onlineRow = (r, { onClick, btn } = {}) => P.makeRow({
    key: 'on:' + r.url, title: r.title, sub: P.onlineSub(r),
    dur: r.duration && r.duration !== '未知' ? r.duration : '', btn, onClick,
  });

  // 手動排歌:next=true「下一首播放」放最前面;否則「加入佇列」排在其他手動排的歌之後、
  // 自動排的歌(隨機佇列、播放清單剩下的)之前。同一首歌不會重複出現在手動佇列裡。
  function enqueue(e, title, next) {
    e.user = true;
    const k = P.entryKey(e);
    P.queue = P.queue.filter((x) => !(x.user && P.entryKey(x) === k));
    if (next) P.queue.unshift(e);
    else { const i = P.queue.findIndex((x) => !x.user); P.queue.splice(i < 0 ? P.queue.length : i, 0, e); }
    P.renderNext();
    setStatus(next ? `「${title}」會在下一首播放` : `已把「${title}」加入佇列`);
  }
  // it:音樂庫 { kind:'lib', filename, title } 或線上 { kind:'online', url, title, ... }(播放清單項目同格式)
  const queueItem = (it, next) => enqueue(it.kind === 'lib' ? P.mkLib(it.filename, it.title) : P.mkOnline(it), itemTitle(it), next);
  function addToQueue(r) { enqueue(P.mkOnline(r), r.title, false); }
  function queueMenuItems(it) {
    P.menuItem('play-next', '下一首播放', () => queueItem(it, true));
    P.menuItem('queue-add', '加入佇列', () => queueItem(it, false));
    // 私人歌曲 Bot 讀不到(伺服器也會擋):不提供點給 Bot
    if (P.bots.hasTargets() && !(it.kind === 'lib' && P.isPrivateFile(it.filename))) P.menuItem('bot', '點給 Bot 播放', () => P.bots.sendToBot(it));
  }

  let searchTok = 0; // 連續送出搜尋時,只顯示最後一次的結果
  $('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (P.mode !== 'online') return; // 音樂庫搜尋是即時篩選,不需要送出
    const q = $('search').value.trim();
    P.onlineQuery = q;
    if (!q) return;
    $('search').blur();
    const tok = ++searchTok;
    const box = $('onlineResults');
    box.textContent = '';
    $('onlineHint').textContent = '搜尋中…';
    try {
      const isUrl = /^https?:\/\//i.test(q);
      const j = await apiJson((isUrl ? '/web/api/info?url=' : '/web/api/search?q=') + enc(q));
      if (tok !== searchTok) return; // 已經有更新的搜尋
      box.textContent = '';
      // 依推測:搜尋回 { results:[...] },網址解析回單一物件或 { item }
      const list = j.results || (j.item ? [j.item] : (j.url || j.title ? [j] : []));
      if (!list.length) { $('onlineHint').textContent = `找不到「${q}」。換個關鍵字試試，或直接貼上影片網址。`; return; }
      $('onlineHint').textContent = `找到 ${list.length} 首。`;
      const frag = document.createDocumentFragment();
      for (const r of list) {
        frag.appendChild(onlineRow(r, {
          onClick: () => { P.playlistCtx = null; P.history = []; playOnline(r); },
          btn: [
            { icon: 'plus', title: '加入佇列', onClick: () => addToQueue(r) },
            { icon: 'playlist-add', title: '加入播放清單', onClick: () => P.pickPlaylist([onlineItem(r)]) },
            ...(P.bots.hasTargets() ? [{ icon: 'bot', title: '點給 Bot 播放', onClick: () => P.bots.sendToBot(onlineItem(r)) }] : []),
          ],
        }));
      }
      box.appendChild(frag);
      P.markPlaying();
    } catch (err) {
      if (tok === searchTok) $('onlineHint').textContent = err.message;
    }
  });

  // 播放線上歌曲(交給伺服器的 /web/play 處理)
  function playOnline(item, { pushHistory: ph = true } = {}) {
    dbg('playOnline', item.title);
    const same = P.onlineCurrent && P.entryKey({ kind: 'online', item: P.onlineCurrent }) === P.entryKey({ kind: 'online', item });
    if (ph && !same) P.pushHistory(); // 線上歌曲也進歷史,「上一首」才回得去
    P.currentFile = null;
    P.onlineCurrent = item;
    P.endHandled = false;
    const okey = 'on:' + (item.srcUrl || item.url);
    loadSource(okey, '/web/play?url=' + enc(item.srcUrl || item.url) + (P.WEBM_OK ? '&fmt=webm' : ''));
    if (!P.offlineKeys.has(okey)) setStatus(`正在載入「${item.title || '這首歌'}」，約需幾秒…`, { sticky: true });
    P.setNow({ title: item.title, sub: P.onlineSub(item) });
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
    ? ((P.byFile.get(it.filename) || {}).name || it.title || it.filename.split('/').pop())
    : (it.title || '未知標題');
  const plById = (id) => P.playlists.find((p) => p.id === id);
  function upsertPlaylist(p) {
    const i = P.playlists.findIndex((x) => x.id === p.id);
    if (i >= 0) P.playlists[i] = p; else P.playlists.push(p);
  }

  // ── 離線儲存(IndexedDB)──────────────────────────────
  const offlineSizes = new Map(); // key -> bytes
  const offlineMeta = new Map();  // key -> { title, at, author, platform, duration }(離線歌曲頁用,沒網路也看得到歌名)
  const { offlineGet, offlinePut, offlineDel, offlineClearAll, offlineScan } = window.MLOfflineStore; // 來自 offlineStore.js
  function offlineInit() {
    return offlineScan()
      .then((list) => {
        for (const r of list) {
          P.offlineKeys.add(r.key); offlineSizes.set(r.key, r.size);
          offlineMeta.set(r.key, { title: r.title, at: r.at, author: r.author, platform: r.platform, duration: r.duration });
        }
      })
      .catch(() => {});
  }

  // 載入音源:有離線檔就播離線的(blob URL,可拖曳),沒有才走網路
  P.srcTok = 0; P.blobUrl = null; P.loadAt = 0;

  // ── 背景預載整首 ──
  // 實測 Android 鎖屏時,換歌那一刻才由 <audio> 發出的網路請求可能卡住(stalled)。
  // 頁面在背景時,趁目前這首正在播(系統不會限制網路),先把下一首整個抓成 blob,換歌時直接用 blob URL 播,
  // 完全不碰網路。前景不預載(省流量);只預載音樂庫曲目(線上串流長度未知)。
  P.preload = null;          // { key, url }
  let preloadingKey = '';
  function dropPreload() {
    if (!P.preload) return;
    try { URL.revokeObjectURL(P.preload.url); } catch {}
    P.preload = null;
  }
  function nextLibFilename() {
    const e = P.queue[0];
    if (e) return e.kind === 'lib' ? e.filename : null;
    if (P.shuffle || P.onlineCurrent || !P.currentFile) return null;
    return P.pickNext();
  }
  async function preloadNext() {
    if (!IS_ANDROID || !document.hidden || !P.currentFile) return;
    const fn = nextLibFilename();
    if (!fn || fn === P.currentFile) return;
    const key = 'lib:' + fn;
    if (P.offlineKeys.has(key) || (P.preload && P.preload.key === key) || preloadingKey) return;
    const f = P.byFile.get(fn);
    if (!f || f.size > 40 * 1048576) return;
    preloadingKey = key;
    const t = Date.now();
    try {
      const r = await fetch(P.streamUrl(fn));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      dropPreload();
      P.preload = { key, url: URL.createObjectURL(blob) };
      dbg('預載完成', key, fmtSize(blob.size), (Date.now() - t) + 'ms');
    } catch (err) {
      dbg('預載失敗', key, err);
    } finally {
      preloadingKey = '';
    }
  }
  function loadSource(key, url) {
    const tok = ++P.srcTok;
    dbg('loadSource', key, P.offlineKeys.has(key) ? '(離線)' : '(網路)');
    P.switchPending = true; P.userPaused = false; P.loadAt = Date.now();
    P.waitingNet = ''; P.waitingSince = 0;
    P.lastSrc = { key, url };
    if (P.blobUrl) { URL.revokeObjectURL(P.blobUrl); P.blobUrl = null; }
    if (P.preload && P.preload.key === key) { // 背景預載好的整首:不用再靠背景網路
      P.blobUrl = P.preload.url; P.preload = null;
      dbg('使用預載的檔案', key);
      audio.src = P.blobUrl; P.tryPlay(); return;
    }
    dropPreload();
    if (!P.offlineKeys.has(key)) { audio.src = url; P.tryPlay(); return; }
    if (!(IS_ANDROID && audio.ended)) { audio.removeAttribute('src'); audio.load(); } // 等 blob 讀出來之前不要讓舊的音源繼續播(剛播完時保留,避免元素完全空窗)
    P.pendingPlay = true; P.setSession('playing');
    offlineGet(key).then((blob) => {
      if (tok !== P.srcTok) return;
      if (blob) { P.blobUrl = URL.createObjectURL(blob); audio.src = P.blobUrl; } else audio.src = url;
      P.tryPlay();
    }).catch(() => { if (tok === P.srcTok) { audio.src = url; P.tryPlay(); } });
  }

  Object.assign(P, {
    PL_API, itemKey, onlineItem, itemTitle, plById, offlineSizes, offlineMeta, offlineGet, offlinePut, offlineDel,
    offlineClearAll,
  });
})();
