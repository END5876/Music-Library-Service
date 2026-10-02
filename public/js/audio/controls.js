// audio/controls.js — 播放控制列按鈕、進度條、音量、隨機／循環
import { $, audio } from '../core/dom.js';
import { REPEATS, REPEAT_LABEL } from '../core/constants.js';
import { savePrefs } from '../core/prefs.js';
import { setIcon } from '../core/util.js';
import { setStatus } from '../core/toast.js';
import { buildShuffle } from '../queue/shuffle.js';
import { renderNext } from '../queue/view.js';
import { advance, play, prev, toggle } from '../playback/controller.js';
import { seekable, updateProgress } from './events.js';
import { refillFromCtx } from '../playlists/context.js';
import { S } from '../core/state.js';

// ── 控制項 ──
export function syncButtons() {
  ['shuffle', 'fShuffle'].forEach(id => $(id).classList.toggle('on', S.shuffle));
  ['repeat', 'fRepeat'].forEach(id => {
    $(id).classList.toggle('on', S.repeat !== 'off');
    setIcon($(id), S.repeat === 'one' ? 'repeat1' : 'repeat');
    $(id).title = REPEAT_LABEL[S.repeat];
  });
  renderNext();
}

export const cycleRepeat = () => { S.repeat = REPEATS[(REPEATS.indexOf(S.repeat) + 1) % REPEATS.length]; syncButtons(); savePrefs(); setStatus(REPEAT_LABEL[S.repeat]); };

export function toggleShuffle() {
  S.shuffle = !S.shuffle;
  if (S.playlistCtx) refillFromCtx(); else if (S.shuffle) buildShuffle();                       // 點下去的當下就排好
  else S.queue = S.queue.filter(e => e.kind === 'online'); // 關閉:回到依清單順序,保留手動加入的線上歌曲
  syncButtons(); savePrefs();
  setStatus(S.shuffle ? '🔀 隨機播放:開(已排好佇列,可在「佇列」拖曳調整)' : '隨機播放:關');
}

['toggle', 'miniToggle', 'fToggle'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); toggle(); }));

['next', 'miniNext', 'fNext'].forEach(id => $(id).addEventListener('click', (e) => { e.stopPropagation(); advance(); }));

['prev', 'fPrev'].forEach(id => $(id).addEventListener('click', prev));

['shuffle', 'fShuffle'].forEach(id => $(id).addEventListener('click', toggleShuffle));

['repeat', 'fRepeat'].forEach(id => $(id).addEventListener('click', cycleRepeat));

for (const id of ['seek', 'fSeek']) {
  const r = $(id);
  r.addEventListener('pointerdown', () => { S.dragging = true; });
  const end = () => { S.dragging = false; };
  r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end); r.addEventListener('blur', end);
  r.addEventListener('input', (e) => {
    if (!seekable()) return;
    audio.currentTime = e.target.value / 1000 * audio.duration;
    updateProgress();
  });
}

$('vol').addEventListener('input', (e) => { audio.volume = e.target.value / 100; });

$('vol').value = Math.round(audio.volume * 100);

$('vol').style.setProperty('--p', Math.round(audio.volume * 100) + '%');

$('shuffleAll').addEventListener('click', () => {
  if (!S.view.length) return;
  S.shuffle = true;
  S.playlistCtx = null;
  S.history = [];
  play(S.view[Math.floor(Math.random() * S.view.length)].filename);
  buildShuffle();
  syncButtons(); savePrefs();
  setStatus('🔀 已排出隨機佇列');
});
