'use strict';
// offlineStore.js
// 離線曲目的 IndexedDB 存取（只負責讀寫，不含任何畫面或播放邏輯）。
// 從 player.js 拆出；程式碼不變，以 window.MLOfflineStore 提供給 player.js 使用。
// 載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  const IDB_NAME = 'ml_offline', IDB_STORE = 'tracks';
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
  const offlineGet = (key) => idbTx('readonly', (s) => s.get(key)).then((r) => (r ? r.blob : null));
  const offlinePut = (rec) => idbTx('readwrite', (s) => s.put(rec));
  const offlineDel = (key) => idbTx('readwrite', (s) => s.delete(key));
  const offlineClearAll = () => idbTx('readwrite', (s) => s.clear());
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

  window.MLOfflineStore = { offlineGet, offlinePut, offlineDel, offlineClearAll, offlineScan };
})();
