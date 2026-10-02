// queue/shuffle.js — 隨機佇列
import { mkLib } from './model.js';
import { shuffled } from '../core/util.js';
import { renderNext } from './view.js';
import { S } from '../core/state.js';

// 立刻把目前清單排成一份不重複的隨機順序;手動加入的線上歌曲保留在最前面
// includeCurrent:新一輪開始時要把剛播完的那首也排進去(否則每一輪都會少一首)
export function buildShuffle({ includeCurrent = false, render = true } = {}) {
  const online = S.queue.filter(e => e.kind === 'online');
  let files = S.view.map(f => f.filename);
  if (!includeCurrent) files = files.filter(f => f !== S.currentFile);
  const order = shuffled(files);
  // 新一輪的第一首不要正好是剛播完的那首(清單只有一首時除外)
  if (includeCurrent && order.length > 1 && order[0] === S.currentFile) {
    const j = 1 + Math.floor(Math.random() * (order.length - 1));
    [order[0], order[j]] = [order[j], order[0]];
  }
  S.queue = online.concat(order.map(mkLib));
  if (render) renderNext();
}

// 篩選變動時:只有「清單內容」真的變了才重排,避免打字搜尋時每個字都洗牌、也保留使用者拖曳過的順序
export function syncShuffleQueue() {
  if (S.playlistCtx) return; // 播放清單有自己的隨機佇列
  const want = new Set(S.view.map(f => f.filename));
  want.delete(S.currentFile);
  const have = S.queue.filter(e => e.kind === 'lib');
  const same = have.length === want.size && have.every(e => want.has(e.filename));
  if (!same) buildShuffle({ render: false });
}
