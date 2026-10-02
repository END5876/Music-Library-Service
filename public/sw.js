'use strict';
// sw.js — 讓播放器頁面與清單在離線時仍能開啟（離線音檔本身存在 IndexedDB，由 player.js 處理）
// 由 /player-sw.js 提供（scope 為 /），改版時把 VERSION 加一即可讓舊快取失效。
const VERSION = 'v2'; // 檔案結構變動（CSS／JS 拆分）：舊快取全部失效
const SHELL = `ml-shell-${VERSION}`;
const DATA = `ml-data-${VERSION}`;
// 預快取的頁面外殼。新增／刪除 public/css、public/js 的檔案後，執行 npm run check:sw 確認這份清單沒有漏
const SHELL_URLS = [
  '/player',
  '/player-assets/css/base.css',
  '/player-assets/css/layout.css',
  '/player-assets/css/rows.css',
  '/player-assets/css/player-bar.css',
  '/player-assets/css/overlays.css',
  '/player-assets/css/fullscreen.css',
  '/player-assets/css/dialogs.css',
  '/player-assets/css/responsive.css',
  '/player-assets/css/playlists.css',
  '/player-assets/css/menus.css',
  '/player-assets/css/playlist-detail.css',
  '/player-assets/css/playlist-cards.css',
  '/player-assets/js/main.js',
  '/player-assets/js/audio/controls.js',
  '/player-assets/js/audio/events.js',
  '/player-assets/js/audio/helpers.js',
  '/player-assets/js/audio/mediaSession.js',
  '/player-assets/js/audio/prefetch.js',
  '/player-assets/js/auth/auth.js',
  '/player-assets/js/core/constants.js',
  '/player-assets/js/core/debug.js',
  '/player-assets/js/core/dom.js',
  '/player-assets/js/core/prefs.js',
  '/player-assets/js/core/serviceWorker.js',
  '/player-assets/js/core/state.js',
  '/player-assets/js/core/toast.js',
  '/player-assets/js/core/util.js',
  '/player-assets/js/library/library.js',
  '/player-assets/js/offline/downloads.js',
  '/player-assets/js/offline/idb.js',
  '/player-assets/js/offline/paint.js',
  '/player-assets/js/offline/source.js',
  '/player-assets/js/online/online.js',
  '/player-assets/js/playback/controller.js',
  '/player-assets/js/playlists/actions.js',
  '/player-assets/js/playlists/api.js',
  '/player-assets/js/playlists/context.js',
  '/player-assets/js/playlists/dialog.js',
  '/player-assets/js/playlists/drag.js',
  '/player-assets/js/playlists/model.js',
  '/player-assets/js/playlists/page.js',
  '/player-assets/js/playlists/picker.js',
  '/player-assets/js/playlists/view.js',
  '/player-assets/js/queue/drag.js',
  '/player-assets/js/queue/model.js',
  '/player-assets/js/queue/shuffle.js',
  '/player-assets/js/queue/view.js',
  '/player-assets/js/ui/fullscreen.js',
  '/player-assets/js/ui/keyboard.js',
  '/player-assets/js/ui/menus.js',
  '/player-assets/js/ui/nav.js',
  '/player-assets/js/ui/rows.js',
];
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
