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
| GET | `/api/music/list` | 列出整個音樂庫（回應帶 `ETag`；帶 `If-None-Match` 且清單沒變時回 `304`，適合 Bot 定期輪詢） |
| GET | `/api/music/exists?filename=` | 檢查指定檔案是否存在 |
| GET | `/api/music/file/*` | 下載檔案 |
| PUT | `/api/music/file/*` | 上傳／覆寫檔案（原始位元組 body；僅限音訊副檔名，單檔上限 `MAX_UPLOAD_MB`，預設 512） |
| GET | `/api/music/status` | 服務狀態（見下方「服務狀態與記錄」） |
| PUT | `/api/music/bots/:botId/state` | Bot 推送「正在播放」（見下方「Bot 正在播放」） |
| GET | `/api/music/bots/:botId/commands?wait=25` | Bot 長輪詢拿網頁送來的控制指令 |
| POST | `/api/music/bots/:botId/commands/:id/result` | Bot 回報指令執行結果 |

> 🔒 有設定 `WEB_PLAYER_PASSWORD`（代表服務有公開網域）卻沒設 `MUSIC_LIB_SECRET` 時，
> `/api/music/*` 預設**停用**（一律回 `503`），避免整個音樂庫對公網開放讀寫。
> 確定要在沒有金鑰的情況下開放，才設定 `ALLOW_INSECURE_LIBRARY_API=1`。
> 沒啟用網頁播放器（純內網部署）時維持原本行為：沒設金鑰就不驗證。

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
| GET | `/upload?upload=1` | 受控的音檔上傳頁（需登入；未帶正確參數時不提供） |
| POST | `/web/api/upload?upload=1` | 上傳、轉為 MP3、響度正規化後儲存（需登入） |
| GET | `/web/api/capabilities` | `{ online }`：伺服器是否可線上串流 |
| GET | `/web/api/search?q=` | 搜尋 YouTube + Bilibili |
| GET | `/web/api/info?url=` | 取得影片資訊（標題、時長） |
| GET | `/web/play?url=` | 線上播放（快取命中＝檔案；否則即時串流＋背景下載）；`&fmt=webm` 見下方 |
| POST | `/web/api/library/move` | `{ from, to }` 移動／重新命名（`to` 可省略副檔名；播放清單跟著改路徑） |
| DELETE | `/web/api/library/file/*` | 從音樂庫刪除檔案 |
| GET | `/web/api/status` | 服務狀態（需登入，內容同 `/api/music/status`） |
| GET | `/web/api/bots` | 各 Bot、各伺服器的播放狀態 |
| GET | `/web/api/bots/events` | SSE：Bot 狀態有變就推送（`event: state`） |
| POST | `/web/api/bots/:botId/command` | 遠端控制 Bot（含批量點歌 `enqueueMany`，最多 500 首），等 Bot 回報結果 `{ ok, message }` |

### Bot 正在播放（Bot ↔ 網頁同步）

播放器的 **Bot 正在播放** 頁籤即時顯示各 Bot、各伺服器正在播的歌、播放進度、循環模式與佇列，並可以：

- 跳過、停止、切換循環（不循環／單曲／列表）、隨機連播、清空佇列、移除佇列中的某首。
- 在音樂庫、播放清單歌曲的「⋮」選單，或線上搜尋結果的 Bot 圖示選「**點給 Bot 播放**」，挑一個 Bot 所在的伺服器送過去
  （可勾選「下一首播放」插到佇列最前面）。只有 Bot 目前在語音頻道裡的伺服器可以點歌（autojoin 進去待命的也可以）。
- **批量點歌**：音樂庫或播放清單內頁按「多選」選好後按「點給 Bot」，或在播放清單的「⋯」選單選「整份點給 Bot」。
  一次最多 500 首，依畫面上的順序加入；勾「下一首播放」會整批插到 Bot 佇列最前面。已從音樂庫刪除、或這台 Bot 清單裡還沒有的歌會略過並告訴你幾首。
  批量加入的線上歌曲直接用播放清單裡存的標題／長度，Bot 不逐首查影片資訊（同 `/play` 匯入播放清單，避免觸發平台反爬蟲），輪到播放時才取得完整資訊。
- 每個網頁操作都會在該伺服器最近點歌的文字頻道留一行「🌐 網頁播放器：…」紀錄（Bot 端 `WEB_SYNC_ANNOUNCE=0` 可關閉）。

運作方式：連線方向只有「Bot → 這個服務」，Bot 不需要對外開 port，沿用 `MUSIC_LIB_URL` 與 `MUSIC_LIB_SECRET`。

