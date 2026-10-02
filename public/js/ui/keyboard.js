// ui/keyboard.js — 鍵盤快捷鍵
import { audio } from '../core/dom.js';
import { advance, prev, toggle } from '../playback/controller.js';
import { seekable } from '../audio/events.js';
import { cycleRepeat, toggleShuffle } from '../audio/controls.js';
import { closeFull } from './fullscreen.js';

const skipKey = (e) => (e.target.matches && e.target.matches('input:not([type=range]), select, textarea')) || e.ctrlKey || e.metaKey || e.altKey;

// 空白鍵在按鈕上會在 keyup 觸發 click,與上面的全域播放／暫停疊加成「按了沒反應」
document.addEventListener('keyup', (e) => { if (e.key === ' ' && !skipKey(e)) e.preventDefault(); });

document.addEventListener('keydown', (e) => {
  if (skipKey(e)) return;
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  else if (e.key === 'n' || e.key === 'N') advance();
  else if (e.key === 'p' || e.key === 'P') prev();
  else if (e.key === 's' || e.key === 'S') toggleShuffle();
  else if (e.key === 'r' || e.key === 'R') cycleRepeat();
  else if (e.key === 'Escape') closeFull();
  // 焦點在進度條時瀏覽器本身也會處理方向鍵(±0.1%),要 preventDefault 才不會蓋掉 ±10 秒;音量條則保留原生行為
  else if (e.key === 'ArrowRight' && seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.min(audio.duration, audio.currentTime + 10); }
  else if (e.key === 'ArrowLeft' && seekable() && e.target.id !== 'vol') { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 10); }
});
