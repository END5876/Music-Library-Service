'use strict';
// botSync/hub.js
// ─────────────────────────────────────────────────────────────
// Bot ↔ 網頁「正在播放」同步的狀態中心（只存在記憶體；服務重啟後 Bot 下一次推送就會補回來）。
//
// 連線方向只有「Bot → 這個服務」（沿用 MUSIC_LIB_URL + 金鑰），服務不需要知道 Bot 的位址：
//   - Bot 在播放狀態變動時、以及每 30 秒心跳時推送整份狀態 → putState()
//   - Bot 用長輪詢拿網頁送來的控制指令 → takeCommands()，執行完回報結果 → reportResult()
//   - 網頁送指令 → submitCommand()：排進該 Bot 的指令佇列、叫醒長輪詢，並等 Bot 回報結果
//   - 網頁用 SSE 訂閱狀態變化 → subscribe()
//   - Bot 關閉（重新部署、重啟）前通知下線 → markOffline()：網頁立刻顯示離線，排隊中的指令直接失敗，
//     不會在 Bot 重啟後才被執行；Bot 重新上線後第一次推送狀態就恢復。沒通知就斷線（被強制終止）時，
//     90 秒沒消息也會判定離線。
//
// 所有輸入都來自外部（Bot 推送、網頁請求），一律清理、限制長度與數量後才存。

const crypto = require('crypto');

const STALE_MS = 90 * 1000;              // 超過這麼久沒推送也沒輪詢 → 視為離線
const FORGET_MS = 24 * 60 * 60 * 1000;   // 離線超過一天就從清單移除
const COMMAND_TTL_MS = 30 * 1000;        // 指令排隊超過這麼久還沒被 Bot 拿走 → 丟棄
const RESULT_TIMEOUT_MS = 20 * 1000;     // 等 Bot 回報結果的上限（點線上歌曲要先跑 yt-dlp 取資訊）
const MAX_WAIT_MS = 30 * 1000;           // 長輪詢最長等待
const MAX_BOTS = 20;
const MAX_GUILDS = 50;
const MAX_QUEUE_ITEMS = 50;              // 每個伺服器只存佇列前 50 首（總數另外記）
const MAX_PENDING_COMMANDS = 20;
const DRIFT_MS = 3000;                   // 心跳回報的播放位置與推算值差在這範圍內，就不必通知網頁

const ACTIONS = ['skip', 'stop', 'loop', 'randomPlay', 'enqueue', 'enqueueMany', 'clearQueue', 'removeQueue'];
const LOOP_MODES = ['off', 'one', 'all'];
const PLAYER_STATUSES = ['playing', 'buffering', 'paused', 'autopaused', 'idle'];
const VOICE_STATUSES = ['ready', 'connecting', 'disconnected']; // Bot 的語音連線狀態（空字串＝不在語音頻道）

const isBotId = (v) => typeof v === 'string' && /^[\w-]{1,40}$/.test(v);
const isSnowflake = (v) => typeof v === 'string' && /^\d{1,25}$/.test(v);

function str(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}
function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
}

// 曲目：Bot 端的 local / bilibili 兩種來源，對網頁統一成播放清單用的 lib / online 格式
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'lib') {
    const filename = str(raw.filename, 500);
    if (!filename) return null;
    return { kind: 'lib', filename, title: str(raw.title, 200) || filename };
  }
  if (raw.kind === 'online') {
    const url = str(raw.url, 500);
    if (!/^https:\/\//i.test(url)) return null;
    return {
      kind: 'online',
      url,
      title: str(raw.title, 200) || '未知標題',
      author: str(raw.author, 100),
      platform: raw.platform === 'Bilibili' ? 'Bilibili' : raw.platform === 'YouTube' ? 'YouTube' : '',
      duration: str(raw.duration, 20),
      durationSec: num(raw.durationSec, 0, 24 * 3600),
    };
  }
  return null;
}

function cleanGuild(raw) {
  if (!raw || typeof raw !== 'object' || !isSnowflake(raw.guildId)) return null;
  const queue = Array.isArray(raw.queue) ? raw.queue.slice(0, MAX_QUEUE_ITEMS).map(cleanItem).filter(Boolean) : [];
  return {
    guildId: raw.guildId,
    guildName: str(raw.guildName, 100) || raw.guildId,
    voiceChannel: str(raw.voiceChannel, 100),
    voice: VOICE_STATUSES.includes(raw.voice) ? raw.voice : '',
    current: cleanItem(raw.current),
    status: PLAYER_STATUSES.includes(raw.status) ? raw.status : 'idle',
    positionMs: num(raw.positionMs, 0, 24 * 3600 * 1000),
    queue,
    queueLength: Math.max(queue.length, Math.floor(num(raw.queueLength, 0, 100000))),
    loopMode: LOOP_MODES.includes(raw.loopMode) ? raw.loopMode : 'off',
    randomPlay: !!raw.randomPlay,
  };
}

