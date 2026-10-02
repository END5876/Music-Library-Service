// playback/controller.js — 播放控制：播放／下一首／上一首／歷史
import { audio } from '../core/dom.js';
import { dbg } from '../core/debug.js';
import { mkLib, mkOnline } from '../queue/model.js';
import { S, offlineKeys } from '../core/state.js';
import { streamUrl } from '../core/util.js';
import { setStatus } from '../core/toast.js';
import { tryPlay } from '../audio/helpers.js';
import { libSub } from '../ui/rows.js';
import { markPlaying, setNow, start } from '../library/library.js';
import { buildShuffle } from '../queue/shuffle.js';
import { renderNext } from '../queue/view.js';
import { seekable } from '../audio/events.js';
import { playOnline } from '../online/online.js';
import { loadSource } from '../offline/source.js';
import { refillFromCtx } from '../playlists/context.js';

// ── 播放 ──
// 歷史與佇列使用同一種項目格式({kind:'lib',filename} / {kind:'online',item}),「上一首」才能回到線上歌曲
export const entryKey = (e) => e.kind === 'lib' ? 'lib:' + e.filename : 'on:' + (e.item.srcUrl || e.item.url);

export function currentEntry() {
  if (S.currentFile) return { kind: 'lib', filename: S.currentFile };
  if (S.onlineCurrent) return { kind: 'online', item: S.onlineCurrent };
  return null;
}

export function pushHistory() {
  const c = currentEntry(); if (!c) return;
  S.history.push(c);
  if (S.history.length > 200) S.history.shift();
}

export function play(filename, { pushHistory: ph = true, title } = {}) {
  const track = S.byFile.get(filename)
    || (offlineKeys.has('lib:' + filename) ? { filename, name: title || filename.split('/').pop(), size: 0 } : null);
  if (!track) return false;
  if (ph && S.currentFile !== filename) pushHistory();
  dbg('play', filename);
  S.onlineCurrent = null;
  S.currentFile = filename;
  S.endHandled = false;
  loadSource('lib:' + filename, streamUrl(filename));
  setStatus('');
  setNow({ title: track.name, sub: libSub(track) });
  return true;
}

export function playEntry(e, opts) {
  if (e.kind === 'online') return playOnline(e.item, opts);
  if (!play(e.filename, { ...opts, title: e.title })) advance(); // 檔案已不存在就跳過
}

export function playFromQueue(id) {
  const i = S.queue.findIndex(x => x.id === id);
  if (i < 0) return;
  const [e] = S.queue.splice(i, 1);
  playEntry(e);
}

export function pickNext() { // 非隨機模式:依清單順序
  if (!S.view.length) return null;
  const i = S.view.findIndex(f => f.filename === S.currentFile);
  if (i < 0) return S.view[0].filename;
  if (i + 1 < S.view.length) return S.view[i + 1].filename;
  return S.repeat === 'all' ? S.view[0].filename : null;
}

export function advance() {
  dbg('advance, queue=', S.queue.length);
  if (S.queue.length) { playEntry(S.queue.shift()); return; }
  if (S.playlistCtx) {
    if (S.repeat === 'off') { setStatus('✅ 播放清單播放完畢'); return; }
    refillFromCtx(true); // 循環:新一輪
    if (S.queue.length) { playEntry(S.queue.shift()); return; }
    S.playlistCtx = null;
  }
  if (S.onlineCurrent) { S.onlineCurrent = null; markPlaying(); renderNext(); setStatus('✅ 佇列播放完畢'); return; }
  if (S.shuffle) {
    if (!S.view.length) return;
    if (S.repeat === 'off' && S.currentFile) { setStatus('✅ 隨機清單播放完畢'); return; }
    buildShuffle({ includeCurrent: true }); // 一輪播完:排出下一輪(剛播完的那首也要在裡面)
    if (S.queue.length) playEntry(S.queue.shift());
    else if (S.currentFile) { audio.currentTime = 0; tryPlay(); }
    return;
  }
  const n = pickNext();
  if (n) play(n);
}

export function prev() {
  // 已播放超過 3 秒:回到開頭(線上串流不能拖曳,就重新串流)
  if ((S.currentFile || S.onlineCurrent) && audio.currentTime > 3) {
    if (seekable()) audio.currentTime = 0;
    else if (S.onlineCurrent) playOnline(S.onlineCurrent, { pushHistory: false });
    return;
  }
  while (S.history.length) {
    const e = S.history.pop();
    if (e.kind === 'lib' && !S.byFile.has(e.filename)) continue; // 檔案已不存在:再往前找
    const cur = currentEntry();
    // 隨機模式或目前是線上歌曲:把目前這首放回佇列最前面,按「下一首」還能回來(先去重,避免連按「上一首」出現重複項)
    if (cur && (S.shuffle || cur.kind === 'online')) {
      S.queue = S.queue.filter(x => entryKey(x) !== entryKey(cur));
      S.queue.unshift(cur.kind === 'lib' ? mkLib(cur.filename) : mkOnline(cur.item));
    }
    playEntry(e, { pushHistory: false });
    renderNext();
    return;
  }
  if (S.onlineCurrent) { playOnline(S.onlineCurrent, { pushHistory: false }); return; }
  if (S.shuffle) return;
  const i = S.view.findIndex(f => f.filename === S.currentFile);
  if (i > 0) play(S.view[i - 1].filename, { pushHistory: false });
  else if (S.view.length && S.repeat === 'all') play(S.view[S.view.length - 1].filename, { pushHistory: false });
}

export function toggle() {
  if (!S.currentFile && !S.onlineCurrent) {
    if (S.queue.length) { advance(); return; } // 佇列(含重開頁面時排好的隨機佇列、手動加入的線上歌曲)優先
    if (!S.view.length) return;
    start(S.shuffle ? S.view[Math.floor(Math.random() * S.view.length)].filename : S.view[0].filename);
    return;
  }
  if (audio.paused) tryPlay(); else { S.pendingPlay = false; audio.pause(); }
}
