# music-library-service

多個 Discord Bot（例如 [Mousebot](https://github.com/END5876/Mousebot)）共用同一份已下載／處理好的音樂庫的獨立服務。

不含任何 Discord 邏輯，只做一件事：掛著唯一一顆音樂庫 Volume，透過
內部 HTTP API 讓各個 Bot 讀取／寫入同一份檔案，取代每個 Bot 各自維護
一份 `data/music`。

## API

所有 `/api/music/*` 路由都需要帶 `x-music-lib-key: <MUSIC_LIB_SECRET>`
header（未設定 `MUSIC_LIB_SECRET` 時預設停用，見下方說明）。`filename` 一律是相對於音樂庫根目錄的路徑，用 `/` 分隔
（例如 `favorites/歌名.mp3`；自動下載的快取檔直接放在根目錄）。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查，不驗證金鑰。音樂庫資料夾讀不到，或正式環境（`NODE_ENV=production`）的音樂庫沒有掛 Volume 時回 `503`（`MUSIC_REQUIRE_VOLUME=0` 可關閉後者）；也回報剩餘空間 `freeMB` |
| GET | `/api/music/list` | 列出整個音樂庫（回應帶 `ETag`；帶 `If-None-Match` 且清單沒變時回 `304`，適合 Bot 定期輪詢） |
| GET | `/api/music/exists?filename=` | 檢查指定檔案是否存在 |
| GET | `/api/music/file/*` | 下載檔案 |
| PUT | `/api/music/file/*` | 上傳檔案（原始位元組 body；僅限音訊副檔名，單檔上限 `MAX_UPLOAD_MB`，預設 512）。同名檔案已存在回 `409`，確定要取代時帶 `?overwrite=1`；磁碟已滿回 `507` |
| GET | `/api/music/status` | 服務狀態（見下方「服務狀態與記錄」） |
| PUT | `/api/music/bots/:botId/state` | Bot 推送「正在播放」（見下方「Bot 正在播放」） |
| GET | `/api/music/bots/:botId/commands?wait=25` | Bot 長輪詢拿網頁送來的控制指令 |
| POST | `/api/music/bots/:botId/commands/:id/result` | Bot 回報指令執行結果 |

> 🔒 沒設 `MUSIC_LIB_SECRET` 時，`/api/music/*` 預設**停用**（一律回 `503`），不論有沒有啟用網頁播放器，
> 避免服務被誤設成對外連得到時整個音樂庫被讀寫。只有在完全信任的內網、確定要在沒有金鑰的情況下開放，
> 才設定 `ALLOW_INSECURE_LIBRARY_API=1`。（以前沒啟用網頁播放器時，沒設金鑰就直接開放。）

這個服務刻意不提供播放次數功能：每個呼叫端 Bot 各自計算、各自
記錄自己的播放次數，不透過這裡同步或集中管理。

## 網頁播放器

設定好 Discord 登入（見下方）後，服務會多出一個瀏覽器可用的
串流播放器（不設定則完全不啟用，行為跟以前一樣）。播放器也支援漸進式網頁應用程式（PWA）：透過 HTTPS 或本機 `localhost` 開啟 `/player` 後，可使用瀏覽器的「安裝」功能加入桌面／主畫面，並以獨立視窗啟動。iOS／iPadOS 可使用 Safari 的「加入主畫面」。

- 開啟 `https://<你的公開網域>/player`，按「使用 Discord 登入」。
- 支援搜尋、資料夾篩選、上一首／下一首、隨機、循環（全部／單曲／不循環）、
  拖曳進度（HTTP Range）、鍵盤快速鍵（空白＝播放／暫停，N／P＝下一首／上一首，
  S＝隨機，R＝循環，←／→＝快退／快進 10 秒），也支援手機鎖定畫面的媒體控制。

#### Discord 登入

1. [Discord Developer Portal](https://discord.com/developers/applications) 選一個應用程式（可以直接用 Bot 的應用程式），
   **OAuth2 → Redirects** 加上 `<PUBLIC_BASE_URL>/auth/discord/callback`，複製 Client ID 與 Client Secret。
2. 設定環境變數：

| 變數 | 說明 |
|---|---|
| `DISCORD_CLIENT_ID`／`DISCORD_CLIENT_SECRET` | 上一步複製的值 |
| `PUBLIC_BASE_URL` | 網頁對外網址，例如 `https://music.example.com`（組 redirect_uri 用，要和 Discord 後台填的一致） |
| `WEB_ADMIN_USERS` | 管理員的 Discord 使用者 ID，逗號分隔（見下方「權限」）。每次請求都重新檢查，移除＝立即失效 |
| `WEB_BLOCKED_USERS` | （選用）不能登入的使用者 ID，已登入的也立即失效 |
| `WEB_SESSION_HOURS` | 登入有效時數，預設 `720`（30 天） |

- **任何 Discord 帳號都能登入**，不需要白名單。只要 `identify` 權限（只拿使用者 ID 與名稱，不讀伺服器清單、不讀 email）；
  Discord 的 access token 用完就丟，不保存。
- 要找自己的 Discord ID（填 `WEB_ADMIN_USERS` 用）：Discord 設定 → 進階 → 開啟開發者模式，在自己的名字上按右鍵「複製使用者 ID」。
- 以前的 `WEB_ALLOWED_USERS`／`WEB_ALLOWED_GUILD`／`WEB_ALLOWED_ROLES` 已經沒有作用（有設的話啟動時會在 log 提醒）。
- 登出只登出播放器，不會登出 Discord：再按登入時 Discord 已授權過，會直接登入、不再顯示同意畫面。
  被封鎖之後再按登入會顯示 Discord 的同意畫面，可以在上面按「不是你？」換一個帳號。

#### 權限

| | 一般帳號 | 管理員（`WEB_ADMIN_USERS`） |
|---|---|---|
| 聽音樂庫、線上搜尋與播放、離線下載 | ✅ | ✅ |
| 播放清單（**每個帳號各自一份**，互相看不到） | ✅ | ✅ |
| 收藏／移動／重新命名／刪除音樂庫檔案 | — | ✅ |
| 上傳音檔（`/upload?upload=1`） | — | ✅ |
| Bot 正在播放（查看、遙控、點歌給 Bot） | — | ✅ |
| 服務狀態（`/web/api/status`） | — | ✅ |

- 音樂庫、Bot 所在的伺服器是所有人共用的，所以會影響其他人的操作只開放給管理員；伺服器端一律檢查，
  播放器也只對管理員顯示這些按鈕與 Bot 頁籤。
- Bot 用內部金鑰（`x-music-lib-key`）呼叫時視同管理員，但沒有 Discord 帳號，所以不能用播放清單。
- 一般帳號的線上播放**只串流、不寫進共用音樂庫**（背景下載快取只替管理員做，快取命中的歌照樣直接播檔案）；
  同時最多 `WEB_MAX_STREAMS_PER_USER`（預設 `2`）個線上串流，搜尋／取得影片資訊每分鐘最多 `WEB_QUERIES_PER_MINUTE`（預設 `30`）次。
- 播放清單每個帳號最多 100 個、每個 2000 首、所有清單合計 10000 首；有播放清單的帳號最多 1000 個，
  全部帳號合計 200000 首；每個帳號每分鐘最多修改 120 次。每個帳號 1 小時內最多登入 60 次。
- 從舊版（所有人共用一份）升級時，舊的播放清單**不搬移**：`playlists.json` 會改名備份成
  `playlists.json.shared-<時間>.bak`，每個帳號都從空的開始。
  ⚠️ 部署後如果要回滾到舊版：舊版看不懂新格式，會直接覆蓋 `playlists.json`，回滾前請先備份這個檔案。
  播放清單檔讀取失敗時，播放清單功能回 `503` 並暫停寫入（不會用空的清單蓋掉所有人的資料）；不認得的格式會先備份成 `.unknown-<時間>.bak`。
- 登入限流：只計「向 Discord 換 token 失敗」的次數（正常登入不計），每個來源 10 分鐘內 10 次、全站 100 次，
  超過就暫停新的登入（已登入的裝置不受影響）。避免有人亂灌 callback，讓伺服器的 IP 被 Discord 限流。
- **主畫面 App（iOS）**：iOS 的主畫面 App 跟 Safari 不共用 Cookie，跳到 Discord 登入後回不到 App 裡，
  所以在 iOS 主畫面 App 按登入會改用**代碼登入**：App 顯示一組代碼和「開啟 Discord 登入」，在瀏覽器完成登入後，
  確認頁會顯示同一組代碼，按「確認登入」後 App 幾秒內自動登入（代碼 10 分鐘內有效）。
  其他平台的主畫面 App 若登入後回不來，登入框也有「改用代碼登入」可以用。
  確認頁一定要手動按確認：別人把他 App 的登入連結傳給你時，你點開也不會把登入交給對方（看到不是自己要求的代碼請按取消）；
  要求代碼的網路和按確認的網路不同時，確認頁會另外顯示紅字警告。
- 從舊版的密碼登入升級：`WEB_PLAYER_PASSWORD` 已經沒有作用（有設的話啟動時會在 log 提醒刪掉），所有人需要用 Discord 重新登入一次。

#### Cookie 與安全性

- 登入後由 HttpOnly、`SameSite=Strict` 的 Cookie 維持（預設 30 天，`WEB_SESSION_HOURS` 可調）。
  從別的網站連過來的請求（`Sec-Fetch-Site: cross-site`）一律不接受 Cookie 登入（回 `403`），
  別的網站不能讓已登入的使用者代為點歌、下載或改播放清單。播放器頁面本身不需要登入，從 Discord 點連結進來不受影響。
- 登出會讓該 Cookie 立即失效；已登出清單存在 `session-secret` 同一個資料夾的 `session-revoked.json`，重新部署後仍然有效。
  Cookie 的簽章金鑰：有設 `WEB_SESSION_SECRET` 就用它，否則第一次啟動時自動產生一組隨機金鑰存在
  `/app/data/session-secret`（`WEB_SESSION_SECRET_FILE` 可改位置）。
- 反向代理：只信任從本機／私有網段連進來的代理（`TRUST_PROXY`，預設 `loopback, linklocal, uniquelocal`），
  服務的埠號直接對外時，偽造的 `X-Forwarded-For` 不會被當成來源 IP。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/player` | 播放器頁面（純靜態） |
| GET | `/manifest.webmanifest` | PWA 安裝資訊（名稱、色彩、啟動頁、圖示） |
| GET | `/player-sw.js` | PWA Service Worker（離線殼層與已登入資料快取） |
| GET | `/auth/discord/login` | `?next=<站內路徑>`：導到 Discord 授權頁（`&switch=1`＝顯示同意畫面以便換帳號） |
| GET | `/auth/discord/callback` | Discord 導回來：檢查是否被封鎖、設定 Cookie |
| GET | `/web/api/me` | 目前登入的帳號 `{ id, name, admin }` |
| POST | `/auth/handoff/start` | 代碼登入：取得一次性代碼與登入連結 |
| POST | `/auth/handoff/poll` | 代碼登入：瀏覽器那邊確認後回 `200` 並設定 Cookie，還在等回 `202` |
| POST | `/auth/handoff/confirm` | 代碼登入：瀏覽器確認頁送出（確認或取消） |
| POST | `/auth/handoff/cancel` | 代碼登入：App 按取消，代碼立刻作廢 |
| POST | `/web/logout` | 清除 Cookie，並讓這個 Cookie 失效 |
| GET | `/web/api/list` | 曲目清單（需登入） |
| GET | `/web/stream/*` | 串流音檔，支援 Range（需登入） |
| GET | `/upload?upload=1` | 受控的音檔上傳頁（管理員；未帶正確參數時不提供） |
| POST | `/web/api/upload?upload=1` | 上傳、轉為 MP3、響度正規化後儲存（管理員） |
| GET | `/web/api/capabilities` | `{ online }`：伺服器是否可線上串流 |
| GET | `/web/api/search?q=` | 搜尋 YouTube + Bilibili |
| GET | `/web/api/info?url=` | 取得影片資訊（標題、時長） |
| GET | `/web/play?url=` | 線上播放（快取命中＝檔案；否則即時串流＋背景下載）；`&fmt=webm` 見下方 |
| GET／POST／PATCH／PUT／DELETE | `/web/api/playlists/*` | 自己的播放清單（每個帳號各自一份，見 `webplayer/playlistRoutes.js`） |
| POST | `/web/api/library/move` | `{ from, to }` 移動／重新命名（管理員；`to` 可省略副檔名；所有人的播放清單跟著改路徑） |
| DELETE | `/web/api/library/file/*` | 從音樂庫刪除檔案（管理員） |
| GET | `/web/api/status` | 服務狀態（管理員，內容同 `/api/music/status`） |
| GET | `/web/api/bots` | 各 Bot、各伺服器的播放狀態（管理員） |
| GET | `/web/api/bots/events` | SSE：Bot 狀態有變就推送（`event: state`；管理員） |
| POST | `/web/api/bots/:botId/command` | 遠端控制 Bot（管理員；含批量點歌 `enqueueMany`，最多 500 首），等 Bot 回報結果 `{ ok, message }` |

### Bot 正在播放（Bot ↔ 網頁同步）

播放器的 **Bot 正在播放** 頁籤（只有管理員看得到）即時顯示各 Bot、各伺服器正在播的歌、播放進度、循環模式與佇列，並可以：

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

- **收藏（移到資料夾）**：根目錄裡自動下載的歌（檔名結尾是 `[yt_…]`、`[BV…]` 這類影片 ID）是快取，空間不夠時會被清掉；移進子資料夾（預設 `favorites`）就會長期保存。
- **重新命名**、**移到其他資料夾**、**從音樂庫刪除**（會先確認，刪除後所有裝置與 Bot 都無法再播放）。

移動或改名後，伺服器上所有播放清單指向舊路徑的項目會一起更新；這個瀏覽器的佇列、播放歷史與離線檔也會跟著改。

### 受控音檔上傳

在已啟用網頁播放器的前提下，管理員開啟 `https://<你的公開網域>/upload?upload=1`（沒登入會先導去 Discord 登入），即可上傳 MP3、WAV、OGG、FLAC、M4A 或 AAC 音檔。未帶 `?upload=1`、值不是 `1` 或未登入時，頁面與上傳 API 都不會提供服務。

上傳檔案會先寫入不會列出的暫存檔，再由 ffmpeg 轉為高品質 MP3（LAME VBR `-q:a 2`），接著沿用 `ytdlp/musicNormalizer.js` 的雙通道 EBU R128 loudnorm 處理（`-16 LUFS`、`LRA 20`、`TP -2.0`）。只有壓縮與正規化都成功後才會以原子操作發布至音樂庫。音樂庫已有同名檔案時回 `409`，不會覆寫既有曲目（換一個曲名或資料夾即可）。

「儲存資料夾」留空時存到音樂庫根目錄（`MUSIC_DIR`），也可於頁面中指定子資料夾與曲名；單檔大小遵循 `MAX_UPLOAD_MB`（預設 `512`）。

> 快取＝根目錄第一層、而且檔名是自動下載格式（`<標題> [<影片 ID>].mp3`，ID 是 `yt_…`、`BV…`、`av…`）的音檔，
> 總量超過 `MAX_CACHE_SIZE_MB` 時會**從最久沒播放的開始**自動刪除
> （LRU：網頁播放或 Bot 下載快取檔時會更新檔案的存取時間 atime，不動修改時間）。
> 上傳到根目錄的歌（檔名不是這個格式）不算快取，不會被清理；子資料夾內的檔案也不會。
> （這一版之前，根目錄第一層的所有音檔都算快取，沒選資料夾的上傳會被刪掉。）

### 線上串流（YouTube / Bilibili，yt-dlp）

網頁播放器上的 **🌐 線上** 按鈕：搜尋（YouTube + Bilibili）或直接貼影片網址，點歌即播，
可以「＋」加入佇列（佇列優先於音樂庫的下一首，行為同 Bot）。

播放流程移植自 Mousebot 的 `onlineMusicHandler.js`，邏輯與常數相同：

0. 網址先正規化成唯一的標準形式（`ytdlp/urlUtils.js` 的 `cleanUrl`）：YouTube → `https://www.youtube.com/watch?v=<id>`，
   Bilibili → `https://www.bilibili.com/video/<BV 號>`，http 一律改成 https。網址裡出現互相衝突的影片 ID
   （例如 `/shorts/<B>?v=<A>`）直接拒絕——以前 yt-dlp 會下載 B、快取卻存成 A，之後所有人播 A 都聽到 B。
1. 先查快取（`<MUSIC_DIR>` 根目錄第一層，檔名格式與 Bot 相同，所以 Bot 與網頁的快取互相命中）。
   影片 ID 依網址的平台判斷：YouTube 影片 ID 裡剛好含有 `av1`、`BV…` 時不會被誤認成 Bilibili
   （Bot 端的 `getCacheFilename` 需要做同樣的修改，否則這類影片兩邊的快取不會互相命中）。
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
- yt-dlp 一律驗證 TLS 憑證（帳號 Cookie 會隨請求送出），並排除 generic extractor（`--use-extractors default,-generic`）。
- ffmpeg / ffprobe 讀檔時只允許一般音訊格式與本機檔案（`-format_whitelist`、`-protocol_whitelist`），
  偽裝成音檔的播放清單（ffconcat、HLS）不會被拿來讀伺服器上的其他檔案或連內網。
- 目前不支援播放清單網址（只播單支影片）。

**伺服器需要安裝 `yt-dlp` 和 `ffmpeg`**，沒裝的話線上功能自動停用，音樂庫播放不受影響。
專案的 [Dockerfile](Dockerfile) 已內建；自行建置其他 Debian／Ubuntu 系映像時可參考（`yt-dlp` 這個版本需要 python3）：

```dockerfile
ENV PATH=/opt/yt-dlp:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl tini gosu \
 && mkdir -p /opt/yt-dlp && cd /opt/yt-dlp \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS | grep -E ' yt-dlp$' | sha256sum -c - \
 && chmod a+rx yt-dlp && chown -R node:node /opt/yt-dlp \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
```

服務在容器裡以 `node` 使用者（非 root）執行：[docker-entrypoint.sh](docker-entrypoint.sh) 啟動時先把 `/app/data`
（以及 `MUSIC_DIR` 等有設定的資料夾）交給 `node`，再降權啟動。從舊版（以 root 執行）升級時，Volume 裡既有的檔案會自動改擁有者。

YouTube 需要的環境變數（`WARP_PROXY_URL`、`YOUTUBE_PO_TOKEN`、cookies 檔等）和 Bot 相同，見 `.env.example`。

#### PO Token 自動產生器（bgutil）

專案的 Dockerfile 內建 [bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)：
server 裝在 `/opt/bgutil/server`，由 `ytdlp/potProvider.js` **按需啟動**（只聽 `127.0.0.1:4416`）：
第一次要跑 YouTube 的 yt-dlp 前才啟動，閒置 `POT_IDLE_MINUTES`（預設 15）分鐘後關閉以釋放記憶體，
掛掉的話下次需要時再啟動。yt-dlp plugin 放在 `/etc/yt-dlp/plugins/`。yt-dlp 需要 PO Token 時會自動向它要，
不必再手動更新會過期的 `YOUTUBE_PO_TOKEN`。啟動 log 的「PO Token ✓（bgutil 本機）」代表已啟用。

- 想改用獨立的 bgutil 容器：設 `POT_PROVIDER_URL=http://<host>:4416`。
- 想關閉：設 `POT_PROVIDER=0`。
- 升級時修改 Dockerfile 的 `BGUTIL_VERSION`（server 與 plugin 版本須一致）與兩個 SHA-256
  （`BGUTIL_SRC_SHA256`、`BGUTIL_PLUGIN_SHA256`），並建議同時重建映像以更新 yt-dlp。
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
- 設定 `ALERT_WEBHOOK_URL`（Discord webhook）後，網頁串流一小時內失敗達 5 次、播放器登入被鎖定時會送通知（同一件事 1 小時內只送一次）。
- 播放器頁面、js／css 與 JSON 回應會用 gzip 壓縮；音訊串流、檔案傳輸與 SSE 不壓縮。
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
