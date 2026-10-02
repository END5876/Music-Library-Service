// offline/source.js — 載入音源：有離線檔播離線，否則走網路
import { audio } from '../core/dom.js';
import { S, offlineKeys } from '../core/state.js';
import { setSession, tryPlay } from '../audio/helpers.js';
import { offlineGet } from './idb.js';

// 載入音源:有離線檔就播離線的(blob URL,可拖曳),沒有才走網路
let srcTok = 0, blobUrl = null;

export function loadSource(key, url) {
  const tok = ++srcTok;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if (!offlineKeys.has(key)) { audio.src = url; tryPlay(); return; }
  audio.removeAttribute('src'); audio.load(); // 等 blob 讀出來之前不要讓舊的音源繼續播
  S.pendingPlay = true; setSession('playing');
  offlineGet(key).then((blob) => {
    if (tok !== srcTok) return;
    if (blob) { blobUrl = URL.createObjectURL(blob); audio.src = blobUrl; } else audio.src = url;
    tryPlay();
  }).catch(() => { if (tok === srcTok) { audio.src = url; tryPlay(); } });
}
