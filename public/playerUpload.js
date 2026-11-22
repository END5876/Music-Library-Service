'use strict';
// playerUpload.js — 播放器裡的「上傳」頁籤（只有管理員看得到；伺服器端一樣只放行管理員，見 webplayer/uploadRoutes.js）
//   - 多選或拖放多個音檔，一首接一首全部傳上去；伺服器收到就排進背景佇列，一次處理一首（VPS CPU 不多）。
//     前端每 3 秒問一次處理進度（GET /web/api/upload/jobs）；傳完就可以關掉網頁，重新打開會接回進度
//   - 放進共用音樂庫，或私人上傳（.private/<自己的 ID>/，其他帳號、Bot 都看不到）；私人上傳可選「保留原檔、不轉檔」
//   - 開始前整批預檢（格式、單檔上限、私人配額、磁碟水位），頁面上方顯示目前用量
// 對外：window.MLUpload.create({ onUploaded, onPending, onFailed }) → { init(), show(), hide(), busy(), showFailed() }
//   init()：登入確認是管理員後呼叫，背景接回伺服器上的處理進度（不必打開頁籤）
//   onPending(n, failed)：還在上傳／排隊／處理的首數，以及使用者還沒看過的失敗首數（頁籤徽章用）
//   onFailed(n)：不在上傳頁時有新的失敗，n＝還沒看過的失敗首數（顯示不自動消失的提示）
//   showFailed()：清單只顯示失敗的項目（提示上的「查看」）

