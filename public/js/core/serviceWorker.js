// core/serviceWorker.js — Service Worker 註冊與資料快取清理
import { dbg } from './debug.js';

export function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/player-sw.js', { scope: '/' }).catch((err) => dbg('SW 註冊失敗', err && err.message));
}

export function clearDataCaches() {
  if (!window.caches) return;
  caches.keys().then((ks) => ks.filter((k) => k.startsWith('ml-data-')).forEach((k) => caches.delete(k))).catch(() => {});
}