function createHub({ now = () => Date.now(), resultTimeoutMs = RESULT_TIMEOUT_MS } = {}) {
  const bots = new Map();        // botId -> { id, name, lastSeen, receivedAt, guilds, offline }
  const pending = new Map();     // botId -> [command]
  const waiters = new Map();     // botId -> resolve（同一個 Bot 只保留最新一條長輪詢）
  const results = new Map();     // commandId -> { botId, resolve, timer }
  const taken = new Map();       // commandId -> 已交給長輪詢的指令原件（連線來不及送出時放回佇列用）
  const subscribers = new Set(); // (snapshot) => void
  let broadcastTimer = null;
  const lastOnline = new Map();  // botId -> 上次廣播時的 online，用來偵測「變成離線」

  const isOnline = (b) => !b.offline && now() - b.lastSeen <= STALE_MS;

  function touch(botId) {
    const b = bots.get(botId);
    if (b) b.lastSeen = now();
  }

  // 對外的快照：播放位置換算成「現在」的位置（Bot 推送後經過的時間要加上去）
  function snapshot() {
    const t = now();
    const out = [];
    for (const b of bots.values()) {
      if (t - b.lastSeen > FORGET_MS) { bots.delete(b.id); continue; }
      const online = isOnline(b);
      out.push({
        id: b.id,
        name: b.name,
        online,
        updatedAt: new Date(b.receivedAt).toISOString(),
        guilds: online ? b.guilds.map((g) => ({
          ...g,
          positionMs: g.status === 'playing' ? g.positionMs + (t - b.receivedAt) : g.positionMs,
        })) : [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant') || a.id.localeCompare(b.id));
  }

  // 合併 200ms 內的變動，一次推給所有訂閱者
  function scheduleBroadcast() {
    if (broadcastTimer || !subscribers.size) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const snap = snapshot();
      for (const b of snap) lastOnline.set(b.id, b.online);
      for (const fn of subscribers) { try { fn(snap); } catch {} }
    }, 200);
    if (broadcastTimer.unref) broadcastTimer.unref();
  }

  // Bot 斷線不會主動通知：定期檢查有沒有 Bot 從線上變離線
  const staleTimer = setInterval(() => {
    for (const b of bots.values()) {
      if (lastOnline.get(b.id) !== isOnline(b)) { scheduleBroadcast(); break; }
    }
  }, 15 * 1000);
  if (staleTimer.unref) staleTimer.unref();

  function putState(botId, body) {
    if (!isBotId(botId)) throw Object.assign(new Error('不合法的 Bot ID'), { status: 400 });
    if (!bots.has(botId) && bots.size >= MAX_BOTS) throw Object.assign(new Error('Bot 數量已達上限'), { status: 429 });
    const b = body && typeof body === 'object' ? body : {};
    const guilds = Array.isArray(b.guilds) ? b.guilds.slice(0, MAX_GUILDS).map(cleanGuild).filter(Boolean) : [];
    const t = now();
    const name = str(b.name, 50) || botId;
    // 「內容」簽章：播放位置每次都不同，另外用推算值比對
    const sig = JSON.stringify([name, guilds.map(({ positionMs, ...rest }) => rest)]);
    const prev = bots.get(botId);
    bots.set(botId, { id: botId, name, lastSeen: t, receivedAt: t, guilds, sig });
    // 心跳（每台 Bot 每 30 秒一次）內容沒變、播放位置也跟推算的一致 → 不通知網頁。
    // 否則 Bot 一多，網頁每幾秒就整個重畫一次，正要按的按鈕可能在點下去的瞬間被換掉。
    if (prev && isOnline(prev) && prev.sig === sig && guilds.every((g, i) => {
      const pg = prev.guilds[i];
      const expected = pg.positionMs + (pg.status === 'playing' ? t - prev.receivedAt : 0);
      return Math.abs(expected - g.positionMs) <= DRIFT_MS;
    })) return;
    scheduleBroadcast();
  }

  function dropExpired(botId) {
    const q = pending.get(botId);
    if (!q) return [];
    const t = now();
    const alive = q.filter((c) => t - c.createdAt <= COMMAND_TTL_MS);
    for (const c of q) if (!alive.includes(c)) finish(c.id, { ok: false, message: 'Bot 沒有及時取得指令（可能離線）' });
    pending.set(botId, alive);
    return alive;
  }

  // Bot 主動通知下線：排隊中的指令全部失敗、結束掛著的長輪詢（之後的指令會直接回「Bot 目前離線」）
  function markOffline(botId) {
    const b = bots.get(botId);
    if (!b) return false;
    b.offline = true;
    for (const c of pending.get(botId) || []) finish(c.id, { ok: false, message: 'Bot 正在重新啟動或已離線，指令沒有執行' });
    pending.delete(botId);
    cancelWait(botId);
    scheduleBroadcast();
    return true;
  }

  // 長輪詢：有指令就立刻回傳（並從佇列移除），沒有就等到有指令或逾時
  // token：呼叫端自己的識別物件，之後 cancelWait(botId, token) 只會結束「這一條」長輪詢
  function takeCommands(botId, waitMs = 0, token = null) {
    if (!isBotId(botId)) return Promise.reject(Object.assign(new Error('不合法的 Bot ID'), { status: 400 }));
    touch(botId);
    const take = () => {
      const q = dropExpired(botId);
      pending.set(botId, []);
      for (const c of q) taken.set(c.id, c);
      return q.map(({ id, guildId, action, args }) => ({ id, guildId, action, ...args }));
    };
    const ready = take();
    const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(waitMs) || 0));
    if (ready.length || !wait) return Promise.resolve(ready);

    return new Promise((resolve) => {
      const prev = waiters.get(botId);
      if (prev) prev([]); // 舊連線（例如 Bot 重啟前留下的）直接結束
      const timer = setTimeout(() => done([]), wait);
      const done = (cmds) => {
        clearTimeout(timer);
        if (waiters.get(botId) === wake) waiters.delete(botId);
        touch(botId);
        resolve(cmds);
      };
      const wake = (cmds) => done(cmds || take());
      wake.token = token;
      waiters.set(botId, wake);
    });
  }

  // 長輪詢連線被客戶端中斷時呼叫，避免之後的指令被送進已關閉的連線。
  // 帶 token 時只結束同一條連線：舊連線晚一點才斷，不會把 Bot 剛開的新長輪詢一起結束。
  function cancelWait(botId, token) {
    const w = waiters.get(botId);
    if (!w || (token && w.token !== token)) return;
    waiters.delete(botId);
    w([]);
  }

  // 指令已從佇列取出、但連線在送出前就斷了：放回佇列最前面（保持順序），等下一條長輪詢再送。
  // 已經結束（逾時、Bot 已回報）的指令不放回。
  function requeue(botId, ids) {
    const back = [];
    for (const id of ids || []) {
      const c = taken.get(id);
      taken.delete(id);
      if (c && results.has(id) && results.get(id).botId === botId) back.push(c);
    }
    if (!back.length) return 0;
    pending.set(botId, [...back, ...(pending.get(botId) || [])]);
    const w = waiters.get(botId);
    if (w) w();
    return back.length;
  }

  function finish(id, result) {
    const r = results.get(id);
    if (!r) return false;
    results.delete(id);
    taken.delete(id);
    clearTimeout(r.timer);
    r.resolve(result);
    return true;
  }

  // 網頁送指令：回傳 Promise<{ ok, message }>（Bot 回報的結果，或逾時／離線的說明）
  function submitCommand(botId, guildId, action, args = {}) {
    const b = bots.get(botId);
    if (!b) return Promise.resolve({ ok: false, status: 404, message: '找不到這個 Bot' });
    if (!isOnline(b)) return Promise.resolve({ ok: false, status: 409, message: 'Bot 目前離線' });
    if (!isSnowflake(guildId)) return Promise.resolve({ ok: false, status: 400, message: '不合法的伺服器 ID' });
    if (!ACTIONS.includes(action)) return Promise.resolve({ ok: false, status: 400, message: '不支援的操作' });
    const q = dropExpired(botId);
    if (q.length >= MAX_PENDING_COMMANDS) return Promise.resolve({ ok: false, status: 429, message: '指令太多，請稍後再試' });

    const id = crypto.randomBytes(6).toString('hex');
    q.push({ id, guildId, action, args, createdAt: now() });
    pending.set(botId, q);

    const promise = new Promise((resolve) => {
      // 逾時：Bot 還沒拿走的指令一併撤回，避免網頁已顯示失敗、Bot 重新連上後卻又執行了；
      // 已經拿走的（例如點線上歌曲要先跑 yt-dlp）可能仍會完成，訊息要講清楚
      const timer = setTimeout(() => {
        const q = pending.get(botId) || [];
        const i = q.findIndex((c) => c.id === id);
        if (i >= 0) q.splice(i, 1);
        finish(id, { ok: false, message: i >= 0 ? 'Bot 沒有回應（逾時），指令已取消' : 'Bot 沒有及時回報結果，指令可能仍會執行' });
      }, resultTimeoutMs);
      if (timer.unref) timer.unref();
      results.set(id, { botId, resolve, timer });
    });
    const w = waiters.get(botId);
    if (w) w();
    return promise;
  }

  function reportResult(botId, id, body) {
    const r = results.get(id);
    if (!r || r.botId !== botId) return false;
    const b = body && typeof body === 'object' ? body : {};
    return finish(id, { ok: !!b.ok, message: str(b.message, 300) });
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function close() {
    clearInterval(staleTimer);
    clearTimeout(broadcastTimer);
    for (const w of waiters.values()) w([]);
    for (const id of [...results.keys()]) finish(id, { ok: false, message: '服務關閉' });
  }

  return {
    putState, markOffline, takeCommands, cancelWait, requeue, submitCommand, reportResult, snapshot, subscribe, close,
    subscriberCount: () => subscribers.size,
  };
}

module.exports = { createHub, cleanItem, ACTIONS, LOOP_MODES, STALE_MS, isBotId };