(() => {
  const $ = (id) => document.getElementById(id);
  const ACCEPT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'];
  const extOf = (name) => (String(name).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const stemOf = (name) => String(name).replace(/\.[^.]+$/, '');

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  const RESULT_TEXT = {
    transcode: () => '已轉成 MP3 並統一音量',
    mp3gain: (j) => `保留原始 MP3（${j.kbps} kbps），無損調整音量 ${j.gainDb > 0 ? '+' : ''}${j.gainDb} dB`,
    copy: (j) => `保留原始 MP3（${j.kbps} kbps），未重新編碼`,
    original: () => '原檔保存，未轉檔',
  };

  function create({ onUploaded, onPending, onFailed }) {
    let items = [];          // { id, file?, name, size, title, status, pct, msg, jobId? }；file 為 null＝重新整理前上傳、只剩伺服器紀錄
    let pollTimer = 0;
    let seq = 0;
    let running = false;
    let target = 'library';
    let preflightTimer = 0;
    let preflightTok = 0;
    let currentReq = null;    // 正在傳的那一首（「停止上傳」時中斷它）
    let stopRequested = false;
    let visible = false;      // 上傳頁是否開著
    let unseenFailed = 0;     // 上傳頁沒開著時新出現的失敗首數
    let onlyFailed = false;   // 清單只顯示失敗的項目

    const listEl = $('upList');
    const original = () => target === 'private' && $('upOriginal').checked;

    // ── 用量 ──
    async function loadUsage() {
      let u;
      try { const r = await fetch('/web/api/upload/usage'); if (!r.ok) return; u = await r.json(); } catch { return; }
      const box = $('upUsage'); box.textContent = '';
      const card = (label, used, limit, note) => {
        const d = document.createElement('div'); d.className = 'up-meter';
        const pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0;
        d.innerHTML = '<div class="up-meter-top"><b></b><span></span></div>' + (limit ? '<div class="up-bar"><i></i></div>' : '') + '<small></small>';
        d.querySelector('b').textContent = label;
        d.querySelector('span').textContent = limit ? `${fmtBytes(used)} / ${fmtBytes(limit)}` : fmtBytes(used);
        if (limit) {
          const bar = d.querySelector('i'); bar.style.width = pct + '%';
          if (pct >= 90) d.classList.add('warn');
        }
        d.querySelector('small').textContent = note || '';
        box.appendChild(d);
      };
      card('音樂庫', u.library.bytes, 0, `${u.library.files.toLocaleString()} 首，不會被自動清除`);
      card('線上快取', u.cache.bytes, u.cache.limitBytes, `${u.cache.files.toLocaleString()} 首，超過上限時自動清掉最久沒聽的`);
      card('私人空間', u.private.bytes, u.private.quotaBytes, `${u.private.files.toLocaleString()} 首，只有你看得到`);
      if (u.disk.freeBytes != null) {
        card('磁碟剩餘', u.disk.freeBytes, 0, `低於 ${fmtBytes(u.disk.minFreeBytes)} 時停止接受上傳`);
        if (u.disk.freeBytes < u.disk.minFreeBytes * 1.5) box.lastChild.classList.add('warn');
      }
      $('upLimitNote').textContent = `單檔上限 ${fmtBytes(u.maxUploadBytes)}`;
    }

    // ── 預檢（選完檔案、切換選項後；停頓 300ms 再送）──
    function schedulePreflight() {
      clearTimeout(preflightTimer);
      preflightTimer = setTimeout(preflight, 300);
    }
    async function preflight() {
      const pending = items.filter((it) => it.status === 'pending' || it.status === 'blocked');
      const box = $('upSummary');
      if (!pending.length) { box.hidden = true; syncButtons(); return; }
      const tok = ++preflightTok;
      let j;
      try {
        const r = await fetch('/web/api/upload/preflight', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target, mode: original() ? 'original' : 'transcode', files: pending.map((it) => ({ name: it.name, size: it.size })) }),
        });
        j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      } catch (err) {
        if (tok !== preflightTok) return;
        box.hidden = false; box.className = 'up-summary warn'; box.textContent = '沒辦法先檢查這些檔案：' + err.message;
        return syncButtons();
      }
      if (tok !== preflightTok) return;
      pending.forEach((it, i) => {
        const res = j.items[i];
        if (res && !res.ok) { it.status = 'blocked'; it.msg = res.error; }
        else if (it.status === 'blocked') { it.status = 'pending'; it.msg = ''; }
        if (res && res.ok) it.estimate = res.estimatedBytes;
      });
      const okCount = pending.filter((it) => it.status === 'pending').length;
      box.hidden = false;
      box.className = 'up-summary' + (j.ok ? '' : ' warn');
      box.textContent = '';
      const line = document.createElement('div');
      line.textContent = `${okCount} 首待上傳，處理後預估約 ${fmtBytes(j.estimatedBytes)}` + (original() ? '（保留原檔）' : '');
      box.appendChild(line);
      for (const w of j.warnings || []) {
        const d = document.createElement('div'); d.className = 'up-warn';
        d.innerHTML = '<svg aria-hidden="true"><use href="#i-alert"/></svg>';
        d.append(w); box.appendChild(d);
      }
      render();
    }

    // ── 清單 ──
    function addFiles(fileList) {
      for (const file of fileList) {
        const ok = ACCEPT.includes(extOf(file.name));
        items.push({ id: ++seq, file, name: file.name, size: file.size, title: stemOf(file.name), status: ok ? 'pending' : 'blocked', pct: 0, msg: ok ? '' : '不支援的格式' });
      }
      render();
      schedulePreflight();
    }

    const STATUS_LABEL = { pending: '等待上傳', uploading: '上傳中', queued: '排隊處理中', processing: '伺服器處理中', done: '完成', error: '失敗', blocked: '略過' };
    // 有新的失敗：上傳頁開著時清單上就看得到；沒開著時記下來，交給播放器顯示不自動消失的提示
    function noteFailures(n) {
      if (!n || visible) return;
      unseenFailed += n;
      if (onFailed) onFailed(unseenFailed);
    }

    function render() {
      listEl.textContent = '';
      const failedCount = items.filter((it) => it.status === 'error').length;
      if (onlyFailed && !failedCount) onlyFailed = false;
      if (onlyFailed) {
        const bar = document.createElement('li');
        bar.className = 'up-filter';
        bar.innerHTML = '<span></span><button class="btn btn-sm btn-secondary" type="button">顯示全部</button>';
        bar.querySelector('span').textContent = `只顯示沒有加進音樂庫的 ${failedCount} 首`;
        bar.querySelector('button').addEventListener('click', () => { onlyFailed = false; render(); });
        listEl.appendChild(bar);
      }
      for (const it of items) {
        if (onlyFailed && it.status !== 'error') continue;
        const li = document.createElement('li');
        li.className = 'up-item ' + it.status;
        li.innerHTML = '<div class="up-main"><input class="up-title" type="text" maxlength="180" aria-label="曲名"><div class="up-meta"><span class="up-state"></span><span class="up-size"></span><span class="up-msg"></span></div><div class="up-bar"><i></i></div></div><button class="btn-icon ghost up-act"></button>';
        const input = li.querySelector('.up-title');
        input.value = it.title;
        input.disabled = it.status !== 'pending' && it.status !== 'error';
        input.addEventListener('input', () => { it.title = input.value; });
        li.querySelector('.up-state').textContent = STATUS_LABEL[it.status] + (it.status === 'uploading' ? ` ${it.pct}%` : '');
        li.querySelector('.up-size').textContent = fmtBytes(it.size) + (it.estimate != null && it.status === 'pending' && it.estimate !== it.size ? ` → 約 ${fmtBytes(it.estimate)}` : '');
        li.querySelector('.up-msg').textContent = it.msg || '';
        li.querySelector('.up-bar i').style.width = (['done', 'queued', 'processing'].includes(it.status) ? 100 : it.pct) + '%';
        const act = li.querySelector('.up-act');
        if (it.status === 'error' && it.file) {
          act.innerHTML = '<svg><use href="#i-repeat"/></svg>'; act.title = '重試'; act.setAttribute('aria-label', '重試');
          act.addEventListener('click', () => { it.status = 'pending'; it.pct = 0; it.msg = ''; it.jobId = null; render(); schedulePreflight(); });
        } else if (it.status === 'queued' && it.jobId) {
          // 排隊中的可以取消：伺服器刪掉暫存的原檔，不會放進音樂庫
          act.innerHTML = '<svg><use href="#i-close"/></svg>'; act.title = '取消這首'; act.setAttribute('aria-label', '取消這首');
          act.addEventListener('click', () => cancelJob(it, act));
        } else if (['uploading', 'queued', 'processing'].includes(it.status)) {
          act.hidden = true;
        } else {
          act.innerHTML = '<svg><use href="#i-close"/></svg>'; act.title = '移除'; act.setAttribute('aria-label', '移除');
          act.addEventListener('click', () => { items = items.filter((x) => x !== it); render(); schedulePreflight(); });
        }
        listEl.appendChild(li);
      }
      $('upEmpty').hidden = items.length > 0;
      syncButtons();
    }

    function syncButtons() {
      const pending = items.filter((it) => it.status === 'pending').length;
      // 上傳中這顆按鈕變成「停止上傳」：中斷正在傳的那首，剩下的回到「等待上傳」
      const start = $('upStart');
      start.disabled = running ? stopRequested : !pending;
      start.classList.toggle('btn-primary', !running);
      start.classList.toggle('btn-secondary', running);
      start.querySelector('use').setAttribute('href', running ? '#i-stop' : '#i-upload');
      start.lastChild.textContent = running ? (stopRequested ? '停止中…' : '停止上傳') : pending ? `開始上傳（${pending} 首）` : '開始上傳';
      $('upClear').hidden = !items.some((it) => it.status === 'done' || it.status === 'blocked' || (it.status === 'error' && !it.file));
      const waitingServer = items.filter((it) => it.status === 'queued' || it.status === 'processing').length;
      if (onPending) onPending(waitingServer + items.filter((it) => it.status === 'uploading').length, unseenFailed);
      $('upServerNote').hidden = !waitingServer;
      $('upServerNote').textContent = `伺服器還有 ${waitingServer} 首在排隊處理。傳完就可以關掉網頁，處理會繼續。`;
      for (const el of document.querySelectorAll('#upTarget .chip, #upOriginal, #upFolder, #upFiles')) el.disabled = running;
      $('upDrop').classList.toggle('disabled', running);
    }

    function syncTarget() {
      document.querySelectorAll('#upTarget .chip').forEach((b) => b.classList.toggle('active', b.dataset.target === target));
      $('upOriginalLine').hidden = target !== 'private';
      $('upFolder').placeholder = target === 'private' ? '留空＝不分類' : '例如：uploads（留空＝不分類）';
      $('upTargetHint').textContent = target === 'private'
        ? '只有你聽得到，會計入私人空間配額。'
        : '所有登入的人和 Bot 都能播放。';
      $('upModeHint').textContent = original()
        ? '原檔照存，不統一音量，會佔比較多空間。'
        : '會轉成 MP3 並統一音量。';
    }

    // ── 上傳(逐一)──
    function uploadOne(it) {
      return new Promise((resolve) => {
        it.status = 'uploading'; it.pct = 0; it.msg = ''; it.sent = false; render();
        const req = new XMLHttpRequest();
        currentReq = req;
        req.open('POST', '/web/api/upload');
        // HTTP header 只能可靠地傳 ASCII:URL 編碼保留中文曲名與資料夾名稱
        req.setRequestHeader('x-upload-filename', encodeURIComponent(it.file.name));
        req.setRequestHeader('x-upload-title', encodeURIComponent(it.title.trim() || it.file.name));
        req.setRequestHeader('x-upload-folder', encodeURIComponent($('upFolder').value.trim()));
        req.setRequestHeader('x-upload-target', target);
        req.setRequestHeader('x-upload-mode', original() ? 'original' : 'transcode');
        let lastPaint = 0;
        req.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          it.pct = Math.round(e.loaded / e.total * 100);
          const now = Date.now();
          if (now - lastPaint > 200) { lastPaint = now; render(); }
        };
        // 檔案已經傳完:伺服器可能已經排進佇列,這時「停止上傳」不中斷這首,等回應回來再停
        req.upload.onload = () => { it.pct = 100; it.msg = '已傳完，等伺服器確認…'; it.sent = true; render(); };
        req.onerror = () => { currentReq = null; it.status = 'error'; it.msg = navigator.onLine === false ? '網路斷了，連上後按「重試」。' : '連線中斷，請按「重試」。'; noteFailures(1); render(); resolve(); };
        // 使用者按了「停止上傳」：這首回到等待上傳，之後可以再開始
        req.onabort = () => { currentReq = null; it.status = 'pending'; it.pct = 0; it.msg = ''; render(); resolve(); };
        req.onload = () => {
          currentReq = null;
          let j = {};
          try { j = JSON.parse(req.responseText); } catch {}
          if (req.status === 202 && j.job) {
            it.jobId = j.job.id;
            applyJob(it, j.job);
            schedulePoll(1000);
          } else {
            it.status = 'error';
            it.msg = req.status === 401 ? '登入已過期。重新登入後按「重試」，選好的檔案都還在。'
        : (j.error || (req.status >= 500 ? '伺服器處理時出錯，請按「重試」。' : `沒有上傳成功，請按「重試」。（錯誤代碼 ${req.status}）`));
            noteFailures(1);
          }
          render(); resolve();
        };
        req.send(it.file);
      });
    }

    function stopAll() {
      if (!running || stopRequested) return;
      stopRequested = true;
      syncButtons();
      const it = items.find((x) => x.status === 'uploading');
      if (currentReq && !(it && it.sent)) currentReq.abort();
    }

    async function cancelJob(it, btn) {
      btn.disabled = true;
      let r, j = {};
      try { r = await fetch(`/web/api/upload/jobs/${encodeURIComponent(it.jobId)}/cancel`, { method: 'POST' }); j = await r.json().catch(() => ({})); } catch { r = null; }
      if (r && (r.ok || r.status === 404)) {
        items = items.filter((x) => x !== it);
        loadUsage(); schedulePreflight(); // 伺服器已經釋放這首的暫存空間
      } else it.msg = r ? (j.error || '取消失敗') : '連不上伺服器，沒有取消';
      render();
    }

    async function startAll() {
      if (running) return;
      running = true; stopRequested = false; syncButtons();
      try {
        for (;;) {
          if (stopRequested) break;
          const it = items.find((x) => x.status === 'pending');
          if (!it) break;
          await uploadOne(it);
          // 空間不足就不必再試後面的
          if (it.status === 'error' && /空間不足/.test(it.msg)) {
            items.filter((x) => x.status === 'pending').forEach((x) => { x.status = 'error'; x.msg = '空間不足，已停止'; });
            render();
            break;
          }
        }
      } finally {
        running = false; stopRequested = false; currentReq = null; syncButtons();
      }
    }

    // ── 伺服器處理進度 ──
    function applyJob(it, job) {
      const before = it.status;
      it.status = job.status;
      if (job.status === 'queued') it.msg = job.position > 1 ? `前面還有 ${job.position - 1} 首` : '下一首就輪到';
      else if (job.status === 'processing') it.msg = job.mode === 'original' ? '儲存中…' : '轉檔／統一音量中，大檔案可能要一兩分鐘…';
      else if (job.status === 'done') {
        const r = job.result || {};
        it.msg = (RESULT_TEXT[r.method] || (() => '完成'))(r) + ' → ' + String(job.filename || '').replace(/^\.private\/\d+\//, '私人 / ');
      } else if (job.status === 'error') it.msg = job.error || '處理失敗';
      return before !== 'done' && job.status === 'done';
    }

    function schedulePoll(ms = 3000) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, ms);
    }
    async function poll() {
      let j;
      try {
        const r = await fetch('/web/api/upload/jobs');
        if (r.status === 401 || r.status === 403) return; // 登出了或不是管理員:不再輪詢
        if (!r.ok) throw 0;
        j = await r.json();
      } catch { return schedulePoll(10000); }
      let newlyDone = 0, newlyFailed = 0;
      for (const job of j.jobs || []) {
        let it = items.find((x) => x.jobId === job.id);
        if (!it) { // 重新整理頁面前上傳的:只剩伺服器紀錄
          it = { id: ++seq, file: null, name: job.name, size: job.inputBytes, title: job.title, pct: 100, jobId: job.id, status: '' };
          items.push(it);
        }
        // 這次打開頁面才接回的舊紀錄(status 是空的)不算「新的失敗」
        const wasKnown = it.status !== '' && it.status !== 'error';
        if (applyJob(it, job)) newlyDone += 1;
        if (wasKnown && it.status === 'error') newlyFailed += 1;
      }
      noteFailures(newlyFailed);
      render();
      if (newlyDone) { onUploaded && onUploaded(newlyDone); loadUsage(); }
      if (items.some((x) => x.status === 'queued' || x.status === 'processing')) schedulePoll();
    }

    // ── 事件 ──
    $('upFiles').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    const drop = $('upDrop');
    // 觸控裝置不能拖曳檔案：只說點一下選擇
    if (matchMedia('(hover: none)').matches) $('upDropText').textContent = '點這裡選擇音檔（可多選）';
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); if (!running) drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (!running && e.dataTransfer) addFiles(e.dataTransfer.files); });
    document.querySelectorAll('#upTarget .chip').forEach((b) => b.addEventListener('click', () => {
      if (running) return;
      target = b.dataset.target; syncTarget(); schedulePreflight();
    }));
    $('upOriginal').addEventListener('change', () => { syncTarget(); schedulePreflight(); render(); });
    $('upStart').addEventListener('click', () => (running ? stopAll() : startAll()));
    $('upClear').addEventListener('click', () => {
      items = items.filter((it) => it.status !== 'done' && it.status !== 'blocked' && !(it.status === 'error' && !it.file));
      render(); schedulePreflight();
      fetch('/web/api/upload/jobs/clear', { method: 'POST' }).catch(() => {}); // 伺服器上的完成／失敗紀錄也清掉
    });
    window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

    syncTarget();
    render();
    return {
      init() { poll(); },
      show() { visible = true; unseenFailed = 0; loadUsage(); poll(); syncButtons(); },
      hide() { visible = false; },
      busy: () => running,
      showFailed() { onlyFailed = true; render(); },
    };
  }

  window.MLUpload = { create };
})();
