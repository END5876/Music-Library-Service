'use strict';
// webplayer/playlistStore.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的播放清單儲存（單一 JSON 檔，同步原子寫入）。每個 Discord 帳號各自一份，互相看不到、改不到。
//
// 檔案位置：PLAYLISTS_FILE，預設 <repo root>/data/playlists.json（Docker 內為 /app/data，掛 Volume）
//   → 在音樂庫資料夾外面，不會出現在曲目清單，也不會被快取清理刪掉。
//
// 檔案格式：{ version: 2, owners: { "<Discord 使用者 ID>": [ 播放清單, … ] } }
//   舊版（所有人共用）的 { playlists: [...] } 不搬移：改名備份成 playlists.json.shared-<時間>.bak 後從空的開始。
//
// 項目格式（id 由伺服器產生，同一個播放清單內不重複歌曲）：
//   { id, kind:'lib',    filename, title }
//   { id, kind:'online', url, title, author, platform, duration }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../musicStore');

const FILE = process.env.PLAYLISTS_FILE || path.join(__dirname, '..', 'data', 'playlists.json');
const MAX_PLAYLISTS = 100;  // 每個帳號
const MAX_ITEMS = 2000;
const MAX_NAME = 50;
const MAX_ADD_PER_REQUEST = 2000;
// 任何 Discord 帳號都能登入：限制總量，避免灌帳號把檔案（和每次存檔整份重寫的時間）撐大
const MAX_OWNERS = 1000;             // 有播放清單的帳號數
const MAX_OWNER_ITEMS = 10000;       // 每個帳號所有清單合計的歌曲數
const GLOBAL_MAX_ITEMS = 200000;     // 全部帳號合計（＝以前所有人共用時的上限 100 × 2000）
const OWNER_ID = /^\d{17,20}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let data = null;

// 🔒 讀不到檔案（ENOENT 以外的錯誤）或備份失敗時一律丟 503、不快取空資料：
// 不然下一次任何人存檔，就會用空的清單把所有帳號的播放清單蓋掉。下一個請求會重新嘗試讀取。
function load() {
  if (data) return data;
  const fresh = { version: 2, owners: Object.create(null) };
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return (data = fresh);
    console.error('❌ [Playlists] 讀取失敗:', err.message);
    throw new HttpError(503, '播放清單暫時無法讀取，請稍後再試');
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (err) {
    // 檔案壞掉：改名備份，避免下一次存檔把它覆蓋掉
    const bak = backup('corrupt');
    console.error(`❌ [Playlists] JSON 解析失敗，已備份為 ${bak}:`, err.message);
    return (data = fresh);
  }
  if (j && j.version === 2 && j.owners && typeof j.owners === 'object') {
    for (const [owner, list] of Object.entries(j.owners)) {
      if (OWNER_ID.test(owner) && Array.isArray(list)) fresh.owners[owner] = list;
    }
  } else if (j && Array.isArray(j.playlists)) {
    // 舊版：所有人共用一份，沒有擁有者 → 不搬移（備份後清空）
    const bak = backup('shared');
    console.warn(`⚠️ [Playlists] 舊版共用播放清單（${j.playlists.length} 個）已改成每個帳號各自一份，舊檔備份為 ${bak}，不再使用`);
  } else {
    // 不認得的格式（例如之後的新版本，部署回滾到這一版時）：一樣先備份，不能被下一次存檔直接蓋掉
    const bak = backup('unknown');
    console.error(`❌ [Playlists] 不認得的播放清單格式，已備份為 ${bak}，從空的開始`);
  }
  return (data = fresh);
}

// 把現有檔案改名備份；改名失敗就丟 503（不能讓接下來的存檔蓋掉沒備份到的原檔）
function backup(tag) {
  const bak = `${FILE}.${tag}-${Date.now()}.bak`;
  try {
    fs.renameSync(FILE, bak);
  } catch (err) {
    console.error(`❌ [Playlists] 備份 ${path.basename(FILE)} 失敗，暫停播放清單功能:`, err.message);
    throw new HttpError(503, '播放清單暫時無法使用，請聯絡管理員');
  }
  return path.basename(bak);
}

const itemCount = (lists) => lists.reduce((n, p) => n + p.items.length, 0);

