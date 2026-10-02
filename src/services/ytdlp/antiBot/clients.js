'use strict';
// antiBot/clients.js — YouTube player_client 優先順序與輪換（key 原本是 Bot 的 guildId，網頁版固定用 'web'）

// ── YouTube player_client 優先順序策略 ───────────────────
const YT_CLIENT_STRATEGIES = [
  {
    name    : 'default',
    args    : [], // 不指定參數，使用 yt-dlp 預設
    needsPO : false,
    desc    : '預設 client（最穩定，繞過 TV DRM 限制）',
  },
  {
    name    : 'mweb+po',
    args    : ['--extractor-args', 'youtube:player_client=default,mweb'],
    needsPO : true,
    desc    : 'mweb client（需要 PO Token）',
  },
  {
    name    : 'tv',
    args    : ['--extractor-args', 'youtube:player_client=tv'],
    needsPO : false,
    desc    : 'TV client（容易遇到 DRM 限制，作為備用）',
  },
  {
    name    : 'tv_simply',
    args    : ['--extractor-args', 'youtube:player_client=tv_simply'],
    needsPO : false,
    desc    : 'TV Simply client',
  },
  {
    name    : 'web_embedded',
    args    : ['--extractor-args', 'youtube:player_client=web_embedded'],
    needsPO : false,
    desc    : 'web_embedded（僅可嵌入影片，最後備用）',
  },
];

const ytClientIndex = new Map();


function getYtClientStrategy(guildId) {
  const idx = ytClientIndex.get(guildId) || 0;
  return { strategy: YT_CLIENT_STRATEGIES[idx], idx };
}

function rotateYtClient(guildId) {
  const current = ytClientIndex.get(guildId) || 0;
  const next    = current + 1;
  if (next < YT_CLIENT_STRATEGIES.length) {
    ytClientIndex.set(guildId, next);
    console.log(`🔄 [YouTube] 切換 client: ${YT_CLIENT_STRATEGIES[current].name} → ${YT_CLIENT_STRATEGIES[next].name}`);
    return true;
  }
  ytClientIndex.set(guildId, 0);
  console.warn('⚠️ [YouTube] 所有 client 均失敗，重置為 default');
  return false;
}

function resetYtClient(guildId) {
  ytClientIndex.delete(guildId);
}


module.exports = { YT_CLIENT_STRATEGIES, getYtClientStrategy, rotateYtClient, resetYtClient };
