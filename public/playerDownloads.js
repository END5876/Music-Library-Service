'use strict';
// playerDownloads.js — 播放器：離線下載、離線模式、更新提示。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, enc, fmtSize, setStatus, askConfirm } = window.MLUi;
  const { dbg } = window.MLDebug;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    updateNetState, advanceOffline, removeOffline, removeOfflineUndoable, toggleOffline, refreshDl, applyDlButton,
    updateOfflineInfo, updateQuota, updatePlDetailButtons, registerSW, isBusy, clearDataCaches,
  });

  // ── 下載(引擎在 downloader.js;最多同時 2 首,可整批取消)──────
  const { enqueueDownloads: enqueueRaw, cancelDownloads, dlBusy, getBatch } = window.MLDownloader.createDownloader({
    offlineKeys: P.offlineKeys, offlineSizes: P.offlineSizes, offlineMeta: P.offlineMeta, dlState: P.dlState, itemKey: P.itemKey, streamUrl: P.streamUrl, enc, offlinePut: P.offlinePut, setStatus, showLogin: P.showLogin, refreshDl,
  });

  const enqueueDownloads = (items) => enqueueRaw(items.map((it) =>
    it.kind === 'lib' && !it.duration && P.libDur(P.byFile.get(it.filename)) ? { ...it, duration: P.libDur(P.byFile.get(it.filename)) } : it));

  // ── 離線模式:沒網路(或連不到伺服器)時顯示提示、淡化沒下載的歌,點了直接說明 ──
  P.serverDown = false;
  const isOffline = () => navigator.onLine === false || P.serverDown;
  const entryPlayable = (e) => !isOffline() || P.offlineKeys.has(P.entryKey(e));
  // 橫幅分兩種:手機沒有網路／有網路但連不上音樂庫(伺服器更新或當掉)。後者每 30 秒探測一次,連上就自動恢復
  let probeTimer = 0;
  function updateNetState() {
    const off = isOffline();
    const noNet = navigator.onLine === false;
    document.body.classList.toggle('is-offline', off);
    $('netBanner').hidden = !off;
    $('netText').textContent = noNet
      ? '目前沒有網路，只能播放離線歌曲。'
      : '暫時連不上音樂庫，可能正在更新。先播放已下載的歌曲，連上後會自動恢復。';
    $('netRetry').hidden = noNet;
    $('netGoOff').hidden = P.mode === 'offline' || !P.offlineKeys.size;
    if (P.serverDown && !noNet && !probeTimer) probeTimer = setInterval(() => probeServer(false), 30 * 1000);
    else if ((!P.serverDown || noNet) && probeTimer) { clearInterval(probeTimer); probeTimer = 0; }
  }
  // 伺服器重啟時前面的 nginx 會回 502／503:有回應不代表恢復,要看狀態碼
  async function serverOk() {
    if (navigator.onLine === false) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try { const r = await fetch('/health?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal }); return r.status < 500; }
    catch { return false; }
    finally { clearTimeout(timer); }
  }
  async function probeServer(manual) {
    if (manual) $('netRetry').disabled = true;
    const ok = await serverOk();
    if (manual) $('netRetry').disabled = false;
    if (!P.serverDown) return;
    if (ok) {
      P.serverDown = false; updateNetState();
      setStatus('已重新連上音樂庫');
      P.loadList(null, { quiet: true });
    } else if (manual) setStatus('還是連不上音樂庫，30 秒後會再試一次');
  }
  $('netRetry').addEventListener('click', () => probeServer(true));
  window.addEventListener('offline', () => {
    updateNetState();
    const c = P.currentEntry();
    if (c && !audio.paused && !P.offlineKeys.has(P.entryKey(c))) {
      setStatus('網路中斷了，這首歌沒有下載，播放可能會停止', {
        action: P.offlineKeys.size ? { label: '改播離線歌曲', fn: () => { P.setMode('offline'); P.playCtx(P.OFF_CTX, P.offView, null, false); } } : null,
      });
    } else setStatus('網路中斷了，目前只能播放已下載的歌曲');
  });
  window.addEventListener('online', () => {
    const wasDown = P.serverDown; P.serverDown = false;
    updateNetState();
    setStatus('已恢復連線');
    if (wasDown || !P.all.length) P.loadList();
  });
  $('netGoOff').addEventListener('click', () => P.setMode('offline'));
  // 離線時點到沒下載的歌:在列自己的點擊處理之前攔下來
  document.addEventListener('click', (e) => {
    if (!isOffline()) return;
    const row = e.target.closest('.row[data-key]');
    if (!row || row.classList.contains('offline') || row.closest('.selecting')) return;
    if (e.target.closest('.rbtn, .grip')) return; // ⋮ 選單、拖曳照常可用
    e.stopPropagation(); e.preventDefault();
    setStatus('目前離線，這首歌還沒下載');
  }, true);
  // 離線時「下一首」:跳過沒下載的歌,在目前的播放範圍裡找下一首已下載的
  function advanceOffline() {
    const qi = P.queue.findIndex(entryPlayable);
    if (qi >= 0) { const [e] = P.queue.splice(qi, 1); P.playEntry(e); return; }
    const pool = P.playlistCtx ? P.playlistCtx.items.filter(P.ctxPlayable).map(P.ctxEntry) : P.view.map((f) => P.mkLib(f.filename, f.name));
    const cur = P.currentEntry(), ck = cur ? P.entryKey(cur) : null;
    const ok = pool.filter((e) => entryPlayable(e) && P.entryKey(e) !== ck);
    if (!ok.length) { setStatus('目前離線，沒有其他已下載的歌曲'); return; }
    let next;
    if (P.shuffle) next = ok[Math.floor(Math.random() * ok.length)];
    else {
      const ci = pool.findIndex((e) => P.entryKey(e) === ck);
      next = pool.slice(ci + 1).find((e) => entryPlayable(e) && P.entryKey(e) !== ck) || (P.repeat === 'all' ? ok[0] : null);
    }
    if (!next) { setStatus('目前離線，後面沒有已下載的歌曲'); return; }
    P.playEntry(next);
  }

  async function removeOffline(items) {
    for (const it of items) {
      const k = P.itemKey(it);
      if (!P.offlineKeys.has(k)) continue;
      try { await P.offlineDel(k); P.offlineKeys.delete(k); P.offlineSizes.delete(k); P.offlineMeta.delete(k); } catch {}
    }
    refreshDl();
  }

  // 移除單首離線檔案:先把音檔留在記憶體,提示裡按「復原」就寫回去(不必重新下載)
  async function removeOfflineUndoable(it) {
    const k = P.itemKey(it);
    if (!P.offlineKeys.has(k)) return;
    let blob = null;
    try { blob = await P.offlineGet(k); } catch {}
    const size = P.offlineSizes.get(k) || 0, meta = P.offlineMeta.get(k) || {};
    await removeOffline([it]);
    setStatus('已移除離線檔案', { action: blob && { label: '復原', fn: async () => {
      try {
        await P.offlinePut({ key: k, blob, size, ...meta });
        P.offlineKeys.add(k); P.offlineSizes.set(k, size); P.offlineMeta.set(k, meta);
        refreshDl(); setStatus('已復原');
      } catch (err) { setStatus('沒有復原成功：' + (err.message || err), { type: 'error' }); }
    } } });
  }

  function toggleOffline(it) {
    const k = P.itemKey(it);
    if (P.offlineKeys.has(k)) removeOfflineUndoable(it);
    else if (P.dlState.has(k)) setStatus('下載中，請稍候');
    else enqueueDownloads([it]);
  }

  // ── 下載狀態的畫面更新(合併成每個 frame 最多一次)──────
  let dlRaf = 0;
  function refreshDl() {
    if (dlRaf) return;
    dlRaf = requestAnimationFrame(() => { dlRaf = 0; paintDl(); });
  }
  function applyDlButton(b) {
    const k = b.dataset.dlkey, st = P.dlState.get(k);
    const off = P.offlineKeys.has(k);
    b.classList.toggle('done', off);
    b.style.fontSize = '';
    if (off) { b.innerHTML = '<svg><use href="#i-downloaded"/></svg>'; b.title = '已下載，點一下移除'; }
    else if (st) {
      b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
      b.style.fontSize = '11px';
      b.title = st.active ? '下載中' : '等待下載';
    } else { b.innerHTML = '<svg><use href="#i-download"/></svg>'; b.title = '下載離線'; }
  }
  let offSig = '', quotaText = '';
  function updateOfflineInfo() {
    const n = P.offlineKeys.size;
    let bytes = 0; P.offlineSizes.forEach((v) => { bytes += v; });
    $('offlineInfo').textContent = (n ? `已下載 ${n} 首，共 ${fmtSize(bytes)}` : '尚未下載任何歌曲') + quotaText;
    $('offlineClear').hidden = n === 0;
    $('offCount').textContent = n ? `${n} 首` : '';
    // 內容有變(下載完成/移除)才重畫離線歌曲頁
    const sig = n + ':' + bytes;
    if (sig !== offSig) { offSig = sig; if (P.mode === 'offline') P.renderOffline(); updateQuota(); }
  }
  // 裝置剩餘空間(瀏覽器估算值,不支援就不顯示)
  function updateQuota() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(({ usage = 0, quota = 0 }) => {
      quotaText = quota ? `\n大約還能再下載 ${fmtSize(Math.max(0, quota - usage))}` : '';
      const n = P.offlineKeys.size;
      let bytes = 0; P.offlineSizes.forEach((v) => { bytes += v; });
      $('offlineInfo').textContent = (n ? `已下載 ${n} 首，共 ${fmtSize(bytes)}` : '尚未下載任何歌曲') + quotaText;
    }).catch(() => {});
  }
  function updatePlDetailButtons() {
    const p = P.plOpen && P.plById(P.plOpen);
    if (!p) return;
    const nOff = p.items.filter((it) => P.offlineKeys.has(P.itemKey(it))).length;
    $('plMeta').textContent = `${p.items.length} 首歌曲` + (nOff ? `，已下載 ${nOff} 首` : '');
    const b = $('plDownloadAll');
    const dls = p.items.filter(P.plDownloadable);
    const busy = dlBusy(), allOff = dls.length > 0 && dls.every((it) => P.offlineKeys.has(P.itemKey(it)));
    b.classList.toggle('done', !busy && allOff);
    b.style.fontSize = '';
    if (busy) { b.textContent = `${getBatch().done + getBatch().failed}/${getBatch().total}`; b.style.fontSize = '12px'; b.title = '取消下載'; }
    else { b.innerHTML = `<svg><use href="#i-${allOff ? 'downloaded' : 'download'}"/></svg>`; b.title = allOff ? '已下載，點一下移除' : '下載離線'; }
  }
  function paintDl() {
    document.querySelectorAll('.row[data-key]').forEach((r) => r.classList.toggle('offline', P.offlineKeys.has(r.dataset.key)));
    document.querySelectorAll('[data-dlkey]').forEach(applyDlButton);
    document.querySelectorAll('[data-dlmenu]').forEach(P.applyMoreButton);
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
            if (worker.state === 'installed' && navigator.serviceWorker.controller) checkUpdateNeeded();
          });
        });
      })
      .catch((err) => dbg('SW 註冊失敗', err && err.message));
  }
  // 有新版本:播放中就請使用者等暫停或播完這首,不主動打斷音樂
  // 正在播放或上傳中(重新載入、切換靜音保活前先確認)
  function isBusy() { return !audio.paused || P.uploader.busy(); }
  function paintUpdateBanner() {
    if ($('updBanner').hidden) return;
    $('updText').textContent = audio.paused ? '有新版本。重新載入就能套用。' : '有新版本，暫停或播完這首後重新載入。';
  }
  // 新的 Service Worker 裝好了:比對新 sw.js 的 VERSION 和這份頁面的版本,真的比較舊才顯示橫幅
  async function checkUpdateNeeded() {
    const mine = (document.querySelector('meta[name="ml-version"]') || {}).content || '';
    try {
      const latest = (await fetch('/player-sw.js', { method: 'HEAD', cache: 'no-store' })).headers.get('X-ML-Version');
      if (latest && mine && latest === mine) return;
    } catch { /* 查不到就照舊提示 */ }
    $('updBanner').hidden = false;
    paintUpdateBanner();
  }
  audio.addEventListener('play', paintUpdateBanner);
  audio.addEventListener('pause', paintUpdateBanner);
  $('updReload').addEventListener('click', async () => {
    if (isBusy() && !await askConfirm('現在重新載入？',
      P.uploader.busy() ? '正在播放的歌會中斷，還沒傳完的上傳也會停止。' : '正在播放的歌會中斷。', { ok: '重新載入' })) return;
    location.reload();
  });
  function clearDataCaches() {
    if (!window.caches) return Promise.resolve();
    return caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('ml-data-')).map((k) => caches.delete(k))))
      .catch(() => {});
  }

  Object.assign(P, {
    cancelDownloads, dlBusy, enqueueDownloads, isOffline,
  });
})();
