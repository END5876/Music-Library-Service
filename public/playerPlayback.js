'use strict';
// playerPlayback.js — 播放器：播放、上一首／下一首、audio 事件、斷線與補救。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, fmt, setIcon, setStatus } = window.MLUi;
  const { DEBUG_UI, dbg } = window.MLDebug;
  const { IS_ANDROID, keep, keepOff } = window.MLPlatform;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    currentEntry, pushHistory, play, playEntry, playFromQueue, pickNext, advance, prev, toggle, updatePositionState,
    updateProgress, updatePlayIcons,
  });

  // ── 播放 ──
  // 歷史與佇列使用同一種項目格式({kind:'lib',filename} / {kind:'online',item}),「上一首」才能回到線上歌曲
  const entryKey = (e) => e.kind === 'lib' ? 'lib:' + e.filename : 'on:' + (e.item.srcUrl || e.item.url);
  function currentEntry() {
    if (P.currentFile) return { kind: 'lib', filename: P.currentFile };
    if (P.onlineCurrent) return { kind: 'online', item: P.onlineCurrent };
    return null;
  }
  function pushHistory() {
    const c = currentEntry(); if (!c) return;
    P.history.push(c);
    if (P.history.length > 200) P.history.shift();
  }

  function play(filename, { pushHistory: ph = true, title } = {}) {
    const track = P.byFile.get(filename)
      || (P.offlineKeys.has('lib:' + filename) ? { filename, name: title || filename.split('/').pop(), size: 0 } : null);
    if (!track) return false;
    if (ph && P.currentFile !== filename) pushHistory();
    dbg('play', filename);
    P.onlineCurrent = null;
    P.currentFile = filename;
    P.endHandled = false;
    P.loadSource('lib:' + filename, P.streamUrl(filename));
    setStatus('');
    P.setNow({ title: track.name, sub: P.libSub(track) });
    return true;
  }

  function playEntry(e, opts) {
    if (e.kind === 'online') return P.playOnline(e.item, opts);
    if (!play(e.filename, { ...opts, title: e.title })) advance(); // 檔案已不存在就跳過
  }
  function playFromQueue(id) {
    const i = P.queue.findIndex(x => x.id === id);
    if (i < 0) return;
    const [e] = P.queue.splice(i, 1);
    playEntry(e);
  }

  function pickNext() { // 非隨機模式:依清單順序
    if (!P.view.length) return null;
    const i = P.view.findIndex(f => f.filename === P.currentFile);
    if (i < 0) return P.view[0].filename;
    if (i + 1 < P.view.length) return P.view[i + 1].filename;
    return P.repeat === 'all' ? P.view[0].filename : null;
  }

  function advance() {
    dbg('advance, queue=', P.queue.length);
    if (P.isOffline()) return P.advanceOffline();
    if (P.queue.length) { playEntry(P.queue.shift()); return; }
    if (P.playlistCtx) {
      if (P.repeat === 'off') { setStatus('播放清單播放完畢'); return; }
      P.refillFromCtx(true); // 循環:新一輪
      if (P.queue.length) { playEntry(P.queue.shift()); return; }
      P.playlistCtx = null;
    }
    if (P.onlineCurrent) {
      // 🐛 只有真的播完(從 onEnded 來)才清掉;使用者按「下一首」時歌還在播,清掉會讓播放鍵和播完後的 advance 改播音樂庫
      if (audio.ended) { P.onlineCurrent = null; P.markPlaying(); P.renderNext(); setStatus('佇列播放完畢'); }
      else setStatus('佇列裡沒有下一首了');
      return;
    }
    if (P.shuffle) {
      if (!P.view.length) return;
      if (P.repeat === 'off' && P.currentFile) { setStatus('隨機清單播放完畢'); return; }
      P.buildShuffle({ includeCurrent: true }); // 一輪播完:排出下一輪(剛播完的那首也要在裡面)
      if (P.queue.length) playEntry(P.queue.shift());
      else if (P.currentFile) { audio.currentTime = 0; P.tryPlay(); }
      return;
    }
    const n = pickNext();
    if (n) play(n);
  }

  function prev() {
    dbg('prev');
    // 已播放超過 3 秒:回到開頭(線上串流不能拖曳,就重新串流)
    if ((P.currentFile || P.onlineCurrent) && audio.currentTime > 3) {
      if (seekable()) audio.currentTime = 0;
      else if (P.onlineCurrent) P.playOnline(P.onlineCurrent, { pushHistory: false });
      return;
    }
    while (P.history.length) {
      const e = P.history.pop();
      if (e.kind === 'lib' && !P.byFile.has(e.filename)) continue; // 檔案已不存在:再往前找
      const cur = currentEntry();
      // 隨機模式或目前是線上歌曲:把目前這首放回佇列最前面,按「下一首」還能回來(先去重,避免連按「上一首」出現重複項)
      if (cur && (P.shuffle || cur.kind === 'online')) {
        P.queue = P.queue.filter(x => entryKey(x) !== entryKey(cur));
        P.queue.unshift(cur.kind === 'lib' ? P.mkLib(cur.filename) : P.mkOnline(cur.item));
      }
      playEntry(e, { pushHistory: false });
      P.renderNext();
      return;
    }
    if (P.onlineCurrent) { P.playOnline(P.onlineCurrent, { pushHistory: false }); return; }
    if (P.shuffle) return;
    const i = P.view.findIndex(f => f.filename === P.currentFile);
    if (i > 0) play(P.view[i - 1].filename, { pushHistory: false });
    else if (P.view.length && P.repeat === 'all') play(P.view[P.view.length - 1].filename, { pushHistory: false });
  }

  function toggle() {
    if (!P.currentFile && !P.onlineCurrent) {
      if (P.queue.length) { advance(); return; } // 佇列(含重開頁面時排好的隨機佇列、手動加入的線上歌曲)優先
      if (!P.view.length) return;
      P.start(P.shuffle ? P.view[Math.floor(Math.random() * P.view.length)].filename : P.view[0].filename);
      return;
    }
    if (audio.paused) { P.userPaused = false; P.tryPlay(); } else { P.pendingPlay = false; P.switchPending = false; P.userPaused = true; audio.pause(); keepOff(); }
  }

  // ── audio 事件 ──
  P.dragging = false;
  const seekable = () => isFinite(audio.duration) && audio.duration > 0;

  // 通知欄／鎖屏的進度條:明確告訴系統「這首歌」的長度與位置。
  // 靜音保活元素(1 秒循環)也在播放,不主動設定的話系統可能拿它的長度而不是歌曲的,導致不顯示總長、不能拖曳。
  let lastPosDur = 0, lastPosAt = 0;
  function updatePositionState() {
    if (!IS_ANDROID || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    lastPosAt = Date.now();
    try {
      if (seekable()) {
        lastPosDur = audio.duration;
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(Math.max(0, audio.currentTime || 0), audio.duration),
        });
      } else {
        lastPosDur = 0;
        navigator.mediaSession.setPositionState(); // 串流中沒有總長度:清除
      }
    } catch (err) { dbg('setPositionState 失敗', err); }
  }

  function updateProgress() {
    const can = seekable();
    if (can && (audio.duration !== lastPosDur || Date.now() - lastPosAt > 4000)) updatePositionState();
    const cur = audio.currentTime || 0;
    const p = can ? Math.min(100, cur / audio.duration * 100) : 0;
    for (const r of [$('seek'), $('fSeek')]) {
      r.disabled = !can;
      if (!P.dragging) r.value = p * 10;
      r.style.setProperty('--p', p + '%');
    }
    const durText = can ? fmt(audio.duration) : ((P.currentFile || P.onlineCurrent) ? '串流中' : '0:00');
    $('barCur').textContent = fmt(cur);
    $('barDur').textContent = durText;
    $('fCur').textContent = fmt(cur);
    $('fDur').textContent = durText;
    $('miniProg').style.width = p + '%';
  }
  function updatePlayIcons() {
    updatePositionState();
    const name = audio.paused ? 'play' : 'pause';
    ['toggle', 'miniToggle', 'fToggle'].forEach(id => setIcon($(id), name));
    $('bigCover').classList.toggle('paused', audio.paused);
    document.body.classList.toggle('is-paused', audio.paused); // 列表上的等化器跟著停
  }
  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied', 'seeked']) audio.addEventListener(ev, updateProgress);
  for (const ev of ['play', 'pause', 'ended', 'emptied']) audio.addEventListener(ev, updatePlayIcons);

  // ended 可重入:事件漏掉時 recover() 也能安全補呼叫,且同一次結束只處理一次
  function onEnded() {
    if (P.endHandled) return;
    P.endHandled = true;
    P.autoSwitchAt = Date.now(); P.autoResumes = 0;
    dbg('ended', 'hidden=', document.hidden, 'time=', audio.currentTime);
    P.errorStreak = 0;
    if (P.repeat === 'one') {
      if (P.onlineCurrent) P.playOnline(P.onlineCurrent);
      else { audio.currentTime = 0; P.tryPlay(); }
    } else advance();
  }
  audio.addEventListener('canplay', () => {
    if (IS_ANDROID && P.switchPending && audio.paused && !audio.ended) { dbg('canplay: 補打 play'); P.tryPlay(1); }
  });
  if (DEBUG_UI) for (const ev of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'waiting', 'stalled', 'suspend', 'abort', 'error', 'emptied', 'seeking', 'seeked']) {
    audio.addEventListener(ev, () => dbg('audio:' + ev,
      'rs=' + audio.readyState, 'ns=' + audio.networkState, 'paused=' + audio.paused,
      't=' + (audio.currentTime || 0).toFixed(1) + '/' + (isFinite(audio.duration) ? audio.duration.toFixed(1) : '?'),
      ev === 'error' && audio.error ? 'code=' + audio.error.code + ' ' + (audio.error.message || '') : ''));
  }
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('emptied', () => { P.endHandled = false; });
  audio.addEventListener('pause', () => {
    // 真正發生 pause(使用者、來電、系統中斷):不要讓 recover() 自動恢復
    // 播放自然結束時也會先觸發 pause,那種情況不算
    if (audio.ended) return;
    // 自動換歌後數秒內、不是使用者按的暫停(多半是 Android 在背景換歌時把媒體暫停):
    // 視為「換歌後沒播起來」,直接補打 play,並留著 switchPending 讓解鎖時 recover() 再補一次
    // 實測系統會在剛換歌後連續暫停好幾次(間隔約 10~100ms,持續 ~0.3 秒),所以用遞增延遲重試,最多 8 次
    const inWin = IS_ANDROID && !P.userPaused && P.inAutoWindow() && (P.currentFile || P.onlineCurrent);
    const spurious = inWin && P.autoResumes < P.RESUME_DELAYS.length;
    dbg('pause', 'hidden=', document.hidden, 'time=', audio.currentTime, 'userPaused=', P.userPaused,
      spurious ? '→ 非使用者暫停，自動恢復 #' + (P.autoResumes + 1) + '(' + P.RESUME_DELAYS[P.autoResumes] + 'ms 後)' : (inWin ? '→ 恢復次數用完，留待解鎖／回前景補救' : ''));
    if (spurious) {
      const delay = P.RESUME_DELAYS[P.autoResumes++];
      P.switchPending = true; P.pendingPlay = true;
      P.setSession('playing');
      const tok = P.srcTok;
      clearTimeout(P.resumeTimer);
      P.resumeTimer = setTimeout(() => {
        if (tok !== P.srcTok || P.userPaused || !audio.paused) return;
        dbg('自動恢復:play()');
        P.tryPlay(3);
      }, delay);
      return;
    }
    if (inWin) P.switchPending = true; // 放棄自動恢復,但保留旗標:回到前景時 recover() 會再補打 play
    P.pendingPlay = false;
    keepOff();
    P.setSession('paused');
  });
  audio.addEventListener('playing', () => {
    P.lastPlayingAt = Date.now();
    P.switchPending = false; P.errorStreak = 0; P.pendingPlay = false; P.endHandled = false;
    P.setSession('playing'); setStatus('');
    dbg('playing');
    P.preloadNext();
  });
  audio.addEventListener('volumechange', () => {
    $('vol').value = Math.round(audio.volume * 100);
    $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');
    P.savePrefs();
  });
  // 任何播放錯誤都先確認登入還有效(用輕量的 capabilities,不用抓整份清單)。
  // 過期就停下來要求重新登入,而不是一路「無法播放、已略過」下去。
  async function stillLoggedIn() {
    try {
      const r = await fetch('/web/api/capabilities');
      if (r.status === 401) { P.pendingPlay = false; audio.pause(); P.showLogin('登入已過期，請重新登入'); return false; }
    } catch {}
    return true;
  }
  // 網路探測:用不經過 Service Worker 快取的 /health(任何回應都代表連得上伺服器)
  async function netOk() {
    if (navigator.onLine === false) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try { await fetch('/health?_=' + Date.now(), { cache: 'no-store', signal: ctl.signal }); return true; }
    catch { return false; }
    finally { clearTimeout(timer); }
  }
  // 網路不通:停在目前這首等待恢復,不跳歌、不計入失敗次數
  function waitForNetwork(key) {
    P.waitingNet = key; P.waitingSince = 0; P.pendingPlay = false;
    if (P.currentFile && audio.currentTime > 3) P.resumeAt = { key, t: audio.currentTime };
    setStatus('網路連線中斷，恢復後會自動繼續播放', { sticky: true });
    dbg('等待網路恢復', key);
  }
  async function checkNetWait() {
    if (!P.waitingNet || Date.now() - P.netProbeAt < 4000) return;
    P.netProbeAt = Date.now();
    const key = P.waitingNet;
    if (!(await netOk())) return;
    if (P.nowKey() !== key) { P.waitingNet = ''; return; } // 等待期間已經換歌了
    if (P.waitingNet !== key || !P.lastSrc) return;
    dbg('網路恢復,重新載入目前這首');
    setStatus('網路已恢復，繼續播放');
    P.loadSource(P.lastSrc.key, P.lastSrc.url);
  }
  audio.addEventListener('loadedmetadata', () => {
    if (P.resumeAt && P.resumeAt.key === P.nowKey() && seekable()) { try { audio.currentTime = Math.max(0, Math.min(P.resumeAt.t, audio.duration - 1)); } catch {} }
    P.resumeAt = null;
  });
  audio.addEventListener('waiting', () => { if (!P.waitingSince) P.waitingSince = Date.now(); });
  for (const ev of ['playing', 'pause', 'emptied']) audio.addEventListener(ev, () => { P.waitingSince = 0; });
  audio.addEventListener('error', async () => {
    P.pendingPlay = false;
    dbg('error', audio.error && audio.error.code, 'hidden=', document.hidden, 'time=', audio.currentTime);
    if (!P.currentFile && !P.onlineCurrent) return;
    const key = P.nowKey();
    if (!(await stillLoggedIn())) return;
    if (P.nowKey() !== key) return; // 等待期間已經換歌了
    // 先確認是不是網路問題:連不上就等,不要一直跳歌
    if (!(await netOk())) {
      if (P.nowKey() === key) waitForNetwork(key);
      return;
    }
    if (P.nowKey() !== key) return;
    if (P.onlineCurrent) {
      setStatus(`「${P.onlineCurrent.title || '這部影片'}」目前播不了，可能被平台限制或已經下架。請換一首。`, { type: 'error' });
      if (P.queue.length) P.later(advance);
      return;
    }
    // 網路正常、只有這首失敗:先重試同一首,連續失敗多次才略過
    if (P.errorRetryKey !== key) { P.errorRetryKey = key; P.errorRetry = 0; }
    if (P.errorRetry < P.ERROR_RETRIES && P.lastSrc) {
      P.errorRetry += 1;
      setStatus(`這首沒有載入成功，正在重試（${P.errorRetry}/${P.ERROR_RETRIES}）…`);
      dbg('載入失敗,重試同一首', P.errorRetry + '/' + P.ERROR_RETRIES);
      setTimeout(() => { if (P.nowKey() === key && P.lastSrc) P.loadSource(P.lastSrc.key, P.lastSrc.url); }, 1500 * P.errorRetry);
      return;
    }
    P.errorRetryKey = '';
    P.errorStreak += 1;
    // 上限依實際的播放範圍(播放清單或音樂庫清單＋佇列)算:播放清單播放中時音樂庫的搜尋只剩 1 首,不該壞一首就整個停掉
    const scopeLen = (P.playlistCtx ? P.playlistCtx.items.length : P.view.length) + P.queue.length;
    const failedTitle = (P.currentFile && P.byFile.get(P.currentFile)?.name) || '這首';
    if (P.errorStreak < Math.min(scopeLen, 5)) { setStatus(`「${failedTitle}」播不出來，已跳到下一首。`); P.later(advance); }
    else setStatus(`連續 ${P.errorStreak} 首都播不出來，已停止播放。請確認網路後再試一次。`, { type: 'error' });
  });

  // ── 補救機制(頁面醒來 / 事件漏掉)──
  function recover() {
    // 網路中斷等待中:只負責探測網路,恢復了就重新載入這首(不做其他補救,避免互相干擾)
    if (P.waitingNet) { checkNetWait(); return; }
    // 沒有任何播放意圖了(播完、使用者暫停、放棄恢復):停掉靜音保活元素
    if (!keep.paused && (audio.paused || audio.ended) && !P.pendingPlay && !P.switchPending) { dbg('保活元素:無播放意圖,停止'); keepOff(); }
    if (!P.currentFile && !P.onlineCurrent) return;
    // 串流中途卡在緩衝超過 12 秒:確認是不是斷網,是的話停下來等,不是就繼續等(重新計時)
    if (P.waitingSince && !audio.paused && !P.netChecking && Date.now() - P.waitingSince > 12000) {
      P.netChecking = true;
      const k = P.nowKey();
      netOk().then((ok) => {
        P.netChecking = false;
        if (P.nowKey() !== k) return;
        if (!ok) waitForNetwork(k); else P.waitingSince = Date.now();
      });
    }
    if (audio.ended && !P.endHandled) { dbg('recover: 補呼叫 ended'); onEnded(); return; }
    if (IS_ANDROID && P.switchPending && P.currentFile && audio.readyState === 0 && P.lastSrc && Date.now() - P.loadAt > 10000) {
      dbg('recover: 載入逾時(>10s),重新載入'); P.loadSource(P.lastSrc.key, P.lastSrc.url); return;
    }
    if (IS_ANDROID && P.switchPending && audio.paused && !audio.ended) {
      // readyState 0 且沒在載入(networkState 2 = LOADING):請求已經死了,重新載入
      if (audio.readyState === 0 && audio.networkState !== 2 && P.lastSrc) {
        dbg('recover: 音源未載入,重新載入'); P.loadSource(P.lastSrc.key, P.lastSrc.url); return;
      }
      dbg('recover: 已換歌但未播放,補打 play'); P.tryPlay(1); return;
    }
    if (P.pendingPlay && audio.paused) { dbg('recover: 補打 play'); P.tryPlay(1); }
  }
  // interval 在背景會被節流,只在前景有用;真正的補救靠下面三個「醒來」事件
  setInterval(recover, 3000);
  document.addEventListener('visibilitychange', () => { dbg('visibility', document.visibilityState); recover(); });
  window.addEventListener('pageshow', recover);
  window.addEventListener('online', () => { P.netProbeAt = 0; recover(); });

  Object.assign(P, {
    entryKey, seekable,
  });
})();
