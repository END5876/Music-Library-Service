# music-library-service

多個 Discord Bot（例如 [Mousebot](https://github.com/END5876/Mousebot)）共用同一份已下載／處理好的音樂庫的獨立服務。

不含任何 Discord 邏輯，只做一件事：掛著唯一一顆音樂庫 Volume，透過
內部 HTTP API 讓各個 Bot 讀取／寫入同一份檔案，取代每個 Bot 各自維護
一份 `data/music`。

## API

所有 `/api/music/*` 路由都需要帶 `x-music-lib-key: <MUSIC_LIB_SECRET>`
header（未設定 `MUSIC_LIB_SECRET` 時不驗證，僅建議在完全信任的內網
環境這樣用）。`filename` 一律是相對於音樂庫根目錄的路徑，用 `/` 分隔
（例如 `favorites/歌名.mp3`；自動下載的快取檔直接放在根目錄）。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查，不驗證金鑰 |
| GET | `/api/music/list` | 列出整個音樂庫 |
| GET | `/api/music/exists?filename=` | 檢查指定檔案是否存在 |
| GET | `/api/music/file/*` | 下載檔案 |
| PUT | `/api/music/file/*` | 上傳／覆寫檔案（原始位元組 body；僅限音訊副檔名，單檔上限 `MAX_UPLOAD_MB`，預設 512） |

這個服務刻意不提供播放次數功能：每個呼叫端 Bot 各自計算、各自
記錄自己的播放次數，不透過這裡同步或集中管理。

## 網頁播放器

設定環境變數 `WEB_PLAYER_PASSWORD` 後，服務會多出一個瀏覽器可用的
串流播放器（不設定則完全不啟用，行為跟以前一樣）。播放器也支援漸進式網頁應用程式（PWA）：透過 HTTPS 或本機 `localhost` 開啟 `/player` 後，可使用瀏覽器的「安裝」功能加入桌面／主畫面，並以獨立視窗啟動。iOS／iPadOS 可使用 Safari 的「加入主畫面」。

- 開啟 `https://<你的公開網域>/player`，輸入密碼登入。
- 支援搜尋、資料夾篩選、上一首／下一首、隨機、循環（全部／單曲／不循環）、
  拖曳進度（HTTP Range）、鍵盤快速鍵（空白＝播放／暫停，N／P＝下一首／上一首，
  S＝隨機，R＝循環，←／→＝快退／快進 10 秒），也支援手機鎖定畫面的媒體控制。
- 登入後由 HttpOnly Cookie 維持（預設 7 天，`WEB_SESSION_HOURS` 可調）；
  登入失敗每個 IP 10 分鐘內最多 10 次。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/player` | 播放器頁面（純靜態） |
| GET | `/manifest.webmanifest` | PWA 安裝資訊（名稱、色彩、啟動頁、圖示） |
| GET | `/player-sw.js` | PWA Service Worker（離線殼層與已登入資料快取） |
| POST | `/web/login` | `{ "password": "..." }`，成功後設定 Cookie |
| POST | `/web/logout` | 清除 Cookie |
| GET | `/web/api/list` | 曲目清單（需登入） |
| GET | `/web/stream/*` | 串流音檔，支援 Range（需登入） |
| GET | `/web/api/capabilities` | `{ online }`：伺服器是否可線上串流 |
| GET | `/web/api/search?q=` | 搜尋 YouTube + Bilibili |
| GET | `/web/api/info?url=` | 取得影片資訊（標題、時長） |
| GET | `/web/play?url=` | 線上播放（快取命中＝檔案；否則即時串流＋背景下載） |

### 線上串流（YouTube / Bilibili，yt-dlp）

網頁播放器上的 **🌐 線上** 按鈕：搜尋（YouTube + Bilibili）或直接貼影片網址，點歌即播，
可以「＋」加入佇列（佇列優先於音樂庫的下一首，行為同 Bot）。

播放流程移植自 Mousebot 的 `onlineMusicHandler.js`，邏輯與常數相同：

1. 先查快取（`<MUSIC_DIR>` 根目錄第一層，檔名格式與 Bot 相同，所以 Bot 與網頁的快取互相命中）。
   命中 → 直接播放檔案（可拖曳進度）。
2. 未命中 → yt-dlp 即時串流（YouTube 沿用 client 輪換策略：default → mweb+po → tv → tv_simply → web_embedded）。
3. 影片 ≤ 7 分鐘 → 同時背景下載快取，完成後自動響度正規化（loudnorm，-16 LUFS）；
   > 7 分鐘、直播或未知長度 → 只串流不下載。同一網址不會重複下載。
4. 串流出錯 → 連續錯誤計數（上限 5）＋最多重試 3 次（間隔 3 秒）。

和 Bot 不同的地方：

- 即時串流的資料會經 ffmpeg 轉成 mp3 再送給瀏覽器（Bot 是交給 Discord 語音）。
  所以**第一次播放（未快取）時沒有總長度、不能拖曳進度**；下載完成後再播就是檔案，可以拖曳。
- 這個服務本身就是共用音樂庫，下載＋正規化完的檔案已在庫內，沒有「上傳到共用音樂庫」那一步。
- 只允許 YouTube / Bilibili 網域（其他網址一律 400），並限制同時串流／搜尋數量。
- 目前不支援播放清單網址（只播單支影片）。

**伺服器需要安裝 `yt-dlp` 和 `ffmpeg`**，沒裝的話線上功能自動停用，音樂庫播放不受影響。
Dockerfile 範例（Debian／Ubuntu 系映像）：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
```

YouTube 需要的環境變數（`WARP_PROXY_URL`、`YOUTUBE_PO_TOKEN`、cookies 檔等）和 Bot 相同，見 `.env.example`。

> 瀏覽器需要連得到這個服務，所以要在幫**這個服務**綁一個公開網域。
> Bot 之間的內部呼叫仍可走 Private Networking；公開之後請務必同時設定
> `MUSIC_LIB_SECRET`，否則 `/api/music/*` 會對公網完全開放讀寫。

### 播放清單與離線下載

網頁播放器的 **播放清單** 分頁（登入後可用）：

- 建立／重新命名／刪除播放清單；音樂庫與線上搜尋的每首歌旁有「加入播放清單」圖示（全螢幕播放頁右上角也有，加入目前這首）。
- 清單內可移除歌曲、拖曳排序、▶ 播放／🔀 隨機播放（會依「隨機」「循環」按鈕的設定續播）。
- 播放清單存在伺服器（`PLAYLISTS_FILE`，預設 `<MUSIC_DIR>/.web/playlists.json`），所有裝置共用；音樂庫與線上歌曲都可以放進同一份清單。
- **離線下載**：每首歌旁的 ⬇ 可單曲下載，清單頁的「⬇ 下載離線」一鍵下載整份清單（同時最多 2 首，可取消）。檔案存在這個瀏覽器的 IndexedDB，不經過伺服器；已下載的歌曲前面會有 ✓，播放時優先使用離線檔（可拖曳進度）。Service Worker 會預快取播放器頁面、樣式、程式、PWA Manifest 與圖示；登入成功的曲目清單／播放清單採網路優先並於離線時回退至快取。登出會清除這些清單快取，但不會刪除使用者主動下載的離線曲目。正式部署需要 HTTPS。
- 線上（YouTube / Bilibili）歌曲的離線下載走 `/web/play`：已快取就是直接傳檔案，未快取則是 ffmpeg 即時轉出的 mp3。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET / POST | `/web/api/playlists` | 全部清單／建立 `{ name, items? }` |
| PATCH / DELETE | `/web/api/playlists/:id` | 重新命名 `{ name }`／刪除 |
| POST | `/web/api/playlists/:id/items` | 加入歌曲 `{ items:[{kind:'lib',filename}\|{kind:'online',url,...}] }`（重複的略過） |
| DELETE | `/web/api/playlists/:id/items/:itemId` | 移除歌曲 |
| PUT | `/web/api/playlists/:id/order` | 排序 `{ order:[itemId...] }` |
| GET | `/player-sw.js` | Service Worker |

## 本機開發

```bash
cp .env.example .env
# 編輯 .env，至少改掉 MUSIC_LIB_SECRET
npm install
npm start
```

## 部署 

建議跟呼叫端 Bot 放在**同一個Project**，這樣 Bot 可以直接用
Private Networking（`<服務名稱>.internal`）呼叫這裡，不用把
這個服務曝露到公網。

1. 建一個新服務，指向這個 repo。
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
