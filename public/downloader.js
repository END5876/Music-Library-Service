'use strict';
// downloader.js
// 離線下載引擎：同時最多 2 首、可整批取消、回報進度。從 player.js 拆出，邏輯不變。
// 與畫面的接觸點全部由 createDownloader(deps) 傳入（不直接碰 DOM、不直接讀 player.js 的變數）：
//   offlineKeys / offlineSizes / offlineMeta / dlState  由 player.js 持有的共用狀態（只就地修改，不重新指派）
//   itemKey / streamUrl / enc             網址與鍵值工具
//   offlinePut                            寫入 IndexedDB（來自 offlineStore.js）
//   setStatus / showLogin / refreshDl     提示訊息、登入視窗、重繪下載狀態
// 回傳 { enqueueDownloads, cancelDownloads, dlBusy, getBatch }；getBatch() 取得目前批次 { total, done, failed }。
// 載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  function createDownloader({ offlineKeys, offlineSizes, offlineMeta, dlState, itemKey, streamUrl, enc, offlinePut, setStatus, showLogin, refreshDl }) {
    // ── 下載(最多同時 2 個,可整批取消)──────────────────
    const DL_CONCURRENCY = 2;
    // 線上歌曲走 /web/play,和正在播的線上歌曲共用每人串流上限(預設 2):一次只下載一首線上歌曲,音樂庫的不受限
    const DL_ONLINE_CONCURRENCY = 1;
    const DL_BUSY_RETRIES = 3;
    const dlQueue = [];
    let dlActive = 0, dlOnline = 0, dlAbort = null, dlFailMsg = '';
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
        // 線上名額已滿:先挑後面的音樂庫歌曲,沒有就等線上那首下載完
        const i = dlOnline < DL_ONLINE_CONCURRENCY ? 0 : dlQueue.findIndex((x) => x.kind === 'lib');
        if (i < 0) break;
        const [it] = dlQueue.splice(i, 1);
        const online = it.kind !== 'lib';
        dlActive++;
        if (online) dlOnline++;
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
            if (online) dlOnline--;
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
        let r;
        for (let attempt = 0; ; attempt++) {
          r = await fetch(url, { signal });
          // 線上串流數已滿(例如正在播線上歌曲)是暫時的:稍等再試,不要直接算失敗(沒裝 yt-dlp 的 503 不重試)
          if (r.status !== 503 || it.kind === 'lib' || attempt >= DL_BUSY_RETRIES) break;
          const j = await r.json().catch(() => ({}));
          if (/未安裝/.test(j.error || '')) throw new Error(j.error);
          await wait(5000 * (attempt + 1), signal);
        }
        if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('登入已過期'); }
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
        const total = Number(r.headers.get('Content-Length')) || 0;
        // 資料流經計數器只更新進度、不留在 JS 陣列裡，由瀏覽器直接組成 Blob
        // (Blob 存在 JS heap 之外，可能暫存到磁碟；以前先收集 chunks 再 new Blob，組裝時整首會在記憶體裡佔兩份)
        let got = 0, lastUi = 0;
        const counter = new TransformStream({
          transform(chunk, ctl) {
            got += chunk.length;
            if (st && total) st.pct = Math.min(99, Math.floor(got / total * 100));
            const t = Date.now();
            if (t - lastUi > 300) { lastUi = t; refreshDl(); }
            ctl.enqueue(chunk);
          },
        });
        const type = r.headers.get('Content-Type') || 'audio/mpeg';
        const blob = await new Response(r.body.pipeThrough(counter), { headers: { 'Content-Type': type } }).blob();
        if (!got) throw new Error('下載到空檔案');
        // 🐛 線上即時串流沒有 Content-Length,伺服器中途斷掉時仍會正常結束 response:比對實際長度與歌曲長度,短太多就當失敗(之後可重新下載)
        if (it.kind !== 'lib' && !total) {
          const want = parseDur(it.duration);
          const have = want ? await blobDuration(blob) : 0;
          if (have && have < want * 0.9 && want - have > 5) throw new Error('下載不完整(串流中斷)');
        }
        const meta = { title: it.title || '', at: Date.now(), author: it.author || '', platform: it.platform || '', duration: it.duration || '' };
        await offlinePut({ key, blob, size: blob.size, ...meta });
        offlineKeys.add(key); offlineSizes.set(key, blob.size); offlineMeta.set(key, meta);
      } finally {
        dlState.delete(key);
      }
    }

    // 可被取消的等待:取消下載時立刻以 AbortError 結束(不算失敗)
    function wait(ms, signal) {
      return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
        const t = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    }

    // 「3:45」「1:02:03」→ 秒數;「未知」或空白 → 0(不檢查)
    function parseDur(s) {
      const parts = String(s || '').split(':');
      if (parts.some((p) => !/^\d+$/.test(p.trim()))) return 0;
      return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
    }

    // 讀出 Blob 實際可播放的秒數;讀不到(格式不支援、逾時)回 0,不擋下載
    function blobDuration(blob) {
      return new Promise((resolve) => {
        const a = new Audio();
        const u = URL.createObjectURL(blob);
        const done = (d) => {
          clearTimeout(timer);
          a.onloadedmetadata = a.ondurationchange = a.onerror = null;
          a.removeAttribute('src'); a.load();
          URL.revokeObjectURL(u);
          resolve(isFinite(d) && d > 0 ? d : 0);
        };
        const timer = setTimeout(() => done(0), 5000);
        a.preload = 'metadata';
        a.onloadedmetadata = () => {
          if (isFinite(a.duration)) { done(a.duration); return; }
          // 即時封裝的 WebM 檔頭沒有長度(Infinity):跳到極遠處讓瀏覽器掃到結尾,算出真正長度
          a.ondurationchange = () => { if (isFinite(a.duration)) done(a.duration); };
          a.currentTime = 1e101;
        };
        a.onerror = () => done(0);
        a.src = u;
      });
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
