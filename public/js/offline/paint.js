// offline/paint.js — 下載狀態的畫面更新
import { $ } from '../core/dom.js';
import { S, dlState, offlineKeys } from '../core/state.js';
import { fmtSize } from '../core/util.js';
import { itemKey, plById, plDownloadable } from '../playlists/model.js';
import { offlineSizes } from './idb.js';
import { dlBatch, dlBusy } from './downloads.js';
import { applyMoreButton } from '../ui/menus.js';

// ── 下載狀態的畫面更新(合併成每個 frame 最多一次)──────
let dlRaf = 0;

export function refreshDl() {
  if (dlRaf) return;
  dlRaf = requestAnimationFrame(() => { dlRaf = 0; paintDl(); });
}

export function applyDlButton(b) {
  const k = b.dataset.dlkey, st = dlState.get(k);
  const off = offlineKeys.has(k);
  b.classList.toggle('done', off);
  b.style.fontSize = '';
  if (off) { b.innerHTML = '<svg><use href="#i-check"/></svg>'; b.title = '已下載(點擊移除)'; }
  else if (st) {
    b.textContent = st.active && st.pct > 0 ? st.pct + '%' : '…';
    b.style.fontSize = '11px';
    b.title = st.active ? '下載中' : '等待下載';
  } else { b.innerHTML = '<svg><use href="#i-download"/></svg>'; b.title = '下載離線'; }
}

export function updateOfflineInfo() {
  const n = offlineKeys.size;
  let bytes = 0; offlineSizes.forEach((v) => { bytes += v; });
  $('offlineInfo').textContent = n ? `離線檔案:${n} 首,約 ${fmtSize(bytes)}` : '尚未下載任何離線歌曲。進入播放清單可一鍵下載。';
  $('offlineClear').hidden = n === 0;
}

export function updatePlDetailButtons() {
  const p = S.plOpen && plById(S.plOpen);
  if (!p) return;
  const nOff = p.items.filter((it) => offlineKeys.has(itemKey(it))).length;
  $('plMeta').textContent = `${p.items.length} 首歌曲` + (nOff ? ` · 已下載 ${nOff} 首` : '');
  const b = $('plDownloadAll');
  const dls = p.items.filter(plDownloadable);
  const busy = dlBusy(), allOff = dls.length > 0 && dls.every((it) => offlineKeys.has(itemKey(it)));
  b.classList.toggle('done', !busy && allOff);
  b.style.fontSize = '';
  if (busy) { b.textContent = `${dlBatch.done + dlBatch.failed}/${dlBatch.total}`; b.style.fontSize = '12px'; b.title = '取消下載'; }
  else { b.innerHTML = `<svg><use href="#i-${allOff ? 'check' : 'download'}"/></svg>`; b.title = allOff ? '已下載(點擊移除)' : '下載離線'; }
}

function paintDl() {
  document.querySelectorAll('.row[data-key]').forEach((r) => r.classList.toggle('offline', offlineKeys.has(r.dataset.key)));
  document.querySelectorAll('[data-dlkey]').forEach(applyDlButton);
  document.querySelectorAll('[data-dlmenu]').forEach(applyMoreButton);
  updatePlDetailButtons();
  updateOfflineInfo();
}
