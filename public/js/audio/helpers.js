// audio/helpers.js — 播放輔助：MediaSession 狀態、tryPlay、背景分頁安全的 later()
import { audio } from '../core/dom.js';
import { dbg } from '../core/debug.js';
import { setStatus } from '../core/toast.js';
import { S } from '../core/state.js';

// ── 背景播放穩定性 helper ──
export function setSession(state) {
  if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = state; } catch {} }
}

// 載入空檔也維持「播放中」;失敗最多重試 retries 次,之後放棄(避免 recover 無限重試)
export function tryPlay(retries = 3) {
  S.pendingPlay = true;
  setSession('playing');
  const p = audio.play();
  if (p && p.catch) p.catch((err) => {
    dbg('play() 被拒絕', err && err.name, '剩餘重試', retries);
    if (err && err.name === 'AbortError') return; // 被新的 load 取代,正常
    if (retries > 0 && S.pendingPlay) { setTimeout(() => tryPlay(retries - 1), 600); return; }
    S.pendingPlay = false;
    setSession('paused');
    setStatus('無法自動播放,請按播放鍵');
  });
}

// 背景分頁的 timer 會被節流甚至凍結:hidden 時直接同步執行
// (error / ended 都是非同步觸發的事件,同步呼叫不會造成遞迴)
export const later = (fn) => { if (document.hidden) fn(); else setTimeout(fn, 800); };