// 這個帳號的播放清單陣列；create＝還沒有時建立（受 MAX_OWNERS 限制）
function ownerLists(owner, { create = false } = {}) {
  if (typeof owner !== 'string' || !OWNER_ID.test(owner)) throw new HttpError(403, '需要以 Discord 帳號登入才能使用播放清單');
  const d = load();
  if (d.owners[owner]) return d.owners[owner];
  if (!create) return [];
  if (Object.keys(d.owners).length >= MAX_OWNERS) throw new HttpError(503, '播放清單使用人數已達上限，請聯絡管理員');
  d.owners[owner] = [];
  return d.owners[owner];
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function cleanName(raw) {
  const s = str(raw, MAX_NAME);
  if (!s) throw new HttpError(400, '名稱不可為空');
  return s;
}

// 只在這個帳號自己的清單裡找：別人的播放清單 id 一律當作不存在
function find(owner, id) {
  const p = ownerLists(owner).find((x) => x.id === id);
  if (!p) throw new HttpError(404, '找不到播放清單');
  return p;
}

const itemKey = (it) => (it.kind === 'lib' ? `lib:${it.filename}` : `on:${it.url}`);

// 輸入全部視為不可信：lib 必須真的存在於音樂庫；online 必須是允許的網域
async function normalizeItem(raw, { isAllowedUrl, cleanUrl }) {
  if (!raw || typeof raw !== 'object') return null;

  if (raw.kind === 'lib') {
    if (typeof raw.filename !== 'string') return null;
    let info;
    try { info = await store.exists(raw.filename); } catch { return null; }
    if (!info.exists) return null;
    const base = path.posix.basename(info.filename).replace(/\.[^.]+$/, '');
    return { kind: 'lib', filename: info.filename, title: str(raw.title, 200) || base };
  }

  if (raw.kind === 'online') {
    const url = cleanUrl(str(raw.url, 500));
    if (!isAllowedUrl(url)) return null;
    return {
      kind: 'online',
      url,
      title: str(raw.title, 200) || '未知標題',
      author: str(raw.author, 100),
      platform: raw.platform === 'Bilibili' ? 'Bilibili' : raw.platform === 'YouTube' ? 'YouTube' : '',
      duration: str(raw.duration, 20),
    };
  }
  return null;
}

// 分批並行驗證（lib 項目每首都要 stat 一次，2000 首依序做會很慢），結果維持原本的順序
async function normalizeMany(rawItems, deps) {
  if (!Array.isArray(rawItems)) return [];
  const list = rawItems.slice(0, MAX_ADD_PER_REQUEST);
  const out = [];
  for (let i = 0; i < list.length; i += 64) {
    const batch = await Promise.all(list.slice(i, i + 64).map((raw) => normalizeItem(raw, deps)));
    for (const it of batch) if (it) out.push(it);
  }
  return out;
}

// 同步區段：把已驗證的項目併入（去重、上限），避免 await 期間清單被改動。
// 先算出要新增的歌、確認三種上限都放得下才寫入：超過上限時整批不加（不會只加一半）
function mergeItems(owner, p, items) {
  const have = new Set(p.items.map(itemKey));
  const fresh = [];
  for (const it of items) {
    const k = itemKey(it);
    if (have.has(k)) continue;
    have.add(k);
    fresh.push(it);
  }
  if (!fresh.length) return 0;
  if (p.items.length + fresh.length > MAX_ITEMS) throw new HttpError(400, `播放清單最多 ${MAX_ITEMS} 首`);
  if (itemCount(ownerLists(owner)) + fresh.length > MAX_OWNER_ITEMS) {
    throw new HttpError(400, `每個帳號的播放清單合計最多 ${MAX_OWNER_ITEMS} 首`);
  }
  if (itemCount(Object.values(load().owners).flat()) + fresh.length > GLOBAL_MAX_ITEMS) {
    throw new HttpError(503, '播放清單的儲存空間已滿，請聯絡管理員');
  }
  for (const it of fresh) p.items.push({ id: newId(), ...it });
  return fresh.length;
}

// ════════════════════════════════════════════════════════
// 以下 owner 一律是 Discord 使用者 ID（由登入 Cookie 決定，見 playlistRoutes.js）
function list(owner) { return ownerLists(owner); }

async function create(owner, rawName, rawItems, deps) {
  ownerLists(owner); // 先驗證 owner，不合法就不用驗證檔案了
  const name = cleanName(rawName);
  const items = await normalizeMany(rawItems, deps);
  if (ownerLists(owner).length >= MAX_PLAYLISTS) throw new HttpError(400, `最多 ${MAX_PLAYLISTS} 個播放清單`);
  const t = now();
  const p = { id: newId(), name, items: [], createdAt: t, updatedAt: t };
  mergeItems(owner, p, items); // 超過上限會在這裡丟錯，還沒佔用帳號名額
  ownerLists(owner, { create: true }).push(p);
  save();
  return p;
}

function rename(owner, id, rawName) {
  const p = find(owner, id);
  p.name = cleanName(rawName);
  p.updatedAt = now();
  save();
  return p;
}

function remove(owner, id) {
  const lists = ownerLists(owner);
  const i = lists.findIndex((x) => x.id === id);
  if (i < 0) throw new HttpError(404, '找不到播放清單');
  lists.splice(i, 1);
  if (!lists.length) delete load().owners[owner]; // 沒有清單了：讓出 MAX_OWNERS 的名額
  save();
}

async function addItems(owner, id, rawItems, deps) {
  find(owner, id); // 先確認存在，不存在就不用驗證檔案了
  if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, '沒有要加入的歌曲');
  const items = await normalizeMany(rawItems, deps);
  if (!items.length) throw new HttpError(400, '找不到可加入的歌曲（檔案不存在或網址不支援）');
  const p = find(owner, id); // await 之後重新取得，避免期間已被刪除
  const added = mergeItems(owner, p, items);
  if (added) { p.updatedAt = now(); save(); }
  return { playlist: p, added };
}

