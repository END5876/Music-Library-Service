'use strict';
// playerControls.js — 播放器：控制項、全螢幕播放頁、鍵盤、頁籤切換。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, setIcon, setStatus, pushLayer, dropLayer } = window.MLUi;
  const { dbg } = window.MLDebug;
  const { IS_ANDROID, keepOff } = window.MLPlatform;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    syncButtons, openFull, closeFull, saveScroll, restoreScroll, setMode,
  });

  // ── 控制項 ──
  function syncButtons() {
    ['shuffle', 'fShuffle'].forEach(id => $(id).classList.toggle('on', P.shuffle));
    ['repeat', 'fRepeat'].forEach(id => {
      $(id).classList.toggle('on', P.repeat !== 'off');
      setIcon($(id), P.repeat === 'one' ? 'repeat1' : 'repeat');
      $(id).title = P.REPEAT_LABEL[P.repeat];
    });
    P.renderNext();
  }
  const cycleRepeat = () => { P.repeat = P.REPEATS[(P.REPEATS.indexOf(P.repeat) + 1) % P.REPEATS.length]; syncButtons(); P.savePrefs(); setStatus(P.REPEAT_LABEL[P.repeat]); };
  function toggleShuffle() {
    P.shuffle = !P.shuffle;
    if (P.playlistCtx) P.refillFromCtx(); else if (P.shuffle) P.buildShuffle();                       // 點下去的當下就排好
    else P.queue = P.queue.filter(e => e.user || e.kind === 'online'); // 關閉:回到依清單順序,保留手動加入的歌曲(含音樂庫)與線上歌曲
    syncButtons(); P.savePrefs();
    setStatus(P.shuffle ? '隨機播放已開啟，接下來的歌會打亂順序。可以在「佇列」拖曳調整。' : '隨機播放已關閉，接下來照順序播放。');
  }

  ['toggle', 'miniToggle', 'fToggle'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); P.toggle(); }));
  ['next', 'miniNext', 'fNext'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); P.advance(); }));
  ['prev', 'fPrev'].forEach(id => $(id).addEventListener('click', P.prev));
  ['shuffle', 'fShuffle'].forEach(id => $(id).addEventListener('click', toggleShuffle));
  ['repeat', 'fRepeat'].forEach(id => $(id).addEventListener('click', cycleRepeat));

  for (const id of ['seek', 'fSeek']) {
    const r = $(id);
    r.addEventListener('pointerdown', () => { P.dragging = true; });
    const end = () => { P.dragging = false; };
    r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end); r.addEventListener('blur', end);
    r.addEventListener('input', (e) => {
      if (!P.seekable()) return;
      audio.currentTime = e.target.value / 1000 * audio.duration;
      P.updateProgress();
    });
  }
  $('vol').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });
  $('vol').value = Math.round(audio.volume * 100);
  $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');
  // iOS／iPadOS 不能用網頁調整音量(volume 設了也不會變),整個音量控制藏起來,只能用實體按鍵。
  // iPadOS 的 Safari 自稱 Mac,用「Mac＋多點觸控」辨認
  const isIOS = /iP(hone|od|ad)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.body.classList.toggle('no-volume', isIOS);
  // 1100px 以下音量收成圖示鈕:點一下彈出滑桿;點外面、按 Esc、Tab 離開就收起來
  const volWrap = $('volWrap');
  const setVolPop = (open) => {
    volWrap.classList.toggle('open', open);
    $('volBtn').setAttribute('aria-expanded', String(open));
    if (open) $('vol').focus();
  };
  $('volBtn').addEventListener('click', () => setVolPop(!volWrap.classList.contains('open')));
  document.addEventListener('pointerdown', (e) => { if (volWrap.classList.contains('open') && !volWrap.contains(e.target)) setVolPop(false); });
  volWrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !volWrap.classList.contains('open')) return;
    e.stopPropagation();
    setVolPop(false);
    $('volBtn').focus();
  });
  volWrap.addEventListener('focusout', (e) => { if (e.relatedTarget && !volWrap.contains(e.relatedTarget)) setVolPop(false); });

  $('shuffleAll').addEventListener('click', () => {
    if (!P.view.length) return;
    P.shuffle = true;
    P.playlistCtx = null;
    P.history = [];
    P.play(P.view[Math.floor(Math.random() * P.view.length)].filename);
    P.buildShuffle();
    syncButtons(); P.savePrefs();
    setStatus('正在隨機播放音樂庫，接下來的歌會打亂順序。');
  });

  if ('mediaSession' in navigator) {
    const setHandler = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
    setHandler('previoustrack', () => { dbg('mediaSession:previoustrack'); P.prev(); });
    setHandler('nexttrack', () => { dbg('mediaSession:nexttrack'); P.advance(); });
    if (IS_ANDROID) {
    // 通知欄進度條拖曳／快轉快退(沒有 seekto 處理器的話,系統不會開放拖曳)
    setHandler('seekto', (d) => {
      dbg('mediaSession:seekto', d && d.seekTime);
      if (!P.seekable() || !d || typeof d.seekTime !== 'number') return;
      audio.currentTime = Math.min(Math.max(0, d.seekTime), audio.duration);
      P.updatePositionState();
    });
    setHandler('seekbackward', (d) => {
      if (!P.seekable()) return;
      audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10)); P.updatePositionState();
    });
    setHandler('seekforward', (d) => {
      if (!P.seekable()) return;
      audio.currentTime = Math.min(audio.duration, audio.currentTime + ((d && d.seekOffset) || 10)); P.updatePositionState();
    });
    }
    setHandler('play', () => { dbg('mediaSession:play'); P.userPaused = false; P.tryPlay(); });
    setHandler('pause', () => {
      // 自動換歌剛開始播的 1.5 秒內、頁面在背景收到的 pause 動作:不是使用者按的,忽略
      const spurious = IS_ANDROID && document.hidden && P.inAutoWindow() && Date.now() - P.lastPlayingAt < 1500;
      dbg('mediaSession:pause', spurious ? '(換歌後立即收到,忽略)' : '');
      if (spurious) return;
      P.pendingPlay = false; P.switchPending = false; P.userPaused = true; audio.pause(); keepOff(); P.setSession('paused');
    });
  }

  // 全螢幕播放頁
  function openFull() {
    if (P.isFullOpen()) return;
    $('full').classList.add('open'); document.body.classList.add('full-open'); if (P.nextDirty) P.flushNext();
    if (P.themeMeta) P.themeMeta.content = P.fullTint(); // Android 狀態列接上全螢幕頁的顏色
    pushLayer('full', closeFull);
  }
  function closeFull() {
    if (!P.isFullOpen()) return;
    $('full').classList.remove('open'); document.body.classList.remove('full-open');
    if (P.themeMeta) P.themeMeta.content = '#0b0b0b';
    dropLayer('full');
  }
  // 底部播放列：點哪裡都展開，只有按鈕、進度條、音量照原本的功能
  document.querySelector('.player').addEventListener('click', (e) => {
    if (e.target.closest('button, input, .vol')) return;
    openFull();
  });
  $('expand').addEventListener('click', openFull);
  $('miniOpen').addEventListener('click', openFull);
  $('close').addEventListener('click', closeFull);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    $('full').dataset.tab = t.dataset.tab;
  }));

  const skipKey = (e) => (e.target.matches && e.target.matches('input:not([type=range]), select, textarea')) || e.ctrlKey || e.metaKey || e.altKey;
  // 空白鍵在按鈕上會在 keyup 觸發 click,與上面的全域播放／暫停疊加成「按了沒反應」
  document.addEventListener('keyup', (e) => { if (e.key === ' ' && !skipKey(e)) e.preventDefault(); });
  document.addEventListener('keydown', (e) => {
    if (skipKey(e)) return;
    if (P.rowKey(e)) return;
    if (e.key === ' ') { e.preventDefault(); P.toggle(); }
    else if (e.key === 'n' || e.key === 'N') P.advance();
    else if (e.key === 'p' || e.key === 'P') P.prev();
    else if (e.key === 's' || e.key === 'S') toggleShuffle();
    else if (e.key === 'r' || e.key === 'R') cycleRepeat();
    else if (e.key === '?') P.toggleHelp(true);
    else if (e.key === 'Escape') {
      if ($('helpDlg').classList.contains('show')) P.toggleHelp(false);
      else if ($('pickPl').classList.contains('show')) P.closePick();
      else if ($('full').classList.contains('open')) closeFull();
      else if (P.plSel.on) P.setPlSelecting(false); else if (P.libSel.on) P.setLibSelecting(false);
    }
    // 焦點在進度條時瀏覽器本身也會處理方向鍵(±0.1%),要 preventDefault 才不會蓋掉 ±10 秒;音量條則保留原生行為
    else if (e.key === 'ArrowRight' && P.seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
    else if (e.key === 'ArrowLeft' && P.seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 10); }
  });

  // ── 頁籤切換 ──
  // 每個頁面(播放清單內頁依清單分開)各自記住捲動位置,切回來時還原
  const scrollPos = new Map();
  const scrollKey = () => (P.mode === 'playlists' && P.plOpen ? 'pl:' + P.plOpen : P.mode);
  function saveScroll() { scrollPos.set(scrollKey(), $('main').scrollTop); }
  function restoreScroll() {
    const y = scrollPos.get(scrollKey()) || 0;
    $('main').scrollTop = y;
    requestAnimationFrame(() => { $('main').scrollTop = y; }); // 列表剛重畫完,下一幀再補一次
  }
  function setMode(m) {
    if (m === 'online' && !P.onlineAvailable) m = 'library';
    // 再點一次目前的頁籤:回到最上面(開了「減少動態效果」就直接跳過去)
    if (m === P.mode) { $('main').scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
    saveScroll();
    if (P.libSel.on) P.setLibSelecting(false);
    if (P.plSel.on) P.setPlSelecting(false);
    if (P.mode === 'playlists' && P.plOpen) dropLayer('pl'); // 內頁保留,但返回鍵不該在別的頁籤關掉看不到的內頁
    P.mode = m;
    if (m === 'playlists' && P.plOpen && P.plById(P.plOpen)) pushLayer('pl', P.closePlDetail);
    $('viewLibrary').hidden = m !== 'library';
    $('viewOnline').hidden = m !== 'online';
    $('viewPlaylists').hidden = m !== 'playlists';
    $('viewOffline').hidden = m !== 'offline';
    $('viewBots').hidden = m !== 'bots';
    $('viewUpload').hidden = m !== 'upload';
    if (m === 'bots') P.bots.show(); else P.bots.hide();
    if (m === 'upload') P.uploader.show(); else P.uploader.hide();
    try { if (m === 'upload') localStorage.setItem(P.UPLOAD_TAB_KEY, '1'); else localStorage.removeItem(P.UPLOAD_TAB_KEY); } catch {}
    document.body.classList.toggle('pl-detail', m === 'playlists' && !!P.plOpen && !!P.plById(P.plOpen));
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === m));
    const s = $('search');
    s.disabled = m === 'bots' || m === 'upload'; // Bot、上傳頁籤沒有可搜尋的內容:找歌請到音樂庫／線上搜尋,再從「⋮」點給 Bot
    if (m === 'bots') { s.placeholder = '到音樂庫或線上搜尋找歌，從「⋮」點給 Bot'; s.value = ''; }
    else if (m === 'upload') { s.placeholder = ''; s.value = ''; }
    else if (m === 'online') { s.placeholder = '搜尋 YouTube、Bilibili，或貼上影片網址'; s.value = P.onlineQuery; }
    else if (m === 'playlists') { s.placeholder = '搜尋播放清單…'; s.value = P.plQuery; P.renderPlaylists(); }
    else if (m === 'offline') { s.placeholder = '搜尋離線歌曲…'; s.value = P.offQuery; P.renderOffline(); P.updateQuota(); }
    else { s.placeholder = '搜尋歌名…'; s.value = P.libQuery; P.markPlaying(); }
    P.updateNetState();
    restoreScroll();
  }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.view)));

  // 音樂庫篩選每次都要重畫最多 300 列:連續打字時合併成停頓 100ms 後畫一次
  let filterTimer = 0;
  $('search').addEventListener('input', () => {
    if (P.mode === 'library') {
      P.libQuery = $('search').value;
      clearTimeout(filterTimer);
      filterTimer = setTimeout(P.applyFilter, 100);
    }
    else if (P.mode === 'playlists') { P.plQuery = $('search').value; P.renderPlaylists(); }
    else if (P.mode === 'offline') { P.offQuery = $('search').value; P.renderOffline(); }
    else P.onlineQuery = $('search').value;
  });
})();
