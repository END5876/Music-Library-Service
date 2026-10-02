'use strict';
// utils/urlUtils.js — 網址／時間格式工具（YouTube / Bilibili）
// cleanUrl 與 Bot 的 unifiedQueue/search/urlUtils.js 相同。

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/.test(url);
}

function formatDuration(seconds) {
  if (!seconds) return '未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

// 與 Bot 的 unifiedQueue/search/urlUtils.js 的 cleanUrl 相同
function cleanUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);

    if (urlObj.hostname.includes('bilibili.com')) {
      const p = urlObj.searchParams.get('p');
      urlObj.search = '';
      if (p) urlObj.searchParams.set('p', p);
      return urlObj.toString();
    }

    if (urlObj.hostname.includes('youtube.com') || urlObj.hostname === 'youtu.be') {
      urlObj.searchParams.delete('list');
      urlObj.searchParams.delete('index');
      urlObj.searchParams.delete('start_radio');
      urlObj.searchParams.delete('rv');
      urlObj.searchParams.delete('feature');
      return urlObj.toString();
    }

    return rawUrl;
  } catch (error) {
    return rawUrl;
  }
}

// 網頁版新增：只允許 YouTube / Bilibili 網域。
// Bot 的入口是 Discord 使用者，這裡是任何拿到網頁密碼的人，
// 不能讓 yt-dlp 被拿去抓任意網址（它支援上千個網站，也能讀 file:// 等）。
const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com'];
function isAllowedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

module.exports = { isYouTubeUrl, formatDuration, cleanUrl, isAllowedUrl, ALLOWED_HOSTS };