- Bot 在播放、佇列、循環模式變動時推送整份狀態，另外每 30 秒心跳一次；超過 90 秒沒消息就顯示為離線。
- Bot 用長輪詢（每次最多等 25 秒）拿網頁送來的指令，執行完回報結果，網頁最多等 20 秒；
  沒被拿走的指令 30 秒後丟棄。
- 網頁只在這個頁籤開著時連 SSE；狀態只存在記憶體，服務重啟後 Bot 下一次推送就會補回來。
- Bot 端實作在 Mousebot／Mousebot-lite 的 `handlers/musicplayer/unifiedQueue/webSync.js`（兩邊相同），
  有設 `MUSIC_LIB_URL` 就自動啟用，`WEB_SYNC=0` 可關閉。

### 收藏、重新命名、刪除

音樂庫每首歌的「⋮」選單可以：

- **收藏（移到資料夾）**：根目錄的歌是快取，空間不夠時會被清掉；移進子資料夾（預設 `favorites`）就會長期保存。
- **重新命名**、**移到其他資料夾**、**從音樂庫刪除**（會先確認，刪除後所有裝置與 Bot 都無法再播放）。

移動或改名後，伺服器上所有播放清單指向舊路徑的項目會一起更新；這個瀏覽器的佇列、播放歷史與離線檔也會跟著改。

### 受控音檔上傳

在已設定 `WEB_PLAYER_PASSWORD` 的前提下，開啟 `https://<你的公開網域>/upload?upload=1` 並登入，即可上傳 MP3、WAV、OGG、FLAC、M4A 或 AAC 音檔。未帶 `?upload=1`、值不是 `1` 或未登入時，頁面與上傳 API 都不會提供服務。

上傳檔案會先寫入不會列出的暫存檔，再由 ffmpeg 轉為高品質 MP3（LAME VBR `-q:a 2`），接著沿用 `ytdlp/musicNormalizer.js` 的雙通道 EBU R128 loudnorm 處理（`-16 LUFS`、`LRA 20`、`TP -2.0`）。只有壓縮與正規化都成功後才會以原子化重新命名方式發布至音樂庫；若失敗，既有同名曲目不會被覆寫。

「儲存資料夾」留空時存到音樂庫根目錄（`MUSIC_DIR`），也可於頁面中指定子資料夾與曲名；單檔大小遵循 `MAX_UPLOAD_MB`（預設 `512`）。

> ⚠️ 根目錄第一層的音檔會被視為快取，總量超過 `MAX_CACHE_SIZE_MB` 時會**從最久沒播放的開始**自動刪除
> （LRU：網頁播放或 Bot 下載快取檔時會更新檔案的存取時間 atime，不動修改時間）。要長期保存的歌請填寫資料夾（例如 `uploads`），
> 或事後在播放器用「收藏」移進資料夾；子資料夾內的檔案不會被清理。

### 線上串流（YouTube / Bilibili，yt-dlp）

網頁播放器上的 **🌐 線上** 按鈕：搜尋（YouTube + Bilibili）或直接貼影片網址，點歌即播，
可以「＋」加入佇列（佇列優先於音樂庫的下一首，行為同 Bot）。

播放流程移植自 Mousebot 的 `onlineMusicHandler.js`，邏輯與常數相同：

1. 先查快取（`<MUSIC_DIR>` 根目錄第一層，檔名格式與 Bot 相同，所以 Bot 與網頁的快取互相命中）。
   命中 → 直接播放檔案（可拖曳進度）。網頁版會先用網址裡的影片 ID 找快取檔，命中時連取得影片資訊的 yt-dlp 都不跑。
2. 未命中 → yt-dlp 即時串流（YouTube 沿用 client 輪換策略：default → mweb+po → tv → tv_simply → web_embedded）。
3. 影片 ≤ 7 分鐘 → 同時背景下載快取，完成後自動響度正規化（loudnorm，-16 LUFS）；
   > 7 分鐘、直播或未知長度 → 只串流不下載。同一網址不會重複下載。
4. 串流出錯 → 連續錯誤計數（上限 5，每個網址各自計算）＋最多重試 3 次（間隔 3 秒）。

和 Bot 不同的地方：

- 即時串流的資料會經 ffmpeg 處理後再送給瀏覽器（Bot 是交給 Discord 語音）：
  - 瀏覽器支援 WebM/Opus（Chrome、Edge、Firefox、Android）且是 YouTube → 前端帶 `&fmt=webm`，
    yt-dlp 優先挑 Opus 音軌、ffmpeg **只換封裝不重新編碼**（省 CPU、少一次有損壓縮）。
    拿到的音軌放不進 WebM 時會自動改回轉 mp3，不算錯誤。
  - 其他情況（Safari／iOS、Bilibili、離線下載）→ 轉成 mp3 192k。
  所以**第一次播放（未快取）時沒有總長度、不能拖曳進度**；下載完成後再播就是檔案，可以拖曳。
