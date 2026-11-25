'use strict';
// playerQueue.js — 播放器：目前播放資訊、隨機佇列、佇列畫面、拖曳排序。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, setStatus } = window.MLUi;

  // 給其他檔案用的函式
  Object.assign(P, {
    setNow, shuffled, buildShuffle, syncShuffleQueue, renderNext, flushNext, holdToDrag, dragSort, startDrag,
  });

  // ── 目前播放資訊 ──
  function setNow(n) {
    const t = n ? n.title : '尚未播放';
    const a = n ? n.sub : '從音樂庫或線上搜尋選一首歌';
    ['barTitle', 'miniTitle', 'fTitle'].forEach(id => { $(id).textContent = t; });
    ['barArtist', 'miniArtist', 'fArtist'].forEach(id => { $(id).textContent = a; });
    document.title = n ? `${n.title}｜裊器音樂` : '裊器音樂';
    for (const id of ['barCover', 'miniCover', 'bigCover']) P.paintCover($(id));
    if (isFullOpen() && P.themeMeta) P.themeMeta.content = P.fullTint();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = n ? new MediaMetadata({ title: n.title, artist: n.sub, artwork: P.coverArtwork() }) : null;
      } catch {}
    }
    P.markPlaying(true);
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
    const online = P.queue.filter(e => e.user || e.kind === 'online'); // 手動排的歌保留在最前面
    let files = P.view.map(f => f.filename);
    if (!includeCurrent) files = files.filter(f => f !== P.currentFile);
    const order = shuffled(files);
    // 新一輪的第一首不要正好是剛播完的那首(清單只有一首時除外)
    if (includeCurrent && order.length > 1 && order[0] === P.currentFile) {
      const j = 1 + Math.floor(Math.random() * (order.length - 1));
      [order[0], order[j]] = [order[j], order[0]];
    }
    P.queue = online.concat(order.map(P.mkLib));
    if (render) renderNext();
  }
  // 篩選變動時:只有「清單內容」真的變了才重排,避免打字搜尋時每個字都洗牌、也保留使用者拖曳過的順序
  function syncShuffleQueue() {
    if (P.playlistCtx) return; // 播放清單有自己的隨機佇列
    const want = new Set(P.view.map(f => f.filename));
    want.delete(P.currentFile);
    const have = P.queue.filter(e => e.kind === 'lib' && !e.user);
    const same = have.length === want.size && have.every(e => want.has(e.filename));
    if (!same) buildShuffle({ render: false });
  }

  // ── 佇列畫面(全螢幕播放頁)──
  function queueRow(e) {
    const drag = { grip: true, qid: e.id };
    const remove = { icon: 'close', title: '移出佇列', onClick: () => { P.queue = P.queue.filter(x => x.id !== e.id); renderNext(); } };
    if (e.kind === 'lib') {
      const f = P.byFile.get(e.filename) || (e.title ? { filename: e.filename, name: e.title, size: 0 } : null);
      if (!f) return null;
      return P.makeRow({ ...drag, key: 'lib:' + f.filename, title: f.name, sub: P.libSub(f), dur: P.libDur(f), btn: remove, onClick: () => P.playFromQueue(e.id) });
    }
    const r = e.item;
    return P.makeRow({
      ...drag, title: r.title, sub: P.onlineSub(r),
      dur: r.duration && r.duration !== '未知' ? r.duration : '', btn: remove,
      onClick: () => P.playFromQueue(e.id),
    });
  }

  // 佇列只存在於全螢幕播放頁:頁面沒開時只標記「需要重畫」,打開時才真的畫(換歌不再重建整份清單)
  const isFullOpen = () => $('full').classList.contains('open');
  function renderNext() {
    P.nextDirty = true;
    if (isFullOpen()) flushNext();
  }
  function flushNext() {
    P.nextDirty = false;
    P.queue = P.queue.filter(e => e.kind !== 'lib' || P.libAvailable(e.filename)); // 數量與畫面列數保持一致
    const ul = $('nextList'); ul.textContent = '';
    const frag = document.createDocumentFragment();
    let count = 0;
    // 隨機模式的佇列可能有上千首,只畫前 100 列;非隨機模式的佇列只含使用者手動排的項目,全部畫出來
    const cap = P.shuffle ? P.QUEUE_MAX_ROWS : Infinity;
    for (const e of P.queue.slice(0, cap)) { const li = queueRow(e); if (li) { frag.appendChild(li); count++; } }
    if (P.queue.length > cap) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = `…還有 ${P.queue.length - P.QUEUE_MAX_ROWS} 首`;
      frag.appendChild(li);
    }
    // 非隨機模式:佇列用完之後會接著播「最後一首」的下一首,預覽就從那裡開始(與 pickNext 的行為一致)
    let anchor = null;
    // 播放清單／離線歌曲播放中:佇列播完後不會接到音樂庫,所以不顯示音樂庫的預覽
    if (!P.shuffle && !P.playlistCtx) {
      for (let k = P.queue.length - 1; k >= 0; k--) if (P.queue[k].kind === 'lib') { anchor = P.queue[k].filename; break; }
      if (!anchor && !P.onlineCurrent && P.currentFile) anchor = P.currentFile;
    }
    if (anchor) {
      const i = P.view.findIndex(f => f.filename === anchor);
      if (i >= 0) for (const f of P.view.slice(i + 1, i + 31)) { frag.appendChild(P.previewRow(f)); count++; }
    }
    if (!count) {
      const li = document.createElement('li'); li.className = 'note';
      li.textContent = P.playlistCtx ? (P.repeat === 'off' ? '播完這首就結束了' : '播完後從第一首重新開始')
        : P.shuffle ? '佇列是空的，按「重新打亂」再排一份。' : '沒有下一首了。';
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    $('queueTitle').textContent = P.queue.length ? `佇列（${P.queue.length} 首）` : '佇列';
    $('reshuffle').hidden = !P.shuffle;
    P.markPlaying();
  }
  $('reshuffle').addEventListener('click', () => { buildShuffle(); setStatus('已重新打亂接下來的順序。'); });

  // ── 拖曳排序(Pointer Events,滑鼠與觸控通用;佇列與播放清單共用)──
  // rows:拖曳中的列以外、可以放置的列;sc:捲動容器;onEnd(dropped, pos):放開或取消時呼叫
  // 每一幀(requestAnimationFrame,跟螢幕更新同步)只改 transform:被拖的列跟著手指,
  // 其他列滑開讓出空位,看得出會插在哪裡。拖曳中不讀 layout、不切換 class,避免整份列表重算樣式。
  // 觸控拖曳排序:按住把手 HOLD_MS 才開始(輕震一下、該列亮起);按住期間手指移動超過 HOLD_SLOP 就當成捲動、不拖。
  // 把手的 touch-action 在觸控裝置是 pan-y(見 player.css),所以從把手上也能正常捲動;
  // 開始拖曳後用不被動的 touchmove 擋掉捲動,手指放開或手勢被取消時拿掉
  const HOLD_MS = 350, HOLD_SLOP = 10;
  function holdToDrag(ev, li, run) {
    const x0 = ev.clientX, y0 = ev.clientY;
    li.classList.add('hold');
    const cleanup = () => {
      clearTimeout(timer);
      li.classList.remove('hold');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };
    const onMove = (e) => { if (Math.hypot(e.clientX - x0, e.clientY - y0) > HOLD_SLOP) cleanup(); };
    const timer = setTimeout(() => {
      cleanup();
      const block = (e) => { if (e.cancelable) e.preventDefault(); };
      const stop = () => {
        document.removeEventListener('touchmove', block);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };
      document.addEventListener('touchmove', block, { passive: false });
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* 不支援震動 */ }
      run();
    }, HOLD_MS);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  }

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
          ? P.queue.find(x => x.id === Number(r.dataset.qid))
          : (P.byFile.has(r.dataset.pv) ? P.mkLib(r.dataset.pv) : null);
        const moved = toEntry(li);
        if (moved) {
          const shown = rows.map(toEntry).filter(Boolean);
          shown.splice(Math.min(pos, shown.length), 0, moved);
          const used = new Set(shown.map(x => x.id));
          P.queue = shown.concat(P.queue.filter(x => !used.has(x.id)));
        }
      }
      renderNext();
    });
  }

  Object.assign(P, {
    isFullOpen,
  });
})();
