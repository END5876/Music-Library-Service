// playlists/context.js — 播放清單 → 佇列（播放清單播放狀態）
import { libAvailable, mkLib, mkOnline } from '../queue/model.js';
import { savePrefs } from '../core/prefs.js';
import { setStatus } from '../core/toast.js';
import { shuffled } from '../core/util.js';
import { renderNext } from '../queue/view.js';
import { currentEntry, entryKey, playEntry } from '../playback/controller.js';
import { syncButtons } from '../audio/controls.js';
import { plById } from './model.js';
import { S } from '../core/state.js';

// ── 播放清單 → 佇列 ───────────────────────────────────
const ctxEntry = (it) => {
  const e = it.kind === 'lib' ? mkLib(it.filename, it.title) : mkOnline(it);
  e.src = it.id;
  return e;
};

const ctxPlayable = (it) => it.kind === 'online' || libAvailable(it.filename);

// 依目前的隨機/循環設定,把播放清單剩下的歌排進佇列
// full=true:新一輪(包含目前這首)
export function refillFromCtx(full = false) {
  if (!S.playlistCtx) return;
  const cur = currentEntry(), ck = cur ? entryKey(cur) : null;
  let list = S.playlistCtx.items.filter(ctxPlayable).map(ctxEntry);
  if (S.shuffle) {
    if (!full && ck) list = list.filter((e) => entryKey(e) !== ck);
    list = shuffled(list);
    if (full && ck && list.length > 1 && entryKey(list[0]) === ck) {
      const j = 1 + Math.floor(Math.random() * (list.length - 1));
      [list[0], list[j]] = [list[j], list[0]];
    }
  } else if (!full && ck) {
    const i = list.findIndex((e) => entryKey(e) === ck);
    if (i >= 0) list = list.slice(i + 1);
  }
  S.queue = list;
  renderNext();
}

// 播放清單內容變動(加入/移除/排序)時,讓進行中的播放跟著更新
export function syncCtx(pid, { added = [], removedId = null, reordered = false } = {}) {
  if (!S.playlistCtx || S.playlistCtx.id !== pid) return;
  const p = plById(pid);
  S.playlistCtx.items = p ? p.items : [];
  if (removedId) S.queue = S.queue.filter((e) => e.src !== removedId);
  for (const it of added) {
    if (!ctxPlayable(it)) continue;
    const e = ctxEntry(it);
    if (S.shuffle) S.queue.splice(Math.floor(Math.random() * (S.queue.length + 1)), 0, e); else S.queue.push(e);
  }
  if (reordered && !S.shuffle) refillFromCtx();
  renderNext();
}

export function playPlaylist(pid, startId, { shuffleStart = false } = {}) {
  const p = plById(pid); if (!p) return;
  const items = p.items.filter(ctxPlayable);
  if (!items.length) return setStatus('這個播放清單沒有可播放的歌曲');
  if (shuffleStart) { S.shuffle = true; syncButtons(); savePrefs(); }
  let first;
  if (startId) first = items.find((it) => it.id === startId) || items[0];
  else if (shuffleStart) first = items[Math.floor(Math.random() * items.length)];
  else first = items[0]; // ▶ 一律從第一首開始(隨機開啟時,後面的順序才會打亂)
  S.playlistCtx = { id: pid, items: p.items };
  S.history = [];
  S.queue = [];
  playEntry(first.kind === 'lib' ? { kind: 'lib', filename: first.filename, title: first.title } : { kind: 'online', item: first });
  refillFromCtx();
  if (shuffleStart) setStatus('🔀 隨機播放「' + p.name + '」');
}
