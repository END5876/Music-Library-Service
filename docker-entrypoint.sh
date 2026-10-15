#!/bin/sh
# docker-entrypoint.sh
# 以 root 啟動時：把服務會寫入的資料夾交給 node 使用者，再降權執行（ffmpeg / yt-dlp 會處理不可信的媒體檔，
# 不該以 root 身分跑）。舊版映像以 root 執行，Volume 裡既有的檔案是 root 擁有，所以每次啟動都檢查一次；
# 只改「不是 node 擁有」的項目，曲目多時第二次之後幾乎不花時間。
# 已經用 --user 指定非 root 身分啟動時，直接執行。
set -e

if [ "$(id -u)" = "0" ]; then
  for d in /app/data \
           "${MUSIC_DIR:-}" \
           "${YTDLP_COOKIES_DIR:-}" \
           "$(dirname "${PLAYLISTS_FILE:-/app/data/x}")" \
           "$(dirname "${DURATIONS_FILE:-/app/data/x}")" \
           "$(dirname "${WEB_SESSION_SECRET_FILE:-/app/data/x}")"; do
    [ -n "$d" ] || continue
    mkdir -p "$d" 2>/dev/null || true
    find "$d" -xdev ! -user node -exec chown node:node {} + 2>/dev/null || true
  done
  exec gosu node "$@"
fi

exec "$@"
