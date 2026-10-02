// core/util.js — 小工具：編碼、格式化、圖示、洗牌

export const enc = encodeURIComponent;

export const streamUrl = (f) => '/web/stream/' + f.split('/').map(enc).join('/');

export const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

export const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

export const setIcon = (btn, name) => btn.querySelector('use').setAttribute('href', '#i-' + name);

// ── 隨機佇列 ──
export function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
