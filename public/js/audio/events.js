// audio/events.js — <audio> 事件、進度條、錯誤處理與背景補救
import { $, audio } from '../core/dom.js';
import { dbg } from '../core/debug.js';
import { savePrefs } from '../core/prefs.js';
import { fmt, setIcon } from '../core/util.js';
import { setStatus } from '../core/toast.js';
import { later, setSession, tryPlay } from './helpers.js';
import { nowKey } from '../library/library.js';
import { advance } from '../playback/controller.js';
import { stillLoggedIn } from '../auth/auth.js';
import { prefetchNext } from './prefetch.js';
import { playOnline } from '../online/online.js';
import { S } from '../core/state.js';

export const seekable = () => isFinite(audio.duration) && audio.duration > 0;

export function updateProgress() {
  const can = seekable();
  const cur = audio.currentTime || 0;
  const p = can ? Math.min(100, cur / audio.duration * 100) : 0;
  for (const r of [$('seek'), $('fSeek')]) {
    r.disabled = !can;
    if (!S.dragging) r.value = p * 10;
    r.style.setProperty('--p', p + '%');
  }
  const durText = can ? fmt(audio.duration) : ((S.currentFile || S.onlineCurrent) ? '串流中' : '0:00');
  $('timeText').textContent = `${fmt(cur)} / ${durText}`;
  $('fCur').textContent = fmt(cur);
  $('fDur').textContent = durText;
  $('miniProg').style.width = p + '%';
}

export function updatePlayIcons() {
  const name = audio.paused ? 'play' : 'pause';
  ['toggle', 'miniToggle', 'fToggle'].forEach(id => setIcon($(id), name));
  $('bigCover').classList.toggle('paused', audio.paused);
}

for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'emptied', 'seeked']) audio.addEventListener(ev, updateProgress);

for (const ev of ['play', 'pause', 'ended', 'emptied']) audio.addEventListener(ev, updatePlayIcons);

// ended 可重入:事件漏掉時 recover() 也能安全補呼叫,且同一次結束只處理一次
function onEnded() {
  if (S.endHandled) return;
  S.endHandled = true;
  dbg('ended');
  S.errorStreak = 0;
  if (S.repeat === 'one') {
    if (S.onlineCurrent) playOnline(S.onlineCurrent);
    else { audio.currentTime = 0; tryPlay(); }
  } else advance();
}

audio.addEventListener('ended', onEnded);

audio.addEventListener('emptied', () => { S.endHandled = false; });

audio.addEventListener('pause', () => {
  // 真正發生 pause(使用者、來電、系統中斷):不要讓 recover() 自動恢復
  // 播放自然結束時也會先觸發 pause,那種情況不算
  if (audio.ended) return;
  S.pendingPlay = false;
  setSession('paused');
  dbg('pause');
});

audio.addEventListener('playing', () => {
  S.errorStreak = 0; S.pendingPlay = false; S.endHandled = false;
  setSession('playing'); setStatus('');
  dbg('playing');
  prefetchNext();
});

audio.addEventListener('volumechange', () => {
  $('vol').value = Math.round(audio.volume * 100);
  $('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');
  savePrefs();
});

audio.addEventListener('error', async () => {
  S.pendingPlay = false;
  dbg('error', audio.error && audio.error.code);
  if (!S.currentFile && !S.onlineCurrent) return;
  const key = nowKey();
  if (!(await stillLoggedIn())) return;
  if (nowKey() !== key) return; // 等待期間已經換歌了
  if (S.onlineCurrent) {
    setStatus('線上串流失敗(可能被平台限制、影片不可用或伺服器忙碌)');
    if (S.queue.length) later(advance);
    return;
  }
  S.errorStreak += 1;
  if (S.errorStreak < Math.min(S.view.length, 5)) { setStatus('這首無法播放,已略過'); later(advance); }
  else setStatus('連續多首無法播放,已停止');
});

// ── 補救機制(頁面醒來 / 事件漏掉)──
function recover() {
  if (!S.currentFile && !S.onlineCurrent) return;
  if (audio.ended && !S.endHandled) { dbg('recover: 補呼叫 ended'); onEnded(); return; }
  if (S.pendingPlay && audio.paused) { dbg('recover: 補打 play'); tryPlay(1); }
}

// interval 在背景會被節流,只在前景有用;真正的補救靠下面三個「醒來」事件
setInterval(recover, 3000);

document.addEventListener('visibilitychange', () => { dbg('visibility', document.visibilityState); recover(); });

window.addEventListener('pageshow', recover);

window.addEventListener('online', recover);
