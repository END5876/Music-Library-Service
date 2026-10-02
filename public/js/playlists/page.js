// playlists/page.js — 播放清單頁面按鈕與搜尋
import { $ } from '../core/dom.js';
import { S, offlineKeys } from '../core/state.js';
import { setStatus } from '../core/toast.js';
import { PL_API, itemKey, plById, plDownloadable, upsertPlaylist } from './model.js';
import { offlineClearAll, offlineSizes } from '../offline/idb.js';
import { cancelDownloads, dlBusy, enqueueDownloads, removeOffline } from '../offline/downloads.js';
import { refreshDl } from '../offline/paint.js';
import { plApi } from './api.js';
import { playPlaylist } from './context.js';
import { askText } from './dialog.js';
import { createPlaylist, openPlaylist } from './actions.js';
import { renderPlaylists } from './view.js';

// ── 播放清單頁面的按鈕 ────────────────────────────────
$('plNew').addEventListener('click', async () => {
  const name = await askText('新增播放清單');
  if (!name) return;
  try { const p = await createPlaylist(name); openPlaylist(p.id); } catch (err) { setStatus(err.message); }
});

$('plBack').addEventListener('click', () => {
  S.plOpen = null; S.plQuery = ''; $('search').value = '';
  renderPlaylists(); $('main').scrollTop = 0;
});

$('plPlay').addEventListener('click', () => { if (S.plOpen) playPlaylist(S.plOpen); });

$('plShuffle').addEventListener('click', () => { if (S.plOpen) playPlaylist(S.plOpen, null, { shuffleStart: true }); });

$('plRename').addEventListener('click', async () => {
  const p = S.plOpen && plById(S.plOpen); if (!p) return;
  const name = await askText('重新命名', p.name);
  if (!name || name === p.name) return;
  try { upsertPlaylist((await plApi('PATCH', `${PL_API}/${p.id}`, { name })).playlist); renderPlaylists(); }
  catch (err) { setStatus(err.message); }
});

$('plDelete').addEventListener('click', async () => {
  const p = S.plOpen && plById(S.plOpen); if (!p) return;
  if (!confirm(`刪除播放清單「${p.name}」?\n(歌曲本身不會被刪除)`)) return;
  try { await plApi('DELETE', `${PL_API}/${p.id}`); } catch (err) { return setStatus(err.message); }
  S.playlists = S.playlists.filter((x) => x.id !== p.id);
  if (S.playlistCtx && S.playlistCtx.id === p.id) S.playlistCtx = null;
  S.plOpen = null; renderPlaylists();
  setStatus('已刪除播放清單');
});

$('plDownloadAll').addEventListener('click', () => {
  const p = S.plOpen && plById(S.plOpen); if (!p) return;
  if (dlBusy()) { cancelDownloads(); return; }
  const dls = p.items.filter(plDownloadable);
  if (!dls.length) return setStatus('沒有可下載的歌曲');
  // 全部都已下載:再按一次就是移除
  if (dls.every((it) => offlineKeys.has(itemKey(it)))) {
    if (!confirm('移除這個播放清單的所有離線檔案?')) return;
    removeOffline(p.items).then(() => setStatus('已移除離線檔案'));
    return;
  }
  enqueueDownloads(dls);
});

$('offlineClear').addEventListener('click', async () => {
  if (!confirm('清除這個裝置上全部的離線檔案?')) return;
  try { await offlineClearAll(); offlineKeys.clear(); offlineSizes.clear(); setStatus('已清除全部離線檔案'); }
  catch (err) { setStatus('清除失敗:' + err.message); }
  refreshDl();
});

// 頁面上方 ⋯ 下拉選單(重新命名 / 移除離線 / 刪除)
$('plMoreBtn').addEventListener('click', (e) => { e.stopPropagation(); $('plMenu').classList.toggle('show'); });

document.addEventListener('click', () => $('plMenu').classList.remove('show'));

$('plSearch').addEventListener('input', () => { S.plQuery = $('plSearch').value; renderPlaylists(); });
