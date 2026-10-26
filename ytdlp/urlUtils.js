// ytdlp/urlUtils.js
// 線上串流用的網址處理：正規化網址（cleanUrl）與網域白名單（isAllowedUrl）。
// 被 onlineStream.js（HTTP 入口）、videoLookup.js（搜尋結果過濾）、播放清單與 Bot 點歌共用。
//
// 🔒 [快取投毒] cleanUrl 把 YouTube／Bilibili 網址重建成唯一的標準形式，交給 yt-dlp 與用來命名快取的
// 都是同一個網址。以前快取檔名的影片 ID 是用正規表示式從原始網址抓第一個 v=，yt-dlp 卻優先採用
// /shorts/<id> 等路徑裡的 ID：https://www.youtube.com/shorts/<B>?v=<A> 會下載 B、存成 A 的快取，
// 之後所有人播放 A 都聽到 B。現在網址裡出現互相衝突的影片 ID 就直接拒絕（回傳空字串）。
// ⚠️ Bot 端（Mousebot handlers/musicplayer/unifiedQueue/search/urlUtils.js 與 musicCache.js）也做了相同的修改。

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_PATH_RE = /^\/(?:shorts|embed|live|v|e)\/([^/]+)/;
const BILI_PATH_RE = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:\/|$)/i;
const T_RE = /^(?:\d+|(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/;

const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com'];

function hostIs(hostname, base) {
  const h = String(hostname || '').toLowerCase();
  return h === base || h.endsWith(`.${base}`);
}

function parseUrl(rawUrl) {
  try { return new URL(String(rawUrl || '').trim()); } catch { return null; }
}

/**
 * 網址裡的 YouTube 影片 ID。
 * @returns {{ id: string|null, conflict: boolean }} 沒有影片 ID 時 id 為 null；
 *   路徑與 v= 參數（或多個 v=）指向不同影片時 conflict 為 true
 */
function youtubeVideoId(urlObj) {
  const ids = new Set();
  const add = (v) => { if (v !== null && v !== undefined) ids.add(String(v)); };
  if (hostIs(urlObj.hostname, 'youtu.be')) add(urlObj.pathname.split('/')[1] || null);
  const m = urlObj.pathname.match(YT_PATH_RE);
  if (m) add(m[1]);
  for (const v of urlObj.searchParams.getAll('v')) add(v);
  if (ids.size > 1) return { id: null, conflict: true };
  const [id] = ids;
  if (id === undefined) return { id: null, conflict: false };
  // 只出現一個、但不是合法 ID：當成沒有影片 ID（網址照一般方式清理；yt-dlp 自己會失敗，也算不出快取 ID）
  return YT_ID_RE.test(id) ? { id, conflict: false } : { id: null, conflict: false };
}

/** 網址裡的 Bilibili 影片 ID（BVxxxxxxxxxx 或 avNNN）；不是 /video/<id> 形式時回傳 null。 */
function bilibiliVideoId(urlObj) {
  const m = urlObj.pathname.match(BILI_PATH_RE);
  if (!m) return null;
  return /^av/i.test(m[1]) ? `av${m[1].slice(2)}` : `BV${m[1].slice(2)}`;
}

// 與 Bot 的 unifiedQueue/search/urlUtils.js 的 cleanUrl 相同
//   YouTube：有影片 ID → https://www.youtube.com/watch?v=<id>（保留開始時間 t）；ID 互相衝突 → ''（呼叫端的 isAllowedUrl 會拒絕）
//   Bilibili：/video/<id> → https://www.bilibili.com/video/<id>（只保留分 P 的 p 參數）
//   其他允許的網址一律改成 https（cookie 不會以明文 HTTP 送出），不認得的網域原樣回傳
function cleanUrl(rawUrl) {
  const urlObj = parseUrl(rawUrl);
  if (!urlObj || (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:')) return String(rawUrl || '');

  if (hostIs(urlObj.hostname, 'youtube.com') || hostIs(urlObj.hostname, 'youtu.be')) {
    const { id, conflict } = youtubeVideoId(urlObj);
    if (conflict) return '';
    if (id) {
      // 開始時間（t=90、t=1m30s）照樣保留，跟以前一樣
      const t = urlObj.searchParams.get('t');
      return `https://www.youtube.com/watch?v=${id}${t && T_RE.test(t) ? `&t=${t}` : ''}`;
    }
    urlObj.protocol = 'https:';
    for (const k of ['list', 'index', 'start_radio', 'rv', 'feature']) urlObj.searchParams.delete(k);
    return urlObj.toString();
  }

  if (hostIs(urlObj.hostname, 'bilibili.com')) {
    const p = urlObj.searchParams.get('p');
    const page = p && /^\d{1,4}$/.test(p) ? p : null;
    const id = bilibiliVideoId(urlObj);
    if (id) return `https://www.bilibili.com/video/${id}${page ? `?p=${page}` : ''}`;
    urlObj.protocol = 'https:';
    urlObj.search = '';
    if (page) urlObj.searchParams.set('p', page);
    return urlObj.toString();
  }

  return String(rawUrl || '');
}

// 網頁版新增：只允許 YouTube / Bilibili 網域。
// Bot 的入口是 Discord 使用者，這裡是任何拿到網頁密碼的人，
// 不能讓 yt-dlp 被拿去抓任意網址（它支援上千個網站，也能讀 file:// 等）。
// 🔒 只接受 https：Bilibili 帳號 cookie 會跟著請求送出，http 網址等於把它以明文送出去。
// 使用者貼的 http 網址會先被 cleanUrl 改成 https，所以呼叫端一律先 cleanUrl 再檢查。
function isAllowedUrl(rawUrl) {
  const u = parseUrl(rawUrl);
  if (!u || u.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.some(h => hostIs(u.hostname, h));
}

module.exports = { cleanUrl, isAllowedUrl, youtubeVideoId, bilibiliVideoId, parseUrl };
