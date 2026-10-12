'use strict';
// webplayer/durationStore.js
// 音樂庫曲目的「歌曲長度」快取（網頁播放器的列表顯示用）。
//
//   lookup(files, absPathOf)  回傳 { durations: Map<filename, 秒數>, pending }；
//                             還沒讀過（或檔案大小／修改時間變了）的曲目會排進背景佇列，用 ffprobe 讀取。
//                             pending=true 代表還有曲目在排隊，前端可以稍後再要一次清單補上長度。
//
// 結果存在 DURATIONS_FILE（預設 <repo root>/data/durations.json，Docker 內為 /app/data，掛 Volume），
// 重新啟動不必重讀。讀不出長度的檔案記為 d:0，在檔案異動前不再重試。
// 伺服器沒有 ffprobe 時整個功能安靜停用：清單照常回傳，只是沒有長度。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const FILE = process.env.DURATIONS_FILE || path.join(__dirname, '..', 'data', 'durations.json');
const CONCURRENCY = 2;            // ffprobe 很輕，但上千首第一次掃描時不要搶走正規化／串流的 CPU
const PROBE_TIMEOUT_MS = 20000;
const SAVE_DELAY_MS = 5000;       // 合併存檔：背景讀取期間最多每 5 秒寫一次

let cache = null;                 // filename -> { size, mtimeMs, d }
let disabled = false;
let active = 0;
let saveTimer = null;
const queue = [];
const queued = new Set();
const idleWaiters = [];

function ffprobe(absPath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', absPath],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        const d = parseFloat(String(stdout).trim());
        if (!Number.isFinite(d) || d <= 0) return reject(new Error('無法讀取長度'));
        resolve(Math.round(d));
      });
  });
}
let probe = ffprobe;

function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(j || {})) {
      if (v && typeof v.d === 'number') cache.set(k, v);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('❌ [Durations] 讀取快取失敗，將重新讀取長度:', err.message);
  }
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, SAVE_DELAY_MS);
  if (saveTimer.unref) saveTimer.unref();
}

async function save() {
  const tmp = `${FILE}.tmp`;
  try {
    await fsp.mkdir(path.dirname(FILE), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(cache)));
    await fsp.rename(tmp, FILE);
  } catch (err) {
    console.error('❌ [Durations] 存檔失敗:', err.message);
  }
}

function pump() {
  while (!disabled && active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    probe(job.absPath)
      .then((d) => { cache.set(job.filename, { size: job.size, mtimeMs: job.mtimeMs, d }); })
      .catch((err) => {
        if (err && err.code === 'ENOENT' && String(err.syscall || '').startsWith('spawn')) {
          // 找不到 ffprobe 執行檔:停用,不要每首都再試一次
          disabled = true;
          for (const j of queue) queued.delete(j.filename);
          queue.length = 0;
          console.warn('⚠️ [Durations] 找不到 ffprobe，網頁播放器不顯示歌曲長度');
          return;
        }
        cache.set(job.filename, { size: job.size, mtimeMs: job.mtimeMs, d: 0 });
      })
      .finally(() => {
        active--;
        queued.delete(job.filename);
        scheduleSave();
        pump();
        if (!active && !queue.length) idleWaiters.splice(0).forEach((fn) => fn());
      });
  }
}

function lookup(files, absPathOf) {
  load();
  const durations = new Map();
  const live = new Set();
  for (const f of files) {
    live.add(f.filename);
    const c = cache.get(f.filename);
    if (c && c.size === f.size && c.mtimeMs === f.mtimeMs) {
      if (c.d) durations.set(f.filename, c.d);
      continue;
    }
    if (disabled || queued.has(f.filename)) continue;
    let absPath;
    try { absPath = absPathOf(f.filename); } catch { absPath = null; }
    if (!absPath) continue;
    queued.add(f.filename);
    queue.push({ filename: f.filename, absPath, size: f.size, mtimeMs: f.mtimeMs });
  }
  // 已不在音樂庫裡的曲目(快取清理、刪除)從快取移除,避免檔案無限長大
  let pruned = false;
  for (const k of cache.keys()) if (!live.has(k)) { cache.delete(k); pruned = true; }
  if (pruned) scheduleSave();
  pump();
  return { durations, pending: !disabled && (queue.length > 0 || active > 0) };
}

module.exports = {
  lookup,
  // 測試用
  _setProbe(fn) { probe = fn; },
  _reset() { cache = null; disabled = false; queue.length = 0; queued.clear(); },
  _idle() { return !active && !queue.length ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)); },
  _flush: save,
  FILE,
};
