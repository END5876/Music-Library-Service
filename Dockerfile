# bgutil PO Token 自動產生器（server 與 plugin 版本需一致）
# 升級版本時要一併更新下面兩個 SHA-256（sha256sum 下載後的 tar.gz 與 zip）
ARG BGUTIL_VERSION=2.0.2
ARG BGUTIL_SRC_SHA256=1f2ae9ec39405b8e80397dfc2551f58deed09d8dff4b2b8fbc314df8e091c0a1
ARG BGUTIL_PLUGIN_SHA256=a26b980bf6d8e8400d8f21445daa4d8381bf6183d20f0be309391f86b31e27ef

# ── 建置 bgutil server（需要 TypeScript 編譯與 canvas 原生模組，在完整映像裡做）──
FROM node:22 AS bgutil
ARG BGUTIL_VERSION
ARG BGUTIL_SRC_SHA256
ARG BGUTIL_PLUGIN_SHA256
WORKDIR /build
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz \
      -o /tmp/bgutil-src.tar.gz && \
    echo "${BGUTIL_SRC_SHA256}  /tmp/bgutil-src.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/bgutil-src.tar.gz --strip-components=1 && \
    cd server && npm ci --no-audit --no-fund && npx tsc && npm prune --omit=dev && \
    curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip \
      -o /build/bgutil-ytdlp-pot-provider.zip && \
    echo "${BGUTIL_PLUGIN_SHA256}  /build/bgutil-ytdlp-pot-provider.zip" | sha256sum -c -

FROM node:22-slim

ENV NODE_ENV=production
# yt-dlp 放在 node 使用者可寫的資料夾：服務以 node 身分執行，自動更新（yt-dlp -U）要能取代執行檔
ENV PATH=/opt/yt-dlp:$PATH

# 安裝 ffmpeg、python3(yt-dlp 執行需要)、curl、tini(PID 1：轉送訊號並回收孤兒子行程)、gosu(啟動時降權成 node)
# yt-dlp 用官方發布的 SHA2-256SUMS 檢查下載內容
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg python3 curl ca-certificates tini gosu && \
    mkdir -p /opt/yt-dlp && cd /opt/yt-dlp && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS \
      | grep -E ' yt-dlp$' | sha256sum -c - && \
    chmod a+rx yt-dlp && chown -R node:node /opt/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# bgutil server 由 ytdlp/potProvider.js 啟動；plugin 放在 yt-dlp 的系統 plugin 資料夾
COPY --from=bgutil --chown=node:node /build/server /opt/bgutil/server
COPY --from=bgutil /build/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .
# Windows 上 checkout 成 CRLF 時也能執行（.gitattributes 已指定 LF，這裡再保險一次）
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod 755 /app/docker-entrypoint.sh && \
    mkdir -p /app/data && chown node:node /app/data

EXPOSE 4100

# node 當 PID 1 不會回收孫行程（例如 yt-dlp 被砍後留下的 ffmpeg），交給 tini 處理；
# entrypoint 把資料夾交給 node 使用者後降權執行（見 docker-entrypoint.sh）
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
