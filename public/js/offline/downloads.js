// offline/downloads.js — 離線下載佇列
import { dlState, offlineKeys } from '../core/state.js';
import { enc, streamUrl } from '../core/util.js';
import { setStatus } from '../core/toast.js';
import { showLogin } from '../auth/auth.js';
import { itemKey } from '../playlists/model.js';
import { offlineDel, offlinePut, offlineSizes } from './idb.js';
import { refreshDl } from './paint.js';

// ── 下載(最多同時 2 個,可整批取消)──────────────────
const DL_CONCURRENCY = 2;

const dlQueue = [];

let dlActive = 0, dlAbort = null, dlFailMsg = '';

export let dlBatch = { total: 0, done: 0, failed: 0 };

export const dlBusy = () => dlActive > 0 || dlQueue.length > 0;

export function enqueueDownloads(items) {
  const fresh = items.filter((it) => { const k = itemKey(it); return !offlineKeys.has(k) && !dlState.has(k); });
  if (!fresh.length) { setStatus('這些歌曲已經下載過(或正在下載)'); return; }
  if (!dlAbort) dlAbort = new AbortController();
  for (const it of fresh) { dlState.set(itemKey(it), { pct: 0, active: false }); dlQueue.push(it); }
  dlBatch.total += fresh.length;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  setStatus(`開始下載 ${fresh.length} 首…`);
  refreshDl();
  pumpDownloads();
}

function pumpDownloads() {
  while (dlAbort && dlActive < DL_CONCURRENCY && dlQueue.length) {
    const it = dlQueue.shift();
    dlActive++;
    downloadOne(it, dlAbort.signal)
      .then(() => { dlBatch.done++; })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        dlBatch.failed++;
        const name = err && (err.name || (err.target && err.target.error && err.target.error.name));
        dlFailMsg = name === 'QuotaExceededError' ? '儲存空間不足' : (err && err.message) || '下載失敗';
        if (name === 'QuotaExceededError') cancelDownloads(dlFailMsg);
      })
      .finally(() => {
        dlActive--;
        if (!dlBusy()) finishBatch(); else pumpDownloads();
        refreshDl();
      });
  }
}

async function downloadOne(it, signal) {
  const key = itemKey(it);
  const st = dlState.get(key);
  if (st) st.active = true;
  try {
    const url = it.kind === 'lib' ? streamUrl(it.filename) : '/web/play?url=' + enc(it.srcUrl || it.url);
    const r = await fetch(url, { signal });
    if (r.status === 401) { showLogin('登入已過期,請重新登入'); throw new Error('登入已過期'); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
    const total = Number(r.headers.get('Content-Length')) || 0;
    const reader = r.body.getReader();
    const chunks = []; let got = 0, lastUi = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (st && total) st.pct = Math.min(99, Math.floor(got / total * 100));
      const t = Date.now();
      if (t - lastUi > 300) { lastUi = t; refreshDl(); }
    }
    if (!got) throw new Error('下載到空檔案');
    const blob = new Blob(chunks, { type: r.headers.get('Content-Type') || 'audio/mpeg' });
    await offlinePut({ key, blob, size: blob.size, title: it.title || '', at: Date.now() });
    offlineKeys.add(key); offlineSizes.set(key, blob.size);
  } finally {
    dlState.delete(key);
  }
}

function finishBatch() {
  if (!dlBatch.total) return; // 已被取消
  const { done, failed } = dlBatch;
  setStatus(`⬇ 下載完成:${done} 首` + (failed ? `,失敗 ${failed} 首(${dlFailMsg})` : ''));
  dlBatch = { total: 0, done: 0, failed: 0 };
  dlAbort = null; dlFailMsg = '';
}

export function cancelDownloads(msg) {
  if (dlAbort) dlAbort.abort();
  for (const it of dlQueue) dlState.delete(itemKey(it));
  dlQueue.length = 0;
  dlBatch = { total: 0, done: 0, failed: 0 };
  dlAbort = null;
  setStatus(msg || '已取消下載');
  refreshDl();
}

export async function removeOffline(items) {
  for (const it of items) {
    const k = itemKey(it);
    if (!offlineKeys.has(k)) continue;
    try { await offlineDel(k); offlineKeys.delete(k); offlineSizes.delete(k); } catch {}
  }
  refreshDl();
}

export function toggleOffline(it) {
  const k = itemKey(it);
  if (offlineKeys.has(k)) { removeOffline([it]); setStatus('已移除離線檔案'); }
  else if (dlState.has(k)) setStatus('下載中,請稍候');
  else enqueueDownloads([it]);
}
