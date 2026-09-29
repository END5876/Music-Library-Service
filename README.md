# music-library-service

多個 Discord Bot（例如 [Mousebot](https://github.com/END5876/Mousebot)）共用同一份已下載／處理好的音樂庫的獨立服務。

不含任何 Discord 邏輯，只做一件事：掛著唯一一顆音樂庫 Volume，透過
內部 HTTP API 讓各個 Bot 讀取／寫入同一份檔案，取代每個 Bot 各自維護
一份 `data/music`。

## API

所有 `/api/music/*` 路由都需要帶 `x-music-lib-key: <MUSIC_LIB_SECRET>`
header（未設定 `MUSIC_LIB_SECRET` 時不驗證，僅建議在完全信任的內網
環境這樣用）。`filename` 一律是相對於音樂庫根目錄的路徑，用 `/` 分隔
（例如 `cache/歌名 [BVxxxx].mp3`）。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查，不驗證金鑰 |
| GET | `/api/music/list` | 列出整個音樂庫 |
| GET | `/api/music/exists?filename=` | 檢查指定檔案是否存在 |
| GET | `/api/music/file/*` | 下載檔案 |
| PUT | `/api/music/file/*` | 上傳／覆寫檔案（原始位元組 body） |

這個服務刻意不提供播放次數功能：每個呼叫端 Bot 各自計算、各自
記錄自己的播放次數，不透過這裡同步或集中管理。

## 網頁播放器

設定環境變數 `WEB_PLAYER_PASSWORD` 後，服務會多出一個瀏覽器可用的
串流播放器（不設定則完全不啟用，行為跟以前一樣）：

- 開啟 `https://<你的公開網域>/player`，輸入密碼登入。
- 支援搜尋、資料夾篩選、上一首／下一首、隨機、循環（全部／單曲／不循環）、
  拖曳進度（HTTP Range）、鍵盤快速鍵（空白＝播放／暫停，N／P＝下一首／上一首，
  S＝隨機，R＝循環，←／→＝快退／快進 10 秒），也支援手機鎖定畫面的媒體控制。
- 登入後由 HttpOnly Cookie 維持（預設 7 天，`WEB_SESSION_HOURS` 可調）；
  登入失敗每個 IP 10 分鐘內最多 10 次。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/player` | 播放器頁面（純靜態） |
| POST | `/web/login` | `{ "password": "..." }`，成功後設定 Cookie |
| POST | `/web/logout` | 清除 Cookie |
| GET | `/web/api/list` | 曲目清單（需登入） |
| GET | `/web/stream/*` | 串流音檔，支援 Range（需登入） |

> 瀏覽器需要連得到這個服務，所以要在 Zeabur 幫**這個服務**綁一個公開網域。
> Bot 之間的內部呼叫仍可走 Private Networking；公開之後請務必同時設定
> `MUSIC_LIB_SECRET`，否則 `/api/music/*` 會對公網完全開放讀寫。

## 本機開發

```bash
cp .env.example .env
# 編輯 .env，至少改掉 MUSIC_LIB_SECRET
npm install
npm start
```

## 部署到 Zeabur

建議跟呼叫端 Bot 放在**同一個 Zeabur Project**，這樣 Bot 可以直接用
Private Networking（`<服務名稱>.zeabur.internal`）呼叫這裡，不用把
這個服務曝露到公網。

1. 在 Zeabur 建一個新服務，指向這個 repo。
2. 掛一顆 Volume 到 `MUSIC_DIR`（環境變數不設的話預設是
   `/app/data/music`）。
3. 設定環境變數 `MUSIC_LIB_SECRET`（自己挑一組長字串），視需要調整
   `MAX_CACHE_SIZE_MB`。
4. 部署完成後，記下這個服務的內部網域＋Port，給要呼叫的 Bot 服務
   設定 `MUSIC_LIB_URL=http://<這裡的內部網域>:<port>` 與同一組
   `MUSIC_LIB_SECRET`。

## 從既有音樂庫搬資料

如果你原本已經有一份跑在其他服務 Volume 裡的音樂庫，最保險的搬法是
在**原本那個還掛著舊 Volume 的服務**上，設定好指向這個新服務的
`MUSIC_LIB_URL` / `MUSIC_LIB_SECRET`，執行呼叫端 repo（例如 Mousebot）
裡的一次性遷移腳本（`scripts/migrate-music-library.js`），把資料
透過這裡的上傳 API 搬過來。可重複執行，已存在且大小相同的檔案會
自動略過。
