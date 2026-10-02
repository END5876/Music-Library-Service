// offline/idb.js — 離線儲存（IndexedDB）
import { offlineKeys } from '../core/state.js';

// ── 離線儲存(IndexedDB)──────────────────────────────
const IDB_NAME = 'ml_offline', IDB_STORE = 'tracks';

export const offlineSizes = new Map(); // key -> bytes

let idbPromise = null;

function idb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('此瀏覽器不支援離線儲存'));
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  idbPromise.catch(() => { idbPromise = null; });
  return idbPromise;
}

function idbTx(mode, fn) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const rq = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => resolve(rq && rq.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('寫入中止'));
  }));
}

export const offlineGet = (key) => idbTx('readonly', (s) => s.get(key)).then((r) => (r ? r.blob : null));

export const offlinePut = (rec) => idbTx('readwrite', (s) => s.put(rec));

export const offlineDel = (key) => idbTx('readwrite', (s) => s.delete(key));

export const offlineClearAll = () => idbTx('readwrite', (s) => s.clear());

// 只掃描 key / size,不把音檔內容讀進記憶體
function offlineScan() {
  return idb().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).openCursor();
    rq.onsuccess = () => {
      const c = rq.result;
      if (c) { out.push({ key: c.value.key, size: c.value.size || 0 }); c.continue(); } else resolve(out);
    };
    rq.onerror = () => reject(rq.error);
  }));
}

export function offlineInit() {
  return offlineScan()
    .then((list) => { for (const r of list) { offlineKeys.add(r.key); offlineSizes.set(r.key, r.size); } })
    .catch(() => {});
}