- 這個服務本身就是共用音樂庫，下載＋正規化完的檔案已在庫內，沒有「上傳到共用音樂庫」那一步。
- 只允許 YouTube / Bilibili 網域（其他網址一律 400），並限制同時串流／搜尋數量。
- 目前不支援播放清單網址（只播單支影片）。

**伺服器需要安裝 `yt-dlp` 和 `ffmpeg`**，沒裝的話線上功能自動停用，音樂庫播放不受影響。
專案的 [Dockerfile](Dockerfile) 已內建；自行建置其他 Debian／Ubuntu 系映像時可參考（`yt-dlp` 這個版本需要 python3）：

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl tini \
 && curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
```

YouTube 需要的環境變數（`WARP_PROXY_URL`、`YOUTUBE_PO_TOKEN`、cookies 檔等）和 Bot 相同，見 `.env.example`。

#### PO Token 自動產生器（bgutil）

專案的 Dockerfile 內建 [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)：
server 裝在 `/opt/bgutil/server`，由 `ytdlp/potProvider.js` **按需啟動**（只聽 `127.0.0.1:4416`）：
第一次要跑 YouTube 的 yt-dlp 前才啟動，閒置 `POT_IDLE_MINUTES`（預設 15）分鐘後關閉以釋放記憶體，
掛掉的話下次需要時再啟動。yt-dlp plugin 放在 `/etc/yt-dlp/plugins/`。yt-dlp 需要 PO Token 時會自動向它要，
不必再手動更新會過期的 `YOUTUBE_PO_TOKEN`。啟動 log 的「PO Token ✓（bgutil 本機）」代表已啟用。

- 想改用獨立的 bgutil 容器：設 `POT_PROVIDER_URL=http://<host>:4416`。
- 想關閉：設 `POT_PROVIDER=0`。
- 升級時修改 Dockerfile 的 `BGUTIL_VERSION`（server 與 plugin 版本須一致），並建議同時重建映像以更新 yt-dlp。
- PO Token 不能解決以 IP 為準的「Sign in to confirm you're not a bot」；機房 IP 被擋時仍需要 cookies 或 `WARP_PROXY_URL`。

#### yt-dlp 自動更新

YouTube 常在幾週內就讓舊版 yt-dlp 失效，而映像只在建置時下載一次 yt-dlp。所以服務會在啟動 1 分鐘後執行
`yt-dlp -U`，之後每 `YTDLP_UPDATE_HOURS`（預設 24）小時再檢查一次；更新結果與目前版本可在狀態 API 看到。

- 預設只在 `NODE_ENV=production`（Docker 映像）開啟，避免本機開發時改到開發者自己電腦上的 yt-dlp；
  `YTDLP_AUTO_UPDATE=1` 強制開啟、`=0` 關閉。
- 以 pip 等套件管理器安裝的 yt-dlp 不支援 `-U`，會記一次警告後停用自動更新。
- 最近一小時串流失敗達 5 次時 log 會提示：常見原因是 yt-dlp 過舊或 IP 被擋。

> 瀏覽器需要連得到這個服務，所以要在幫**這個服務**綁一個公開網域。
> Bot 之間的內部呼叫仍可走 Private Networking；公開之後請務必同時設定
> `MUSIC_LIB_SECRET`，否則 `/api/music/*` 會對公網完全開放讀寫。

### 播放清單與離線下載

網頁播放器的 **播放清單** 分頁（登入後可用）：

