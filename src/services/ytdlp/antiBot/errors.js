'use strict';
// antiBot/errors.js — yt-dlp 錯誤輸出分類

function classifyYouTubeError(errorOutput) {
  if (errorOutput.includes('Sign in to confirm') || errorOutput.includes('not a bot')) {
    return { type: 'BOT_DETECTED',   rotate: true,  msg: 'YouTube 偵測到機器人請求，嘗試切換 client' };
  }
  if (errorOutput.includes('403')) {
    return { type: 'FORBIDDEN_403',  rotate: true,  msg: '403 禁止存取（可能需要 PO Token 或 Cookie）' };
  }
  if (errorOutput.includes('429')) {
    return { type: 'RATE_LIMITED',   rotate: false, msg: '請求頻率過高 (429)，稍後重試' };
  }
  if (errorOutput.includes('Private video') || errorOutput.includes('private video')) {
    return { type: 'PRIVATE',        rotate: false, msg: '私人影片，無法播放' };
  }
  if (errorOutput.includes('Video unavailable') || errorOutput.includes('not available')) {
    return { type: 'UNAVAILABLE',    rotate: false, msg: '影片不可用（可能有地區限制）' };
  }
  if (errorOutput.includes('410') || errorOutput.includes('removed')) {
    return { type: 'REMOVED',        rotate: false, msg: '影片已被刪除' };
  }
  return   { type: 'UNKNOWN',        rotate: true,  msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

function classifyBilibiliError(errorOutput) {
  if (errorOutput.includes('412')) return { msg: 'Bilibili 反爬蟲限制 (412)' };
  if (errorOutput.includes('403')) return { msg: '影片無法訪問 (403)，可能有地區限制或需要大會員' };
  if (errorOutput.includes('404')) return { msg: '找不到影片 (404)' };
  return { msg: `未知錯誤: ${errorOutput.slice(-150)}` };
}

module.exports = { classifyYouTubeError, classifyBilibiliError };
