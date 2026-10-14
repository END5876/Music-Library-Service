'use strict';
// botSync/index.js — Bot ↔ 網頁「正在播放」同步的入口：整個服務共用一個 hub（狀態只在記憶體）。
// 協定與路由見 routes.js，狀態與指令佇列見 hub.js；Bot 端的實作在各 Bot repo 的
// handlers/musicplayer/unifiedQueue/webSync.js。
const { createHub } = require('./hub');
const { mountBotApi, mountWebApi } = require('./routes');

const hub = createHub();

module.exports = { hub, mountBotApi, mountWebApi };
