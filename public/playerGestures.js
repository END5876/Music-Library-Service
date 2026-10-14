'use strict';
// playerGestures.js
// 手機手勢（只對觸控生效，滑鼠操作不受影響），從 player.js 拆出，邏輯不變：
//   長按歌曲列     → 進入多選並選取這首（音樂庫、播放清單內頁）
//   全螢幕播放頁   → 往下滑收合
//   底部迷你播放列 → 左滑下一首、右滑上一首、上滑展開
// setupGestures(deps)：deps 由 player.js 傳入（多選控制器與播放控制函式），本檔不直接讀 player.js 的變數。
// 載入順序：必須早於 player.js。
(() => {
  function setupGestures({ $, libSel, plSel, setLibSelecting, setPlSelecting, isFullOpen, openFull, closeFull, advance, prev }) {
    const buzz = () => { try { if (navigator.vibrate) navigator.vibrate(15); } catch {} };
    // 手勢結束後瀏覽器可能還會補一個 click(例如長按放開):只吃掉落在同一個元素裡的那一次
    let swallow = null; // { el, until }
    const swallowClick = (el) => { swallow = { el, until: Date.now() + 700 }; };
    document.addEventListener('click', (e) => {
      if (!swallow) return;
      const s = swallow; swallow = null;
      if (Date.now() < s.until && s.el.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    }, true);

    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      const row = e.target.closest('#list .row[data-key], #plItems .row[data-iid]');
      if (!row || e.target.closest('.rbtn, .grip')) return;
      const inLib = !!row.closest('#list');
      if (inLib ? libSel.on : plSel.on) return; // 已經在多選:點一下就能切換
      const x0 = e.clientX, y0 = e.clientY;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
      };
      const move = (ev) => { if (Math.abs(ev.clientX - x0) > 10 || Math.abs(ev.clientY - y0) > 10) cleanup(); };
      const timer = setTimeout(() => {
        cleanup(); buzz();
        if (inLib) { setLibSelecting(true); libSel.toggle(row.dataset.key.slice(4)); swallowClick($('list')); }
        else { setPlSelecting(true); plSel.toggle(row.dataset.iid); swallowClick($('plItems')); }
      }, 500);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
    });
    // 觸控裝置長按不要跳出系統的選單／選字
    document.addEventListener('contextmenu', (e) => {
      if (matchMedia('(hover: none)').matches && e.target.closest('.row')) e.preventDefault();
    });

    (() => {
      const full = $('full');
      let active = false, y0 = 0, dy = 0, t0 = 0;
      full.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || !isFullOpen()) return;
        if (e.target.closest('input, button, .queue')) return; // 進度條、按鈕、佇列照常操作
        active = true; y0 = e.clientY; dy = 0; t0 = Date.now();
      });
      full.addEventListener('pointermove', (e) => {
        if (!active) return;
        dy = Math.max(0, e.clientY - y0);
        full.style.transition = 'none';
        full.style.transform = `translateY(${dy}px)`;
      });
      const end = () => {
        if (!active) return;
        active = false;
        full.style.transition = '';
        full.style.transform = ''; // 收合時直接從手指放開的位置接著滑下去,否則彈回原位
        const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.5;
        if (dy > 10) swallowClick(full);
        if (dy > 120 || fast) closeFull();
      };
      full.addEventListener('pointerup', end);
      full.addEventListener('pointercancel', end);
    })();

    (() => {
      const mini = $('miniOpen');
      let active = false, x0 = 0, y0 = 0, dx = 0, dy = 0;
      mini.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || e.target.closest('button')) return;
        active = true; x0 = e.clientX; y0 = e.clientY; dx = 0; dy = 0;
      });
      mini.addEventListener('pointermove', (e) => {
        if (!active) return;
        dx = e.clientX - x0; dy = e.clientY - y0;
        if (Math.abs(dx) > Math.abs(dy)) {
          mini.style.transition = 'none';
          mini.style.transform = `translateX(${dx}px)`;
          mini.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 300));
        }
      });
      const end = () => {
        if (!active) return;
        active = false;
        mini.style.transition = 'transform .2s, opacity .2s';
        mini.style.transform = ''; mini.style.opacity = '';
        const horiz = Math.abs(dx) > Math.abs(dy);
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) swallowClick(mini);
        if (horiz && Math.abs(dx) > 80) { buzz(); if (dx < 0) advance(); else prev(); }
        else if (!horiz && dy < -50) openFull();
      };
      mini.addEventListener('pointerup', end);
      mini.addEventListener('pointercancel', end);
    })();
  }

  window.MLGestures = { setupGestures };
})();