- 建立／重新命名／刪除播放清單；音樂庫與線上搜尋的每首歌旁有「加入播放清單」圖示（全螢幕播放頁右上角也有，加入目前這首）。
- 清單內可移除歌曲、拖曳排序、▶ 播放／🔀 隨機播放（會依「隨機」「循環」按鈕的設定續播）。
- 播放清單存在伺服器（`PLAYLISTS_FILE`，預設 `/app/data/playlists.json`；舊版 `<MUSIC_DIR>/.web/playlists.json` 會在第一次讀取時自動複製過來），所有裝置共用；音樂庫與線上歌曲都可以放進同一份清單。
- **離線下載**：每首歌旁的 ⬇ 可單曲下載，清單頁的「⬇ 下載離線」一鍵下載整份清單（同時最多 2 首，可取消）。檔案存在這個瀏覽器的 IndexedDB，不經過伺服器；已下載的歌曲前面會有 ✓，播放時優先使用離線檔（可拖曳進度）。Service Worker 會預快取播放器頁面、樣式、程式、PWA Manifest 與圖示；登入成功的曲目清單／播放清單採網路優先並於離線時回退至快取。登出會清除這些清單快取，但不會刪除使用者主動下載的離線曲目。正式部署需要 HTTPS。
- 線上（YouTube / Bilibili）歌曲的離線下載走 `/web/play`：已快取就是直接傳檔案，未快取則是 ffmpeg 即時轉出的 mp3（不使用 WebM，存成檔案後才能拖曳進度）。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET / POST | `/web/api/playlists` | 全部清單／建立 `{ name, items? }` |
| PATCH / DELETE | `/web/api/playlists/:id` | 重新命名 `{ name }`／刪除 |
| POST | `/web/api/playlists/:id/items` | 加入歌曲 `{ items:[{kind:'lib',filename}\|{kind:'online',url,...}] }`（重複的略過） |
| DELETE | `/web/api/playlists/:id/items/:itemId` | 移除歌曲 |
| PUT | `/web/api/playlists/:id/order` | 排序 `{ order:[itemId...] }` |
| GET | `/player-sw.js` | Service Worker |

## 服務狀態與記錄

`GET /api/music/status`（帶 `x-music-lib-key`）或 `GET /web/api/status`（網頁登入後）回傳：

```jsonc
{
  "ok": true, "startedAt": "…", "uptimeSec": 3600, "node": "v22.x",
  "memory": { "rssMB": 120, "heapUsedMB": 30 },
  "library": { "files": 812, "totalBytes": 5368709120, "cacheFiles": 300, "cacheBytes": 1610612736, "cacheLimitBytes": 2147483648 },
  "online": {
    "available": true, "activeStreams": 1, "maxStreams": 4,
    "backgroundDownloads": 0, "maxBackgroundDownloads": 2,
    "failuresLastHour": 0, "lastFailure": null,
    "ytdlp": { "enabled": true, "version": "2026.08.19", "lastCheckAt": "…", "lastResult": "up-to-date", "lastError": null },
    "poToken": "local"
  }
}
```

記錄：

- 每行 log 前面會加 ISO 時間；部署平台本身已經會加時間時可設 `LOG_TIMESTAMPS=0`。
- 每個請求有一個短 id（回應標頭 `X-Request-Id`；上游代理有帶合法的 `X-Request-Id` 時沿用）。
  5xx 與超過 3 秒的請求（音檔／串流／上傳這類長時間傳輸除外）會記一行 `[HTTP] <id> <方法> <路徑> <狀態> <毫秒>`，
  未處理的錯誤也會帶上同一個 id，方便對照使用者回報。`LOG_DEBUG=1` 時每個請求都記。

## 本機開發

```bash
cp .env.example .env
# 編輯 .env，至少改掉 MUSIC_LIB_SECRET
npm install
npm start
npm test        # node --test
npm run lint    # ESLint
```

GitHub Actions（`.github/workflows/ci.yml`）在每次 push／PR 時跑 lint 與測試，並建置 Docker 映像做冒煙測試；
每週一也會自動重建一次，確認上游 yt-dlp／bgutil 更新後映像仍可建置。

前端在 `public/`，都是不需打包的一般 `<script>`：`player.js` 是核心（佇列、播放、清單共用同一組閉包狀態），
其餘拆成 `playerUi.js`（提示訊息、返回鍵層級、對話框）、`playerDebug.js`（`?debug=1` 除錯面板）、
`playerPlatform.js`（Android 判斷與靜音保活）、`playerGestures.js`（手機手勢）、`downloader.js`、`offlineStore.js`，
彼此透過 `window.ML*` 取用。新增前端檔案時，`player.html` 的 `<script>` 順序與 `sw.js` 的 `SHELL_URLS` 都要列出，並把 `sw.js` 的 `VERSION` 加一。

## 部署 

建議跟呼叫端 Bot 放在**同一個Project**，這樣 Bot 可以直接用
Private Networking（`<服務名稱>.internal`）呼叫這裡，不用把
這個服務曝露到公網。

1. 建一個新服務，指向這個 repo。
2. 掛一顆 Volume 到 `/app/data`。音樂庫在 `/app/data/music`（`MUSIC_DIR`），
   播放清單（`playlists.json`）與 cookies（`cookies.txt`、`www.youtube.com_cookies.txt`）
   直接放在 `/app/data`，重新部署都不會消失。
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
