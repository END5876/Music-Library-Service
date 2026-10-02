'use strict';
// ytdlp/info.js — 取得影片資訊（getInfo）＋ 短暫快取。YouTube + Bilibili（同 Bot）
const { spawn } = require('child_process');
const antiBot = require('./antiBot');
const state = require('./state');
const { formatDuration } = require('../../utils/urlUtils');
const { ytdlpPath, GET_INFO_TIMEOUT_MS, MAX_WEB_QUERIES, INFO_CACHE_TTL_MS, INFO_CACHE_MAX } = require('./constants');

async function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args  = antiBot.buildInfoArgs(url);
    const ytdlp = spawn(ytdlpPath, args);
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [getInfo] 逾時（超過 ${GET_INFO_TIMEOUT_MS / 1000}s），強制終止: ${url}`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      reject(new Error('取得影片資訊逾時，請確認網址是否正確或稍後再試'));
    }, GET_INFO_TIMEOUT_MS);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0) {
        console.error('yt-dlp 錯誤輸出:', errorData);
        if (antiBot.isYouTubeUrl(url)) {
          const classified = antiBot.classifyYouTubeError(errorData);
          reject(new Error(`[YouTube] ${classified.msg}`));
        } else {
          const classified = antiBot.classifyBilibiliError(errorData);
          reject(new Error(`[Bilibili] ${classified.msg}`));
        }
        return;
      }
      try {
        const info = JSON.parse(data.trim().split('\n').pop());
        resolve({
          url,
          title      : info.title    || '未知標題',
          author     : info.uploader || info.channel || info.creator || '未知作者',
          duration   : formatDuration(info.duration),
          durationSec: info.duration || 0,   // 保留原始秒數，供快取判斷使用
          thumbnail  : info.thumbnail || null,
        });
      } catch { reject(new Error('解析影片資訊失敗')); }
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('執行 yt-dlp 失敗: ' + err.message));
    });
  });
}

// 網頁版新增：getInfo 結果短暫快取。
// 網頁流程是「先 /info 顯示標題 → 再 /play 串流」兩次請求，
// 第二次不該再花一次 yt-dlp（durationSec 一律由伺服器自己取得，不信任瀏覽器傳來的數值）。
async function getInfoCached(url) {
  const hit = state.infoCache.get(url);
  if (hit && Date.now() - hit.ts < INFO_CACHE_TTL_MS) return hit.info;

  if (state.activeQueries >= MAX_WEB_QUERIES) throw new Error('伺服器忙碌中，請稍後再試');
  state.activeQueries++;
  try {
    const info = await getInfo(url);
    if (state.infoCache.size >= INFO_CACHE_MAX) state.infoCache.delete(state.infoCache.keys().next().value);
    state.infoCache.set(url, { info, ts: Date.now() });
    return info;
  } finally {
    state.activeQueries--;
  }
}

module.exports = { getInfo, getInfoCached };
