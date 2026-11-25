'use strict';
// playerAccount.js — 播放器：登入（Discord、代碼交接）與帳號選單。
// 跨檔共用的狀態與函式放在 window.MLPlayer（以下簡稱 P）；各檔的分工與載入順序見 player.js 開頭。
(() => {
  const P = window.MLPlayer;
  const { $, askConfirm } = window.MLUi;
  const { keepOff } = window.MLPlatform;
  const audio = $('audio');

  // 給其他檔案用的函式
  Object.assign(P, {
    loadMe, showLogin,
  });

  // ── 登入(Discord) ──
  // 一般瀏覽器:整頁跳到 Discord 授權再導回來。iOS 主畫面 App 跟 Safari 不共用 Cookie,跳出去登入後回不到 App,
  // 改用代碼交接(見 webplayer/webAuth.js):App 拿一組代碼,在瀏覽器登入並確認後,App 輪詢取得登入。
  // 其他平台的主畫面 App 也留一個「改用代碼登入」的按鈕備用。
  const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const IOS_STANDALONE = navigator.standalone === true; // 只有 iOS 有 navigator.standalone
  // 被拒絕過之後再登入要能換 Discord 帳號:帶 switch=1,Discord 會顯示同意畫面(上面有「不是你?」)
  let switchAccount = false;
  const deniedMsg = (uid) => `這個 Discord 帳號${uid ? `(ID ${uid})` : ''}已被管理員停用。可以再按登入換一個帳號`;
  // 目前登入的帳號(GET /web/api/me)。管理功能(刪除／改名／移動音樂庫檔案、Bot 正在播放)只有管理員看得到;
  // 伺服器端一樣會擋(見 webplayer/webPlayer.js),這裡只是不顯示用不了的按鈕
  P.me = { id: null, name: '', admin: false };
  async function loadMe() {
    let next;
    try {
      const r = await fetch('/web/api/me');
      if (!r.ok) return;
      next = await r.json();
    } catch { return; }
    let last = null;
    try {
      last = localStorage.getItem('ml-uid');
      if (next.id) localStorage.setItem('ml-uid', next.id);
    } catch { /* 無痕模式等不能用 localStorage */ }
    // 換了帳號(例如上一個人的登入過期後,另一個人在同一台裝置用代碼登入,頁面沒有重新載入):
    // 清掉上一個人的播放清單、佇列、Bot 狀態與離線資料快取,再由呼叫端載入這個帳號的播放清單
    const prev = P.me.id || last;
    if (next.id && prev && prev !== next.id) {
      resetAccountState();
      P.render();
      await P.clearDataCaches();
    }
    P.me = next;
    paintAccount();
    showAdminUi();
    if (P.me.admin) P.bots.refresh();
  }
  function showAdminUi() {
    document.querySelectorAll('[data-view="bots"], [data-view="upload"], #libUploadBtn, #libBotBtn').forEach((b) => { b.hidden = !P.me.admin; });
    // 音樂庫上方的全部／公開／私人標籤:清單比帳號資訊先載入,確認身分後重畫(登出時收起並回到「全部」)
    const before = P.folder;
    P.renderChips();
    if (P.folder !== before) P.applyFilter();
    if (!P.me.admin && (P.mode === 'bots' || P.mode === 'upload')) P.setMode('library');
    // 管理員:背景接回伺服器上的上傳處理進度(頁籤徽章、處理完自動重新載入音樂庫)
    if (P.me.admin && !P.uploaderStarted) { P.uploaderStarted = true; P.uploader.init(); }
    if (!P.me.admin) P.uploaderStarted = false;
    // 舊的 /upload 網址會導到 /player?panel=upload,或上次停在上傳頁籤:確認是管理員後直接打開
    let lastTab = false;
    try { lastTab = localStorage.getItem(P.UPLOAD_TAB_KEY) === '1'; } catch {}
    if (P.me.admin && (openUploadPanel || lastTab) && P.mode !== 'upload') { openUploadPanel = false; P.setMode('upload'); }
  }
  let openUploadPanel = (() => {
    const u = new URL(location.href);
    if (u.searchParams.get('panel') !== 'upload') return false;
    u.searchParams.delete('panel');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    return true;
  })();
  // Discord 登入導回來的結果(?login=denied 等):第一次叫出登入框時顯示,並從網址拿掉
  // 注意:這個閉包裡的 history 是播放紀錄陣列,瀏覽器的要用 window.history
  let loginNotice = (() => {
    const u = new URL(location.href);
    const result = u.searchParams.get('login');
    if (!result) return '';
    const uid = (u.searchParams.get('uid') || '').replace(/\D/g, '');
    u.searchParams.delete('login'); u.searchParams.delete('uid');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    if (result === 'denied') { switchAccount = true; return deniedMsg(uid); }
    if (result === 'cancelled') return '已取消登入';
    return 'Discord 登入失敗，請稍後再試';
  })();
  let handoffTimer = null, handoffBusy = false, handoffStarting = false;
  const withSwitch = (url) => switchAccount ? url + '&switch=1' : url;
  function showLogin(msg) {
    $('login').classList.add('show');
    $('loginErr').textContent = msg || loginNotice;
    loginNotice = '';
    $('loginBtn').href = withSwitch('/auth/discord/login?next=' + encodeURIComponent(location.pathname + location.search));
    if (!handoffTimer) resetHandoff();
    $('loginBtn').focus();
  }
  function loginDone() {
    $('login').classList.remove('show'); P.loadList();
    if ((P.currentFile || P.onlineCurrent) && audio.error) { audio.load(); P.tryPlay(); } // 播到一半登入過期:登入後接著重播
  }
  function resetHandoff() {
    clearInterval(handoffTimer); handoffTimer = null;
    $('handoff').hidden = true;
    $('loginBtn').hidden = false;
    $('handoffBtn').hidden = !STANDALONE || IOS_STANDALONE;
  }
  async function startHandoff() {
    if (handoffStarting) return; // 連點兩下:只要一組代碼
    handoffStarting = true;
    resetHandoff();
    $('loginErr').textContent = '';
    try {
      // 伺服器會順便作廢這個 App 之前要的代碼(不佔名額)
      const r = await fetch('/auth/handoff/start', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { $('loginErr').textContent = j.error || '無法取得登入代碼'; return; }
      $('handoffCode').textContent = j.code;
      $('handoffOpen').href = withSwitch(j.loginUrl);
      $('handoffStatus').textContent = '等待登入…';
      $('handoff').hidden = false; $('loginBtn').hidden = true; $('handoffBtn').hidden = true;
      handoffTimer = setInterval(pollHandoff, 2000);
    } catch { $('loginErr').textContent = '連線失敗，請檢查網路後再試一次'; } finally { handoffStarting = false; }
  }
  // 瀏覽器那邊的進度(伺服器回 202 的 status)
  const HANDOFF_STATUS = {
    pending: () => '等待登入…',
    confirming: () => '請在瀏覽器按「登入 App」',
    cancelled: () => '已在 Discord 取消登入，可以在瀏覽器再試一次',
    failed: () => 'Discord 登入失敗，可以在瀏覽器再試一次',
    denied: (j) => deniedMsg(String(j.uid || '').replace(/\D/g, '')),
  };
  async function pollHandoff() {
    if (handoffBusy || !handoffTimer) return;
    handoffBusy = true;
    try {
      const r = await fetch('/auth/handoff/poll', { method: 'POST' });
      if (!handoffTimer) return; // 等回應的時候已經結束(取消或另一次輪詢已完成)
      if (r.status === 202) {
        const j = await r.json().catch(() => ({}));
        if (j.status === 'denied' && !switchAccount) { switchAccount = true; $('handoffOpen').href += '&switch=1'; }
        $('handoffStatus').textContent = (HANDOFF_STATUS[j.status] || HANDOFF_STATUS.pending)(j);
        return;
      }
      const j = r.ok ? null : await r.json().catch(() => ({}));
      resetHandoff();
      if (r.ok) return loginDone();
      $('loginErr').textContent = (j && j.error) || '登入代碼已過期，請重新開始';
    } catch { /* 網路暫時斷線:下一輪再試 */ } finally { handoffBusy = false; }
  }
  // 從瀏覽器切回 App 時立刻檢查一次,不用等下一輪
  document.addEventListener('visibilitychange', () => { if (!document.hidden && handoffTimer) pollHandoff(); });
  $('loginBtn').addEventListener('click', (e) => {
    if (!IOS_STANDALONE) return; // 照連結整頁跳轉
    e.preventDefault();
    startHandoff();
  });
  $('handoffBtn').addEventListener('click', startHandoff);
  // 例如瀏覽器那邊沒按確認就關掉了:代碼在伺服器上作廢,不用等過期就能重來
  $('handoffCancel').addEventListener('click', () => {
    resetHandoff();
    fetch('/auth/handoff/cancel', { method: 'POST' }).catch(() => {});
  });
  // 登出或換帳號:停止播放,清掉這個帳號的資料(播放清單、佇列、播放紀錄、Bot 狀態、離線資料快取)。
  // 音樂庫清單是共用的,換帳號時保留;登出時由呼叫端另外清掉
  function resetAccountState() {
    P.pendingPlay = false; P.switchPending = false; P.userPaused = true;
    audio.pause(); keepOff();
    P.setSession('none');
    P.queue = []; P.history = [];
    P.playlists = []; P.plOpen = null; P.playlistCtx = null; P.clearDataCaches(); P.bots.reset();
    P.me = { id: null, name: '', admin: false }; showAdminUi();
    P.currentFile = null; P.onlineCurrent = null;
    P.dropPreload(); keepOff();
    $('onlineResults').textContent = '';
    audio.removeAttribute('src'); audio.load();
    P.setNow(null);
  }
  // ── 帳號鈕:選單沿用歌曲列的「⋮」選單(menuEl/placeMenu),頂端顯示登入的是誰 ──
  function paintAccount() {
    const name = P.me.name || '';
    $('acctAvatar').textContent = name ? Array.from(name)[0].toUpperCase() : '?';
    $('acctBtn').setAttribute('aria-label', name ? `帳號：${name}` : '帳號');
  }
  $('acctBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const anchor = $('acctBtn');
    if (P.menuAnchor === anchor) return P.closeRowMenu();
    P.menuAnchor = anchor;
    P.menuEl.textContent = '';
    const info = document.createElement('div'); info.className = 'acct-info';
    const b = document.createElement('b'); b.textContent = P.me.name || '已登入';
    const s = document.createElement('span'); s.textContent = P.me.admin ? '用 Discord 登入（管理員）' : '用 Discord 登入';
    info.append(b, s);
    P.menuEl.appendChild(info);
    P.menuItem('logout', '登出', confirmLogout);
    P.placeMenu(anchor);
  });

  async function confirmLogout() {
    // 只有上傳還沒傳完時多一句提醒(那是登出後唯一會失去的東西)
    if (!await askConfirm('確認登出？', P.uploader.busy() ? '還沒傳完的上傳會停止。' : '', { ok: '登出' })) return;
    P.pendingPlay = false; P.userPaused = true; audio.pause(); // 等伺服器回應的期間先停下來
    await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
    resetAccountState();
    P.all = []; P.view = []; P.byFile = new Map();
    P.render();
    $('acctBtn').hidden = true;
    showLogin();
  }
})();
