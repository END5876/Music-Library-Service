'use strict';
// downloader.js
// 離線下載引擎：同時最多 2 首、可整批取消、回報進度。從 player.js 拆出，邏輯不變。
// 與畫面的接觸點全部由 createDownloader(deps) 傳入（不直接碰 DOM、不直接讀 player.js 的變數）：
//   offlineKeys / offlineSizes / dlState  由 player.js 持有的共用狀態（只就地修改，不重新指派）
//   itemKey / streamUrl / enc             網址與鍵值工具
//   offlinePut                            寫入 IndexedDB（來自 offlineStore.js）
//   setStatus / showLogin / refreshDl     提示訊息、登入視窗、重繪下載狀態
// 回傳 { enqueueDownloads, cancelDownloads, dlBusy, getBatch }；getBatch() 取得目前批次 { total, done, failed }。
// 載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  function createDownloader({ offlineKeys, offlineSizes, dlState, itemKey, streamUrl, enc, offlinePut, setStatus, showLogin, refreshDl }) {
    // ── 下載(最多同時 2 個,可整批取消)──────────────────
    const DL_CONCURRENCY = 2;
    const dlQueue = [];
    let dlActive = 0, dlAbort = null, dlFailMsg = '';
    let dlBatch = { total: 0, done: 0, failed: 0 };
    const dlBusy = () => dlActive > 0 || dlQueue.length > 0;

    function enqueueDownloads(items) {
      const fresh = items.filter((it) => { const k = itemKey(it); return !offlineKeys.has(k) && !dlState.has(k); });
      if (!fresh.length) { setStatus('這些歌曲已經下載過(或正在下載)'); return; }
      if (!dlAbort) dlAbort = new AbortController();
      for (const it of fresh) { dlState.set(itemKey(it), { pct: 0, active: false }); dlQueue.push(it); }
      dlBatch.total += fresh.length;
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      setStatus(`開始下載 ${fresh.length} 首…`);
      refreshDl();
      pumpDownloads();
    }

    function pumpDownloads() {
      while (dlAbort && dlActive < DL_CONCURRENCY && dlQueue.length) {
        const it = dlQueue.shift();
        dlActive++;
        downloadOne(it, dlAbort.signal)
          .then(() => { dlBatch.done++; })
          .catch((err) => {
            if (err && err.name === 'AbortError') return;
            dlBatch.failed++;
            const name = err && (err.name || (err.target && err.target.error && err.target.error.name));
            dlFailMsg = name === 'QuotaExceededError' ? '儲存空間不足' : (err && err.message) || '下載失敗';
            if (name === 'QuotaExceededError') cancelDownloads(dlFailMsg);
          })
          .finally(() => {
            dlActive--;
            if (!dlBusy()) finishBatch(); else pumpDownloads();
            refreshDl();
          });
      }
    }

    async function downloadOne(it, signal) {
      const key = itemKey(it);
      const st = dlState.get(key);
      if (st) st.active = true;
      try {
        const url = it.kind === 'lib' ? streamUrl(it.filename) : '/web/play?url=' + enc(it.srcUrl || it.url);
        const r = await fetch(url, { signal });
        if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('登入已過期'); }
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
        const total = Number(r.headers.get('Content-Length')) || 0;
        const reader = r.body.getReader();
        const chunks = []; let got = 0, lastUi = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length;
          if (st && total) st.pct = Math.min(99, Math.floor(got / total * 100));
          const t = Date.now();
          if (t - lastUi > 300) { lastUi = t; refreshDl(); }
        }
        if (!got) throw new Error('下載到空檔案');
        const blob = new Blob(chunks, { type: r.headers.get('Content-Type') || 'audio/mpeg' });
        await offlinePut({ key, blob, size: blob.size, title: it.title || '', at: Date.now() });
        offlineKeys.add(key); offlineSizes.set(key, blob.size);
      } finally {
        dlState.delete(key);
      }
    }

    function finishBatch() {
      if (!dlBatch.total) return; // 已被取消
      const { done, failed } = dlBatch;
      setStatus(`⬇ 下載完成:${done} 首` + (failed ? `,失敗 ${failed} 首(${dlFailMsg})` : ''));
      dlBatch = { total: 0, done: 0, failed: 0 };
      dlAbort = null; dlFailMsg = '';
    }

    function cancelDownloads(msg) {
      if (dlAbort) dlAbort.abort();
      for (const it of dlQueue) dlState.delete(itemKey(it));
      dlQueue.length = 0;
      dlBatch = { total: 0, done: 0, failed: 0 };
      dlAbort = null;
      setStatus(msg || '已取消下載');
      refreshDl();
    }

    return { enqueueDownloads, cancelDownloads, dlBusy, getBatch: () => dlBatch };
  }

  window.MLDownloader = { createDownloader };
})();
