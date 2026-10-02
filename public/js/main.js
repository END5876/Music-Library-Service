// main.js — 進入點：載入全部模組並初始化

import './core/dom.js';
import './core/constants.js';
import './core/debug.js';
import './core/state.js';
import './core/util.js';
import './core/toast.js';
import './core/prefs.js';
import { registerSW } from './core/serviceWorker.js';
import './auth/auth.js';
import './audio/helpers.js';
import './ui/rows.js';
import './ui/menus.js';
import './ui/fullscreen.js';
import './ui/keyboard.js';
import './ui/nav.js';
import { loadList, setNow } from './library/library.js';
import './queue/model.js';
import './queue/shuffle.js';
import './queue/view.js';
import './queue/drag.js';
import './playback/controller.js';
import { updatePlayIcons, updateProgress } from './audio/events.js';
import './audio/prefetch.js';
import { syncButtons } from './audio/controls.js';
import './audio/mediaSession.js';
import './online/online.js';
import './playlists/model.js';
import { offlineInit } from './offline/idb.js';
import './offline/source.js';
import './offline/downloads.js';
import './offline/paint.js';
import './playlists/api.js';
import './playlists/context.js';
import './playlists/dialog.js';
import './playlists/actions.js';
import './playlists/picker.js';
import './playlists/view.js';
import './playlists/drag.js';
import './playlists/page.js';

// ── 初始化 ──
syncButtons();

setNow(null);

updateProgress();

updatePlayIcons();

offlineInit().finally(() => loadList()); // 先讀出離線清單,畫面才能正確標示

registerSW();
