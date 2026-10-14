'use strict';
// playerPlatform.js
// 平台判斷與 Android 背景播放的「靜音保活」元素，從 player.js 拆出，邏輯不變。
//   ANDROID_BY / IS_ANDROID   是否為 Android（含偽裝成電腦版的平板），以及判斷依據
//   KEEP                      是否啟用靜音保活（Android 預設開；除錯面板可關）
//   keep / keepOn / keepOff   保活用的 <audio> 與開關
// 載入順序：playerDebug.js 之後、player.js 之前。
(() => {
  const { DEBUG_UI, dbg } = window.MLDebug;
  const lsFlag = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  // 針對「Android 鎖屏背景換歌被系統暫停」的補救:預設只在 Android 啟用,
  // 電腦與 iOS 瀏覽器維持原本的播放行為(可用除錯面板手動開關覆寫)。
  // Android 平板的 Chrome 常預設「電腦版網站」,UA 會偽裝成 "X11; Linux x86_64"、不含 Android,
  // 所以除了 UA / Client Hints 之外,再用「Linux(非 ChromeOS)+ 主要輸入是觸控、無滑鼠懸停」判斷。
  // 觸控螢幕的 Linux 筆電主要輸入是觸控板/滑鼠(pointer: fine、hover: hover),不會被誤判;iPad 的 UA 是 Macintosh,不受影響。
  const ANDROID_BY = (() => {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'ua';
    try { if (navigator.userAgentData && navigator.userAgentData.platform === 'Android') return 'uach'; } catch {}
    try {
      if (/\bLinux\b/i.test(ua) && !/CrOS/i.test(ua) && navigator.maxTouchPoints > 0
        && matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches) return 'desktop-mode';
    } catch {}
    return '';
  })();
  const IS_ANDROID = !!ANDROID_BY;
  const flagOn = (k, def) => { const v = lsFlag(k); return v === null ? def : v !== '0'; };
  const KEEP = IS_ANDROID && (!DEBUG_UI || flagOn('ml_keep', true));

  // ── 靜音保活元素 ──
  // 日誌顯示:Android 鎖屏、連續背景換歌時,換音源的瞬間(abort/emptied)播放中的媒體會短暫歸零,
  // 約 0.1~0.3 秒後系統就把這首暫停,同時背景網路請求也失敗(整個程序被降級)。
  // 做法:另開一個永遠不換音源、循環播放靜音 WAV 的 <audio>,讓換歌空窗期間頁面仍有媒體在播放。
  // 使用者暫停／播放結束時一併停止,不會一直佔著。
  let silentUrl = null;
  function silentWavUrl() {
    const rate = 8000, n = rate; // 1 秒、8-bit 單聲道
    const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128); // 8-bit PCM 的 128 = 靜音
    return (silentUrl = silentUrl || URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  }
  const keep = new Audio();
  keep.loop = true; keep.preload = 'auto'; keep.setAttribute('playsinline', '');
  let keepReady = false;
  function keepOn() {
    if (!KEEP) return;
    if (!keepReady) { keep.src = silentWavUrl(); keepReady = true; }
    if (!keep.paused) return;
    const p = keep.play();
    if (p && p.catch) p.catch((err) => dbg('保活元素 play 失敗', err));
  }
  function keepOff() { try { if (!keep.paused) keep.pause(); } catch {} }
  for (const ev of ['play', 'pause', 'error']) keep.addEventListener(ev, () => dbg('keep:' + ev, 'hidden=' + document.hidden));

  window.MLPlatform = { ANDROID_BY, IS_ANDROID, KEEP, keep, keepOn, keepOff };
})();
