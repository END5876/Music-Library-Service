'use strict';
// ytdlp/process.js — 子行程（yt-dlp / ffmpeg）清理

function cleanupProcess(ctx) {
  const procs = ctx.procs;
  if (!procs) return;
  ctx.procs = null; // 先解除關聯，讓舊進程的 close/data 事件全部失效
  console.log('🧹 清理舊的 yt-dlp 進程');
  for (const [proc, force] of [[procs.ytdlp, true], [procs.ffmpeg, false]]) {
    if (!proc || proc.killed) continue;
    try {
      proc.kill(force ? 'SIGTERM' : 'SIGKILL');
      if (force) setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch {} }, 1000);
    } catch {}
  }
}

module.exports = { cleanupProcess };
