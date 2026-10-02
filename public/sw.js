'use strict';
// sw.js — 讓播放器頁面與清單在離線時仍能開啟（離線音檔本身存在 IndexedDB，由 player.js 處理）
// 由 /player-sw.js 提供（scope 為 /），改版時把 VERSION 加一即可讓舊快取失效。
const VERSION = 'v1';
const SHELL = `ml-shell-${VERSION}`;
const DATA = `ml-data-${VERSION}`;
const SHELL_URLS = ['/player', '/player-assets/player.css', '/player-assets/player.js'];
const API_PATHS = ['/web/api/list', '/web/api/playlists', '/web/api/capabilities'];
const TIMEOUT_MS = 6000;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_URLS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 網路優先；網路失敗或逾時才用快取。只快取成功（2xx）的回應，401 之類不會被存起來
function networkFirst(req, cacheName) {
  const net = fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS));
  return Promise.race([net, timeout]).catch(async () => {
    const hit = await caches.match(req, { cacheName });
    return hit || net.catch(() => Response.error());
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  if (p === '/player' || p.startsWith('/player-assets/')) {
    e.respondWith(networkFirst(req, SHELL));
  } else if (API_PATHS.includes(p)) {
    e.respondWith(networkFirst(req, DATA));
  }
  // 其餘（串流、搜尋、登入…）一律不攔截
});
