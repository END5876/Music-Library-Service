// ytdlp/procTree.js
// 子行程「整棵」管理：yt-dlp 在 --extract-audio 等情況會自己再開 ffmpeg，
// 只砍 yt-dlp 的話，孫行程 ffmpeg 會變成孤兒繼續跑（還會繼續寫暫存檔）。
//
//   spawnTree()  非 Windows 時用 detached 讓子行程自成一個 process group
//   killTree()   對整個 process group 送訊號（Windows 退回只砍子行程本身）
//   isAlive()    子行程是否還在跑（不能用 proc.killed：訊號一送出它就是 true，行程其實可能還活著）

const { spawn } = require('child_process');

const USE_GROUP = process.platform !== 'win32';

function spawnTree(cmd, args, opts = {}) {
  return spawn(cmd, args, { ...opts, detached: USE_GROUP });
}

function isAlive(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode === null;
}

function killTree(proc, signal = 'SIGTERM') {
  if (!isAlive(proc)) return;
  if (USE_GROUP && proc.pid) {
    try { process.kill(-proc.pid, signal); return; } catch {}
  }
  try { proc.kill(signal); } catch {}
}

module.exports = { spawnTree, isAlive, killTree };
