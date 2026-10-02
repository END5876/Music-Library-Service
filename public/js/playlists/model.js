// playlists/model.js — 播放清單的資料輔助函式
import { S } from '../core/state.js';

// ════════════════════════════════════════════════════════
//  播放清單 + 離線下載
//  (狀態變數 playlists / plOpen / playlistCtx / offlineKeys / dlState 宣告在檔案上方)
// ════════════════════════════════════════════════════════
export const PL_API = '/web/api/playlists';

export const itemKey = (it) => it.kind === 'lib' ? 'lib:' + it.filename : 'on:' + (it.srcUrl || it.url);

export const onlineItem = (r) => ({
  kind: 'online', url: r.srcUrl || r.url, title: r.title, author: r.author, platform: r.platform, duration: r.duration,
});

export const itemTitle = (it) => it.kind === 'lib'
  ? ((S.byFile.get(it.filename) || {}).name || it.title || it.filename.split('/').pop())
  : (it.title || '未知標題');

export const plById = (id) => S.playlists.find((p) => p.id === id);

export function upsertPlaylist(p) {
  const i = S.playlists.findIndex((x) => x.id === p.id);
  if (i >= 0) S.playlists[i] = p; else S.playlists.push(p);
}

// ── 播放清單總覽:卡片(電腦版為封面網格,手機版為列表)+ 下載按鈕判斷 ──────
export const plDownloadable = (it) => it.kind === 'online' || S.byFile.has(it.filename);
