'use strict';
// webplayer/playlistStore.js
// ─────────────────────────────────────────────────────────────
// 網頁播放器的播放清單儲存（單一 JSON 檔，同步原子寫入）。
//
// 檔案位置：PLAYLISTS_FILE，預設 <repo root>/data/playlists.json（Docker 內為 /app/data，掛 Volume）
//   → 在音樂庫資料夾外面，不會出現在曲目清單，也不會被快取清理刪掉。
//   舊版預設位置 <MUSIC_DIR>/.web/playlists.json：新位置還沒有檔案時，第一次讀取會自動複製過來。
//
// 項目格式（id 由伺服器產生，同一個播放清單內不重複歌曲）：
//   { id, kind:'lib',    filename, title }
//   { id, kind:'online', url, title, author, platform, duration }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../musicStore');

const FILE = process.env.PLAYLISTS_FILE || path.join(__dirname, '..', 'data', 'playlists.json');
const LEGACY_FILE = process.env.PLAYLISTS_FILE ? null : path.join(store.MUSIC_DIR, '.web', 'playlists.json');
const MAX_PLAYLISTS = 100;
const MAX_ITEMS = 2000;
const MAX_NAME = 50;
const MAX_ADD_PER_REQUEST = 2000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

let data = null;

function load() {
  if (data) return data;
  data = { playlists: [] };
  migrateLegacyFile();
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('❌ [Playlists] 讀取失敗:', err.message);
    return data;
  }
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.playlists)) data = { playlists: j.playlists };
  } catch (err) {
    // 檔案壞掉：改名備份，避免下一次存檔把它覆蓋掉
    const bak = `${FILE}.corrupt-${Date.now()}.bak`;
    try { fs.renameSync(FILE, bak); } catch {}
    console.error(`❌ [Playlists] JSON 解析失敗，已備份為 ${path.basename(bak)}:`, err.message);
  }
  return data;
}

// 舊位置的檔案保留不刪，當作備份
function migrateLegacyFile() {
  if (!LEGACY_FILE || fs.existsSync(FILE) || !fs.existsSync(LEGACY_FILE)) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.copyFileSync(LEGACY_FILE, FILE, fs.constants.COPYFILE_EXCL);
    console.log(`📦 [Playlists] 已將舊版播放清單 ${LEGACY_FILE} 複製到 ${FILE}`);
  } catch (err) {
    console.error('❌ [Playlists] 搬移舊版播放清單失敗:', err.message);
  }
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

function find(id) {
  const p = load().playlists.find((x) => x.id === id);
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

async function normalizeMany(rawItems, deps) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  for (const raw of rawItems.slice(0, MAX_ADD_PER_REQUEST)) {
    const it = await normalizeItem(raw, deps);
    if (it) out.push(it);
  }
  return out;
}

// 同步區段：把已驗證的項目併入（去重、上限），避免 await 期間清單被改動
function mergeItems(p, items) {
  const have = new Set(p.items.map(itemKey));
  let added = 0;
  for (const it of items) {
    const k = itemKey(it);
    if (have.has(k)) continue;
    if (p.items.length >= MAX_ITEMS) throw new HttpError(400, `播放清單最多 ${MAX_ITEMS} 首`);
    have.add(k);
    p.items.push({ id: newId(), ...it });
    added += 1;
  }
  return added;
}

// ════════════════════════════════════════════════════════
function list() { return load().playlists; }

async function create(rawName, rawItems, deps) {
  const name = cleanName(rawName);
  const items = await normalizeMany(rawItems, deps);
  const d = load();
  if (d.playlists.length >= MAX_PLAYLISTS) throw new HttpError(400, `最多 ${MAX_PLAYLISTS} 個播放清單`);
  const t = now();
  const p = { id: newId(), name, items: [], createdAt: t, updatedAt: t };
  mergeItems(p, items);
  d.playlists.push(p);
  save();
  return p;
}

function rename(id, rawName) {
  const p = find(id);
  p.name = cleanName(rawName);
  p.updatedAt = now();
  save();
  return p;
}

function remove(id) {
  const d = load();
  const i = d.playlists.findIndex((x) => x.id === id);
  if (i < 0) throw new HttpError(404, '找不到播放清單');
  d.playlists.splice(i, 1);
  save();
}

async function addItems(id, rawItems, deps) {
  find(id); // 先確認存在，不存在就不用驗證檔案了
  if (!Array.isArray(rawItems) || !rawItems.length) throw new HttpError(400, '沒有要加入的歌曲');
  const items = await normalizeMany(rawItems, deps);
  if (!items.length) throw new HttpError(400, '找不到可加入的歌曲（檔案不存在或網址不支援）');
  const p = find(id); // await 之後重新取得，避免期間已被刪除
  const added = mergeItems(p, items);
  if (added) { p.updatedAt = now(); save(); }
  return { playlist: p, added };
}

function removeItem(id, itemId) {
  const p = find(id);
  const i = p.items.findIndex((x) => x.id === itemId);
  if (i < 0) throw new HttpError(404, '找不到這首歌');
  p.items.splice(i, 1);
  p.updatedAt = now();
  save();
  return p;
}

// order：項目 id 陣列。沒列到的項目維持原順序接在後面（避免多裝置同時編輯時遺失歌曲）
function reorder(id, order) {
  const p = find(id);
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

module.exports = { HttpError, FILE, list, create, rename, remove, addItems, removeItem, reorder };
