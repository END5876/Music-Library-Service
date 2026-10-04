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

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4100

CMD ["node", "server.js"]
