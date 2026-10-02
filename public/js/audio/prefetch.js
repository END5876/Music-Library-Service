// audio/prefetch.js — 預載下一首（預設關閉）
import { PREFETCH } from '../core/constants.js';
import { enc, streamUrl } from '../core/util.js';
import { pickNext } from '../playback/controller.js';
import { S } from '../core/state.js';

// ── 預載下一首(PREFETCH 開啟時才啟用;不下載整首)──
let prefetched = '';

export function prefetchNext() {
  if (!PREFETCH) return;
  if (!S.currentFile && !S.onlineCurrent) return;
  const e = S.queue[0];
  if (e && e.kind === 'online') {
    const u = e.item.srcUrl || e.item.url;
    if (u !== prefetched) { prefetched = u; fetch('/web/api/info?url=' + enc(u)).catch(() => {}); }
    return;
  }
  const next = e ? e.filename : (S.shuffle || S.onlineCurrent ? null : pickNext());
  if (!next || next === prefetched || next === S.currentFile) return;
  prefetched = next;
  // 只抓開頭 256KB,是否命中 audio 的快取不保證
  fetch(streamUrl(next), { headers: { Range: 'bytes=0-262143' } }).then(r => r.arrayBuffer()).catch(() => {});
}
