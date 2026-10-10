# bgutil PO Token 自動產生器（server 與 plugin 版本需一致）
ARG BGUTIL_VERSION=2.0.2

# ── 建置 bgutil server（需要 TypeScript 編譯與 canvas 原生模組，在完整映像裡做）──
FROM node:22 AS bgutil
ARG BGUTIL_VERSION
WORKDIR /build
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz \
      | tar xz --strip-components=1 && \
    cd server && npm ci --no-audit --no-fund && npx tsc && npm prune --omit=dev && \
    curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip \
      -o /build/bgutil-ytdlp-pot-provider.zip

FROM node:22-slim

ENV NODE_ENV=production

# 安裝 ffmpeg、python3(yt-dlp 執行需要)、curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg python3 curl ca-certificates && \
    curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# bgutil server 由 ytdlp/potProvider.js 啟動；plugin 放在 yt-dlp 的系統 plugin 資料夾
COPY --from=bgutil /build/server /opt/bgutil/server
COPY --from=bgutil /build/bgutil-ytdlp-pot-provider.zip /etc/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4100

CMD ["node", "server.js"]
