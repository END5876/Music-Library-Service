// core/state.js — 共用可變狀態。所有會被多個模組改寫的變數都收在 S 物件上（S.queue、S.shuffle…）
import { LIB_PAGE } from './constants.js';

export const S = {
  // ── 狀態 ──
  all: [], // 全部曲目
  view: [], // 目前篩選後的清單
  currentFile: null, // 目前播放的音樂庫 filename
  onlineCurrent: null,
  onlineAvailable: false,
  byFile: new Map(), // filename -> 曲目(O(1) 查詢,取代 all.find)
  nextDirty: true, // 佇列畫面是否需要重畫(全螢幕頁沒開時不畫)
  libLimit: LIB_PAGE,
  shuffle: false,
  repeat: 'all',
  history: [],
  errorStreak: 0,
  pendingPlay: false, // 程式已要求播放、但還沒真的開始(載入中)
  endHandled: false, // 這次 ended 是否已處理過
  mode: 'library',
  folder: '',
  libQuery: '',
  onlineQuery: '',
  // 佇列:統一存放「接下來要播的」項目,可拖曳排序
  // 項目:{ id, kind:'lib', filename } 或 { id, kind:'online', item }
  queue: [],
  // 播放清單(存在伺服器,跨裝置共用)
  playlists: [],
  plOpen: null, // 目前打開的播放清單 id
  plQuery: '',
  playlistCtx: null, // 目前正在播放的播放清單:{ id, items }
  // ── audio 事件 ──
  dragging: false,
};

// 離線下載(IndexedDB)
export const offlineKeys = new Set(); // 已下載的 key('lib:<filename>' / 'on:<url>')

export const dlState = new Map(); // key -> { pct, active }(排隊中／下載中)
