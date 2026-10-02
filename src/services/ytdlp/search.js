'use strict';
// ytdlp/search.js — 搜尋 YouTube / Bilibili（同 Bot）
const { spawn } = require('child_process');
const antiBot = require('./antiBot');
const state = require('./state');
const { formatDuration, isAllowedUrl } = require('../../utils/urlUtils');
const { ytdlpPath, SEARCH_TIMEOUT_MS_YT, SEARCH_TIMEOUT_MS_BILI, MAX_WEB_QUERIES } = require('./constants');

function _searchOnePlatform(searchPrefix, keyword, limit, fast = false) {
  return new Promise((resolve) => {
    const query = `${searchPrefix}${limit}:${keyword}`;
    const isYT  = searchPrefix === 'ytsearch';

    const args = [
      '--dump-json',
      '--no-warnings',
      '--socket-timeout', '10',
    ];

    if (isYT) {
      args.push('--flat-playlist');
      args.push(...antiBot.buildYouTubeSearchArgs());
    } else {
      if (fast) args.push('--flat-playlist');
      args.push(...antiBot.buildBilibiliSearchArgs());
    }

    args.push(query);

    const timeoutMs = isYT ? SEARCH_TIMEOUT_MS_YT : SEARCH_TIMEOUT_MS_BILI;
    const ytdlp = spawn(ytdlpPath, args, { windowsHide: true });
    let data = '', errorData = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      console.warn(`⚠️ [Search] ${searchPrefix} 搜尋逾時（超過 ${timeoutMs / 1000}s），強制終止`);
      try { ytdlp.kill('SIGKILL'); } catch {}
      resolve([]);
    }, timeoutMs);

    ytdlp.stdout.on('data', c => { data      += c.toString(); });
    ytdlp.stderr.on('data', c => { errorData += c.toString(); });

    ytdlp.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (code !== 0 || !data.trim()) {
        const classified = isYT
          ? antiBot.classifyYouTubeError(errorData)
          : antiBot.classifyBilibiliError(errorData);
        console.warn(`⚠️ [Search] ${searchPrefix} 搜尋失敗 (code=${code}): ${classified.msg}`);
        resolve([]);
        return;
      }

      const lines = data.trim().split('\n').filter(Boolean);
      const results = [];

      for (const line of lines) {
        try {
          const info = JSON.parse(line);

          const url = info.webpage_url
            || info.url
            || (isYT  && info.id ? `https://www.youtube.com/watch?v=${info.id}` : null)
            || (!isYT && info.id ? `https://www.bilibili.com/video/${info.id}`   : null);

          if (!url) continue;

          const thumb = info.thumbnail
            || (Array.isArray(info.thumbnails) && info.thumbnails.length
                  ? info.thumbnails[info.thumbnails.length - 1].url
                  : null);

          results.push({
            platform : isYT ? 'YouTube' : 'Bilibili',
            title    : info.title    || '未知標題',
            author   : info.uploader || info.channel || info.creator || '未知作者',
            duration : formatDuration(info.duration),
            url,
            thumbnail: thumb,
          });
        } catch {
          // 忽略單行解析錯誤，不影響其他結果
        }
      }
      resolve(results);
    });

    ytdlp.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.warn(`⚠️ [Search] ${searchPrefix} 執行 yt-dlp 失敗: ${err.message}`);
      resolve([]);
    });
  });
}

// searchMulti — 同時搜尋 YouTube + Bilibili（同 Bot）
async function searchMulti(keyword, limit = 5, fast = false, platforms = ['youtube', 'bilibili']) {
  if (state.activeQueries >= MAX_WEB_QUERIES) throw new Error('伺服器忙碌中，請稍後再試');
  state.activeQueries++;
  try {
    const tasks = [
      platforms.includes('youtube')
        ? _searchOnePlatform('ytsearch', keyword, limit, fast)
        : Promise.resolve([]),
      platforms.includes('bilibili')
        ? _searchOnePlatform('bilisearch', keyword, limit, fast)
        : Promise.resolve([]),
    ];
    const [ytResults, biliResults] = await Promise.all(tasks);
    return [...ytResults, ...biliResults].filter(r => isAllowedUrl(r.url));
  } finally {
    state.activeQueries--;
  }
}

module.exports = { searchMulti };