function removeItem(owner, id, itemId) {
  const p = find(owner, id);
  const i = p.items.findIndex((x) => x.id === itemId);
  if (i < 0) throw new HttpError(404, '找不到這首歌');
  p.items.splice(i, 1);
  p.updatedAt = now();
  save();
  return p;
}

// 一次移除多首：不存在的 id 直接略過（可能已被其他裝置刪掉），回傳實際移除的數量
function removeItems(owner, id, itemIds) {
  const p = find(owner, id);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new HttpError(400, '沒有要移除的歌曲');
  const drop = new Set(itemIds.map(String));
  const before = p.items.length;
  p.items = p.items.filter((x) => !drop.has(x.id));
  const removed = before - p.items.length;
  if (removed) { p.updatedAt = now(); save(); }
  return { playlist: p, removed };
}

// order：項目 id 陣列。沒列到的項目維持原順序接在後面（避免多裝置同時編輯時遺失歌曲）
function reorder(owner, id, order) {
  const p = find(owner, id);
  if (!Array.isArray(order)) throw new HttpError(400, 'order 必須是陣列');
  const byId = new Map(p.items.map((it) => [it.id, it]));
  const next = [];
  for (const iid of order) {
    const it = byId.get(iid);
    if (it) { next.push(it); byId.delete(iid); }
  }
  for (const it of byId.values()) next.push(it);
  p.items = next;
  p.updatedAt = now();
  save();
  return p;
}

// 音樂庫檔案被移動／重新命名後，所有帳號的播放清單裡指向舊路徑的項目跟著改（音樂庫是共用的）。
// 同一份清單裡新路徑已經存在時，移除舊的那筆（維持「同一清單不重複歌曲」）。回傳受影響的清單數。
function renameLibFile(from, to) {
  if (!from || !to || from === to) return 0;
  let changed = 0;
  for (const p of Object.values(load().owners).flat()) {
    if (!p.items.some((it) => it.kind === 'lib' && it.filename === from)) continue;
    const hasTo = p.items.some((it) => it.kind === 'lib' && it.filename === to);
    p.items = hasTo
      ? p.items.filter((it) => !(it.kind === 'lib' && it.filename === from))
      : p.items.map((it) => (it.kind === 'lib' && it.filename === from ? { ...it, filename: to } : it));
    p.updatedAt = now();
    changed += 1;
  }
  if (changed) save();
  return changed;
}

module.exports = { HttpError, FILE, MAX_OWNER_ITEMS, list, create, rename, remove, addItems, removeItem, removeItems, reorder, renameLibFile };
