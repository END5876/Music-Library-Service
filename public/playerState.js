'use strict';
// playerState.js — 播放器：共用狀態與偏好、背景播放 helper。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer = {};
  const { $, enc, fmt, setStatus } = window.MLUi;
  const { dbg } = window.MLDebug;
  const { keepOn } = window.MLPlatform;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    savePrefs, setSession, tryPlay,
  });

  const REPEATS = ['all', 'one', 'off'];
  const REPEAT_LABEL = { all: '列表循環', one: '單曲循環', off: '不循環' };

  // ── 狀態 ──
  P.all = [];            // 全部曲目
  P.view = [];           // 目前篩選後的清單
  P.currentFile = null;  // 目前播放的音樂庫 filename
  P.onlineCurrent = null;
  P.onlineAvailable = false;
  P.byFile = new Map();  // filename -> 曲目(O(1) 查詢,取代 all.find)
  P.nextDirty = true;    // 佇列畫面是否需要重畫(全螢幕頁沒開時不畫)
  const LIB_PAGE = 100;    // 音樂庫清單一次畫幾列;捲到接近底部時自動再畫下一批
  const QUEUE_MAX_ROWS = 100; // 佇列畫面一次最多畫幾列
  P.libLimit = LIB_PAGE;
  P.shuffle = false;
  P.repeat = 'all';
  P.history = [];
  P.errorStreak = 0;
  P.waitingNet = '';        // 網路中斷時,正在等待恢復的曲目 key
  P.netProbeAt = 0;         // 上次探測網路的時間
  P.waitingSince = 0;       // 開始「緩衝中」的時間(串流中途卡住的偵測用)
  P.netChecking = false;
  P.resumeAt = null;        // 網路恢復後要接著播的位置 { key, t }
  P.errorRetry = 0; P.errorRetryKey = '';
  const ERROR_RETRIES = 2;    // 網路正常但這首載入失敗:先重試同一首這麼多次,才算一次失敗
  P.pendingPlay = false; // 程式已要求播放、但還沒真的開始(載入中)
  P.switchPending = false; // 已載入新音源、尚未真正開始播(tryPlay 放棄後仍保留,供 recover 補救)
  P.userPaused = false;    // 使用者(含鎖屏／耳機按鍵)明確按了暫停
  P.autoSwitchAt = 0;      // 最近一次「播完自動換歌」的時間
  P.lastPlayingAt = 0;     // 最近一次 playing 事件的時間
  const RESUME_DELAYS = [0, 600]; // 實測每次補打都只多播約 0.1 秒又被系統暫停,多試無益(還會聽到「滋」一聲),只留 2 次
  P.resumeTimer = 0;
  P.autoResumes = 0;       // 自動換歌後被非使用者暫停,已自動恢復的次數
  const inAutoWindow = () => P.autoSwitchAt > 0 && Date.now() - P.autoSwitchAt < 8000;
  P.lastSrc = null;        // { key, url } 最近一次 loadSource,必要時重新載入
  P.endHandled = false;  // 這次 ended 是否已處理過
  P.mode = 'library';
  P.folder = ''; // 音樂庫上方標籤:''＝全部、'public'、'private'(見 renderChips)
  P.libQuery = ''; P.onlineQuery = ''; P.offQuery = '';
  // 佇列:統一存放「接下來要播的」項目,可拖曳排序
  // 項目:{ id, kind:'lib', filename } 或 { id, kind:'online', item }
  P.queue = [];
  let qid = 0;
  const mkLib = (filename, title) => ({ id: ++qid, kind: 'lib', filename, title });
  const mkOnline = (item) => ({ id: ++qid, kind: 'online', item });
  // 播放清單(存在伺服器,跨裝置共用)
  P.playlists = [];
  P.plOpen = null;        // 目前打開的播放清單 id
  P.plQuery = '';
  P.playlistCtx = null;   // 目前正在播放的播放清單:{ id, items }
  // 離線下載(IndexedDB)
  const offlineKeys = new Set();  // 已下載的 key('lib:<filename>' / 'on:<url>')
  const dlState = new Map();      // key -> { pct, active }(排隊中／下載中)
  const libAvailable = (fn) => P.byFile.has(fn) || offlineKeys.has('lib:' + fn);

  try {
    const s = JSON.parse(localStorage.getItem('ml_prefs') || '{}');
    if (typeof s.volume === 'number') audio.volume = Math.min(1, Math.max(0, s.volume));
    P.shuffle = !!s.shuffle;
    if (REPEATS.includes(s.repeat)) P.repeat = s.repeat;
  } catch {}
  function savePrefs() {
    try { localStorage.setItem('ml_prefs', JSON.stringify({ volume: audio.volume, shuffle: P.shuffle, repeat: P.repeat })); } catch {}
  }

  const streamUrl = (f) => '/web/stream/' + f.split('/').map(enc).join('/');
  const libDur = (f) => (f && f.duration ? fmt(f.duration) : ''); // 音樂庫曲目的歌曲長度(伺服器還沒讀到時為空)
  // 線上即時串流要不要請伺服器直接送 WebM/Opus(YouTube 只換封裝、不重新編碼,見 streamPlayer.js)。
  // Apple 的 WebKit(Safari、iOS 上所有瀏覽器)對 <audio> 直接播 WebM 串流不可靠,一律維持 mp3。
  // 離線下載(downloader.js)不帶這個參數:WebM 串流沒有索引,存成檔案後不好拖曳進度。
  const WEBM_OK = (() => {
    const ua = navigator.userAgent || '';
    const appleWebKit = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      || (/Safari\//.test(ua) &&!/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS|Android/.test(ua));
    try { return !appleWebKit && audio.canPlayType('audio/webm; codecs="opus"') !== ''; } catch { return false; }
  })();

  // ── 背景播放穩定性 helper ──
  function setSession(state) {
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = state; } catch {} }
  }
  // 支援 Audio Session API 的瀏覽器（含新版 Safari）可據此把本頁視為音樂播放。
  // 不支援時完全不影響既有播放流程；它不能繞過瀏覽器或系統的背景執行限制。
  function configureAudioSession() {
    if (!('audioSession' in navigator)) return;
    try {
      if (navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
      dbg('audioSession', navigator.audioSession.type);
    } catch (err) {
      dbg('audioSession 設定失敗', err && err.name);
    }
  }
  // 載入空檔也維持「播放中」;失敗最多重試 retries 次,之後放棄(避免 recover 無限重試)
  function tryPlay(retries = 3) {
    configureAudioSession();
    keepOn();
    P.pendingPlay = true;
    setSession('playing');
    const p = audio.play();
    if (p && p.then) p.then(() => dbg('play() 成功'));
    if (p && p.catch) p.catch((err) => {
      dbg('play() 被拒絕', err && err.name, '剩餘重試', retries);
      if (err && err.name === 'AbortError') return; // 被新的 load 取代,正常
      if (retries > 0 && P.pendingPlay) { setTimeout(() => tryPlay(retries - 1), 600); return; }
      P.pendingPlay = false;
      setSession('paused');
      setStatus('瀏覽器擋下了自動播放，請按播放鍵。', { action: { label: '播放', fn: () => tryPlay(0) } });
    });
  }
  // 背景分頁的 timer 會被節流甚至凍結:hidden 時直接同步執行
  // (error / ended 都是非同步觸發的事件,同步呼叫不會造成遞迴)
  const later = (fn) => { if (document.hidden) fn(); else setTimeout(fn, 800); };

  Object.assign(P, {
    REPEATS, REPEAT_LABEL, LIB_PAGE, QUEUE_MAX_ROWS, ERROR_RETRIES, RESUME_DELAYS, inAutoWindow, mkLib, mkOnline,
    offlineKeys, dlState, libAvailable, streamUrl, libDur, WEBM_OK, later,
  });
})();
