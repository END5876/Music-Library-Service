'use strict';
// playerBots.js
// 「Bot 正在播放」頁籤：即時顯示各 Bot、各伺服器正在播的歌、播放進度與佇列，並可遠端控制
// （跳過、停止、循環、隨機連播、清空／移除佇列），以及把音樂庫或線上歌曲「點給 Bot 播放」。
// 伺服器端協定見 botSync/routes.js：GET /web/api/bots、SSE /web/api/bots/events、POST /web/api/bots/:id/command。
//
// createBots(deps) 回傳 { show, hide, refresh, hasTargets, sendToBot }；deps 由 player.js 傳入：
//   sendToBot(items, onDone)：items 可以是一首或多首（多選、整份播放清單）；一首走 enqueue（Bot 會查完整影片資訊），
//   多首走 enqueueMany（一次最多 MAX_BATCH 首，線上歌曲直接用帶過去的資訊）。onDone 在送出成功後呼叫（例如結束多選）。
//   $ / setStatus / askConfirm / pushLayer / dropLayer / fmt / makeRow   畫面工具
//   libInfo(filename) → { name, duration } | null           音樂庫曲目的名稱與長度（Bot 不知道本地檔的長度）
//   showLogin(msg)                                          登入過期時叫出登入框
// 頁籤開著時才連 SSE；關掉就斷線，不在背景佔連線。
// 載入順序：必須早於 player.js（player.html 的 <script> 順序、sw.js 的 SHELL_URLS 都要列出）。
(() => {
  function createBots({ $, setStatus, askConfirm, pushLayer, dropLayer, fmt, makeRow, libInfo, showLogin }) {
    let bots = [];
    let receivedAt = 0;        // 收到這份狀態的時間（播放進度從這裡往後推算）
    let es = null;
    let visible = false;
    let tickTimer = 0;
    let progress = [];         // [{ g, durSec, cur, bar }] 每秒更新的進度元素
    const busy = new Set();    // 送出中的「botId|guildId」：避免連點

    const LOOP_LABEL = { off: '不循環', one: '單曲循環', all: '列表循環' };
    // autopaused：@discordjs/voice 在「沒有可用的語音連線」時自動暫停（例如 Bot 被踢出、連線重建中）
    const STATUS_LABEL = { paused: '已暫停', autopaused: '已暫停（語音連線中斷）', buffering: '緩衝中…' };
    const VOICE_LABEL = { connecting: '連線中…', disconnected: '連線中斷,重新連線中…' };

    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s; };
    const parseDur = (s) => { const p = String(s || '').split(':').map(Number); return p.every(Number.isFinite) && p.length > 1 ? p.reduce((a, b) => a * 60 + b, 0) : 0; };
    const itemKey = (it) => (it.kind === 'lib' ? 'lib:' + it.filename : 'on:' + it.url);
    const itemSub = (it) => it.kind === 'lib'
      ? (it.filename.includes('/') ? it.filename.split('/')[0] : '音樂庫')
      : [it.platform, it.author].filter(Boolean).join(' · ') || '線上歌曲';
    const itemTitle = (it) => (it.kind === 'lib' && libInfo(it.filename)?.name) || it.title;
    const itemDur = (it) => (it.kind === 'lib' ? (libInfo(it.filename)?.duration || 0) : (it.durationSec || parseDur(it.duration)));
    // 可以點歌的目標：在線的 Bot、且在語音頻道裡（被踢出但還留著播放狀態的不算；用 voiceChannel 判斷，舊版 Bot 也有這個欄位）
    const targets = () => bots.filter((b) => b.online).flatMap((b) => b.guilds.filter((g) => g.voiceChannel).map((g) => ({ bot: b, g })));
    // 好幾台 Bot 同名（例如同一套程式部署多份、都叫 Mouse）時，名稱後面加 ID 末 4 碼區分；建議 Bot 端設 WEB_SYNC_BOT_NAME
    const botLabel = (b) => (bots.filter((x) => x.name === b.name).length > 1 ? b.name + '（…' + b.id.slice(-4) + '）' : b.name);

    function setData(list) {
      bots = Array.isArray(list) ? list : [];
      receivedAt = Date.now();
      if (visible) render();
    }

    async function refresh() {
      try {
        const r = await fetch('/web/api/bots');
        if (r.status === 401) return false;
        if (!r.ok) return false;
        setData((await r.json()).bots);
        return true;
      } catch { return false; }
    }

    async function command(botId, guildId, action, args = {}) {
      const k = botId + '|' + guildId;
      if (busy.has(k)) return null;
      busy.add(k);
      if (visible) render();
      try {
        const r = await fetch('/web/api/bots/' + encodeURIComponent(botId) + '/command', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guildId, action, ...args }),
        });
        if (r.status === 401) { showLogin('登入已過期,請重新登入'); return null; }
        const j = await r.json().catch(() => ({}));
        setStatus((j.ok ? '' : '❌ ') + (j.message || (j.ok ? '完成' : '操作失敗')));
        return j;
      } catch {
        setStatus('❌ 連線失敗');
        return null;
      } finally {
        busy.delete(k);
        if (visible) render();
      }
    }

    // ── 畫面 ──────────────────────────────────────────
    function ctrlBtn(iconName, label, onClick, { active = false, disabled = false, cls = '' } = {}) {
      const b = el('button', 'btn btn-sm ' + (active ? 'btn-primary' : 'btn-secondary') + (cls ? ' ' + cls : ''));
      b.type = 'button';
      if (iconName) b.appendChild(icon(iconName));
      b.appendChild(document.createTextNode(label));
      b.disabled = disabled;
      b.setAttribute('aria-pressed', String(active));
      b.addEventListener('click', onClick);
      return b;
    }

    function guildBlock(bot, g) {
      const k = bot.id + '|' + g.guildId;
      const pending = busy.has(k);
      const run = (action, args) => command(bot.id, g.guildId, action, args);
      const box = el('div', 'bot-guild');

      const head = el('div', 'bot-guild-head');
      head.append(el('b', '', g.guildName));
      if (g.voiceChannel) head.append(el('span', 'bot-vc', '🔊 ' + g.voiceChannel + (VOICE_LABEL[g.voice] ? '(' + VOICE_LABEL[g.voice] + ')' : '')));
      else if (g.current) head.append(el('span', 'bot-vc', '已不在語音頻道'));
      box.append(head);

      if (!g.current) {
        box.append(el('div', 'hint', '在語音頻道待命中,沒有播放。可以從音樂庫或線上搜尋的「⋮」選單「點給 Bot 播放」。'));
      } else {
        const now = el('div', 'bot-now');
        const info = el('div', 'info');
        info.append(el('div', 't', itemTitle(g.current)), el('div', 'a', itemSub(g.current) + (STATUS_LABEL[g.status] ? ' · ' + STATUS_LABEL[g.status] : '')));
        const prog = el('div', 'bot-prog');
        const cur = el('span', 'cur'), bar = el('div', 'bar'), fill = el('i'), dur = el('span', 'dur');
        bar.append(fill);
        prog.append(cur, bar, dur);
        info.append(prog);
        now.append(el('div', 'cover'), info);
        box.append(now);
        const durSec = itemDur(g.current);
        dur.textContent = durSec ? fmt(durSec) : '';
        progress.push({ g, durSec, cur, fill });

        const ctrls = el('div', 'bot-ctrls');
        ctrls.append(
          ctrlBtn('next', '跳過', () => run('skip'), { disabled: pending }),
          ctrlBtn('stop', '停止', async () => {
            const ok = await askConfirm('停止 Bot 播放?', `「${g.guildName}」的播放與佇列都會清除。`, { ok: '停止', danger: true });
            if (ok) run('stop');
          }, { disabled: pending }),
        );
        const modes = el('div', 'bot-modes');
        for (const m of ['off', 'one', 'all']) {
          const c = el('button', 'chip' + (!g.randomPlay && g.loopMode === m ? ' active' : ''), LOOP_LABEL[m]);
          c.type = 'button'; c.disabled = pending;
          c.addEventListener('click', () => run('loop', { mode: m }));
          modes.append(c);
        }
        const rnd = el('button', 'chip' + (g.randomPlay ? ' active' : ''), '🎲 隨機連播');
        rnd.type = 'button'; rnd.disabled = pending;
        rnd.addEventListener('click', () => run('randomPlay', { on: !g.randomPlay }));
        modes.append(rnd);
        box.append(ctrls, modes);
      }

      if (g.queueLength) {
        const qh = el('div', 'bot-queue-head');
        qh.append(el('h4', '', `佇列 ${g.queueLength} 首`));
        const clr = ctrlBtn(null, '清空', async () => {
          const ok = await askConfirm('清空 Bot 的佇列?', `「${g.guildName}」佇列裡的 ${g.queueLength} 首歌會被移除。`, { ok: '清空', danger: true });
          if (ok) run('clearQueue');
        }, { disabled: pending });
        qh.append(clr);
        const ul = el('ul', 'quick');
        g.queue.forEach((it, i) => {
          const d = itemDur(it);
          ul.append(makeRow({
            title: itemTitle(it), sub: itemSub(it), idx: i + 1, dur: d ? fmt(d) : '',
            btn: { icon: 'close', title: '從 Bot 佇列移除', onClick: () => run('removeQueue', { index: i, key: itemKey(it) }) },
          }));
        });
        box.append(qh, ul);
        if (g.queueLength > g.queue.length) box.append(el('div', 'hint', `…還有 ${g.queueLength - g.queue.length} 首`));
      }
      return box;
    }

    function render() {
      const list = $('botsList');
      list.textContent = '';
      progress = [];
      const online = bots.filter((b) => b.online);
      $('botsCount').textContent = bots.length ? `${online.length}/${bots.length} 在線` : '';
      $('botsEmpty').hidden = bots.length > 0;
      for (const b of bots) {
        const card = el('section', 'bot-card' + (b.online ? '' : ' offline'));
        const head = el('div', 'bot-head');
        head.append(icon('bot'), el('b', '', botLabel(b)), el('span', 'bot-dot' + (b.online ? ' on' : ''), b.online ? '在線' : '離線'));
        card.append(head);
        if (!b.online) {
          card.append(el('div', 'hint', '最後更新 ' + new Date(b.updatedAt).toLocaleString()));
        } else if (!b.guilds.length) {
          card.append(el('div', 'hint', '目前不在任何語音頻道。在 Discord 用 /play 讓 Bot 加入後,就能從這裡控制與點歌。'));
        } else {
          for (const g of b.guilds) card.append(guildBlock(b, g));
        }
        list.append(card);
      }
      tick();
    }

    // 播放進度：從收到狀態的那一刻往後推算（Bot 每 30 秒、或有變動時會再推一次校正）
    function tick() {
      const dt = Date.now() - receivedAt;
      for (const p of progress) {
        const sec = (p.g.positionMs + (p.g.status === 'playing' ? dt : 0)) / 1000;
        const s = p.durSec ? Math.min(sec, p.durSec) : sec;
        p.cur.textContent = fmt(s);
        p.fill.style.width = p.durSec ? Math.min(100, s / p.durSec * 100).toFixed(2) + '%' : '0%';
      }
    }

    function connect() {
      if (es || !window.EventSource) return;
      es = new EventSource('/web/api/bots/events');
      es.addEventListener('state', (e) => {
        try { setData(JSON.parse(e.data).bots); } catch {}
        $('botsHint').hidden = true;
      });
      es.onerror = () => {
        // EventSource 會自己重連；斷線期間提示一下，並確認是不是登入過期（SSE 拿不到狀態碼）
        $('botsHint').hidden = false;
        $('botsHint').textContent = '與伺服器的連線中斷,重新連線中…';
        fetch('/web/api/bots').then((r) => { if (r.status === 401) { disconnect(); showLogin('登入已過期,請重新登入'); } }).catch(() => {});
      };
    }
    function disconnect() {
      if (es) { es.close(); es = null; }
    }

    function show() {
      visible = true;
      render();
      connect();
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 1000);
    }
    function hide() {
      visible = false;
      disconnect();
      clearInterval(tickTimer);
    }

    // ── 點給 Bot 播放 ───────────────────────────────────
    const MAX_BATCH = 500; // 與伺服器 botSync/routes.js 的上限一致
    let pickItems = null, pickDone = null;
    function closePick() {
      if (!$('botPick').classList.contains('show')) return;
      $('botPick').classList.remove('show');
      pickItems = null; pickDone = null;
      dropLayer('botPick');
    }
    const toPayload = (it) => (it.kind === 'lib'
      ? { kind: 'lib', filename: it.filename, title: it.title }
      : { kind: 'online', url: it.srcUrl || it.url, title: it.title, author: it.author || '', duration: it.duration || '' });
    $('botPickClose').addEventListener('click', closePick);
    $('botPick').addEventListener('click', (e) => { if (e.target === $('botPick')) closePick(); });

    async function sendToBot(items, onDone) {
      const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
      if (!list.length) return;
      await refresh();
      const ts = targets();
      if (!ts.length) return setStatus('沒有可以點歌的 Bot:Bot 要先在 Discord 的語音頻道裡');
      pickItems = list.slice(0, MAX_BATCH); pickDone = onDone || null;
      $('botPickTitle').textContent = list.length > 1 ? `點給 Bot 播放(${pickItems.length} 首)` : '點給 Bot 播放';
      $('botPickSong').textContent = list.length > 1
        ? `「${itemTitle(list[0])}」等 ${list.length} 首` + (list.length > MAX_BATCH ? `\n一次最多 ${MAX_BATCH} 首,只會送出前 ${MAX_BATCH} 首` : '')
        : itemTitle(list[0]);
      $('botPickNext').parentElement.lastChild.textContent = list.length > 1 ? '下一首播放(整批插到 Bot 佇列最前面)' : '下一首播放(插到 Bot 佇列最前面)';
      const ul = $('botPickList');
      ul.textContent = '';
      for (const { bot, g } of ts) {
        ul.append(makeRow({
          title: g.guildName + (g.voiceChannel ? ' · 🔊 ' + g.voiceChannel : ''),
          sub: botLabel(bot) + ' · ' + (g.current ? '正在播:' + itemTitle(g.current) : '待命中'),
          onClick: async () => {
            const its = pickItems, done = pickDone, next = $('botPickNext').checked;
            closePick();
            setStatus(its.length > 1 ? `已送出 ${its.length} 首給 Bot,處理中…` : '已送給 Bot,處理中…', true);
            const r = its.length > 1
              ? await command(bot.id, g.guildId, 'enqueueMany', { items: its.map(toPayload), next })
              : await command(bot.id, g.guildId, 'enqueue', { item: toPayload(its[0]), next });
            if (r && r.ok && done) done();
          },
        }));
      }
      $('botPick').classList.add('show');
      pushLayer('botPick', closePick);
    }

    return { show, hide, refresh, hasTargets: () => targets().length > 0, sendToBot };
  }

  window.MLBots = { createBots };
})();
