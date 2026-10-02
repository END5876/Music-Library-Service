// playlists/actions.js — 播放清單操作（建立／加入／移除／排序／開啟）
import { $ } from '../core/dom.js';
import { setStatus } from '../core/toast.js';
import { PL_API, plById, upsertPlaylist } from './model.js';
import { loadPlaylists, plApi } from './api.js';
import { syncCtx } from './context.js';
import { renderPlaylists } from './view.js';
import { S } from '../core/state.js';

// ── 播放清單操作 ──────────────────────────────────────
export async function createPlaylist(name, items) {
  const j = await plApi('POST', PL_API, { name, items });
  upsertPlaylist(j.playlist);
  return j.playlist;
}

export async function addToPlaylist(pid, items) {
  const before = new Set((plById(pid) || { items: [] }).items.map((x) => x.id));
  const j = await plApi('POST', `${PL_API}/${pid}/items`, { items });
  upsertPlaylist(j.playlist);
  syncCtx(pid, { added: j.playlist.items.filter((x) => !before.has(x.id)) });
  renderPlaylists();
  return j;
}

export async function removeFromPlaylist(pid, iid) {
  try {
    const j = await plApi('DELETE', `${PL_API}/${pid}/items/${iid}`);
    upsertPlaylist(j.playlist);
  } catch (err) { return setStatus(err.message); }
  syncCtx(pid, { removedId: iid });
  renderPlaylists();
}

export async function reorderPlaylist(pid, ids) {
  const p = plById(pid); if (!p) return;
  const map = new Map(p.items.map((it) => [it.id, it]));
  const old = p.items;
  p.items = ids.map((i) => map.get(i)).filter(Boolean);
  syncCtx(pid, { reordered: true });
  renderPlaylists();
  try {
    const j = await plApi('PUT', `${PL_API}/${pid}/order`, { order: ids });
    upsertPlaylist(j.playlist);
    syncCtx(pid); renderPlaylists();
  } catch (err) {
    p.items = old; syncCtx(pid);
    setStatus(err.message); loadPlaylists();
  }
}

export function openPlaylist(id) {
  S.plOpen = id; S.plQuery = ''; $('search').value = '';
  renderPlaylists();
  $('main').scrollTop = 0;
}
