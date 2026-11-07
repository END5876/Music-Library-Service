// ytdlp/musicNormalizer.js
// 移植自 Mousebot handlers/musicplayer/musicNormalizer.js（響度參數相同；快取檔的編碼參數改成明確指定，見 CACHE_ENCODE）
// 職責：對已下載的音檔進行響度正規化 (Loudness Normalization)
// 原理：使用 ffmpeg 內建 loudnorm 濾鏡，雙通道 (two-pass) 分析 + 套用
// 參數對齊指令：ffmpeg-normalize "$f" -o "output/$f" -nt ebu -t -16 -lrt 20

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('../logger');
const { invalidateList, SAFE_INPUT_ARGS } = require('../musicStore');

const TARGET_LUFS = -16;   // -t -16
const TARGET_LRA  = 20;    // -lrt 20
const TARGET_TP   = -2.0;  // 未指定 -tp 時，ffmpeg-normalize 於 ebu 模式的預設值

// 上傳用：只取第一條音軌（忽略封面圖等視訊串流），輸出 LAME VBR -q:a 2
const MP3_SELECT = ['-map', '0:a:0', '-vn'];
const MP3_ENCODE = ['-c:a', 'libmp3lame', '-q:a', '2'];
// 🐛 背景下載的快取檔：跟下載時 yt-dlp 的 --audio-quality 0 一樣用 VBR -q:a 0。
// 以前沒指定編碼參數，ffmpeg 用 LAME 預設的 128 kbps CBR，正規化一次音質就永久掉一半
const CACHE_ENCODE = ['-c:a', 'libmp3lame', '-q:a', '0'];

// 所有 ffmpeg 響度工作（背景下載的正規化、網頁上傳）共用同一個並行上限
// 記憶體小的機器可設 WEB_MAX_NORMALIZE=1：只是快取檔晚一點完成正規化，不影響播放
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.WEB_MAX_NORMALIZE || '2', 10) || 2);
let running = 0;
const queue = [];

function _runNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  running++;
  const { task, resolve, reject } = queue.shift();
  task()
    .then(resolve, reject)
    .finally(() => {
      running--;
      _runNext();
    });
}

function _enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    _runNext();
  });
}

/**
 * 成功：覆蓋原檔案，resolve(filePath)
 * 失敗：保留原檔案不動，reject(err)（呼叫端應 catch 但不中斷主流程）
 * ⚠️ 會原地換掉檔案：只能用在還沒發布的暫存檔（見 musicCache.downloadAndCache），
 *    已在庫內的檔案可能正在被播放，換掉後瀏覽器接下來的 Range 請求會用舊檔的位移讀新檔
 */
function normalizeAudioFile(filePath) {
  return _enqueue(() => _normalizeOne(filePath));
}

/**
 * 網頁上傳用：直接分析原始檔的響度，套用 loudnorm 的同一次就編碼成 MP3。
 * （以前是「先轉 MP3 → 分析 → 再重新編碼一次」：多跑一次 ffmpeg，還多一次有損壓縮）
 * 成功：寫出 outputPath；失敗：reject(err)，由呼叫端清理暫存檔
 */
function normalizeToMp3(inputPath, outputPath) {
  return _enqueue(() =>
    _analyzeLoudness(inputPath, MP3_SELECT)
      .then((measured) => _applyLoudnorm(inputPath, outputPath, measured, [...MP3_SELECT, ...MP3_ENCODE])));
}

// ── 低位元率 MP3 不重新編碼 ─────────────────────────────────
// 已經是 ≤ LOSSLESS_MP3_MAX_KBPS 的 MP3 再編一次只會疊加失真、檔案也不會變小。
// 改成：量響度 → 用 mp3gain 直接改每個 frame 的 global_gain（無損，1.5 dB 一階）。
// 沒有安裝 mp3gain（例如本機 Windows 開發）時原檔照存，只是音量沒有對齊。
const LOSSLESS_MP3_MAX_KBPS = 200;
const MP3GAIN_STEP_DB = 1.5;
const MP3GAIN_TP_CEILING = -1.0; // 調大音量後真峰值不超過 -1 dBTP，避免削波

function probeAudio(filePath) {
  return new Promise((resolve) => {
    const ff = spawn('ffprobe', [
      '-v', 'error', ...SAFE_INPUT_ARGS, '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,bit_rate:format=format_name,bit_rate',
      '-of', 'json', filePath,
    ]);
    let out = '';
    ff.stdout.on('data', (d) => { out = (out + d.toString()).slice(-20000); });
    ff.on('error', () => resolve(null));
    ff.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = (j.streams || [])[0] || {};
        const kbps = Math.round((Number(s.bit_rate) || Number((j.format || {}).bit_rate) || 0) / 1000);
        resolve({ codec: s.codec_name || '', kbps });
      } catch { resolve(null); }
    });
  });
}

let mp3gainAvailable = null;
function hasMp3gain() {
  if (mp3gainAvailable !== null) return Promise.resolve(mp3gainAvailable);
  return new Promise((resolve) => {
    const p = spawn('mp3gain', ['-v']);
    p.on('error', () => resolve(mp3gainAvailable = false));
    p.on('close', () => resolve(mp3gainAvailable = true));
  });
}

// 依量到的響度算出 mp3gain 的階數：往目標靠近，但調大時真峰值不能超過上限
function gainSteps(measured) {
  const inputI = Number(measured.input_i);
  const inputTp = Number(measured.input_tp);
  if (!isFinite(inputI)) return 0;
  let steps = Math.round((TARGET_LUFS - inputI) / MP3GAIN_STEP_DB);
  if (steps > 0 && isFinite(inputTp)) {
    steps = Math.min(steps, Math.floor((MP3GAIN_TP_CEILING - inputTp) / MP3GAIN_STEP_DB));
  }
  return Math.max(-40, Math.min(40, steps)); // 最多 ±60 dB，再多一定是量錯了
}

function _runMp3gain(filePath, steps) {
  return new Promise((resolve, reject) => {
    // -g：直接套用階數；-c：不問是否削波（上面已經用真峰值限制過）；-q：安靜
    const p = spawn('mp3gain', ['-q', '-c', '-g', String(steps), filePath]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    p.on('error', (err) => reject(new Error('執行 mp3gain 失敗: ' + err.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`mp3gain 失敗 (code ${code}): ${stderr.slice(-300)}`))));
  });
}

/**
 * 網頁上傳的處理入口：
 *   mode='original'                     不轉檔、不正規化，原檔照存（呼叫端只對私人上傳開放）
 *   MP3 而且 ≤ LOSSLESS_MP3_MAX_KBPS     不重新編碼，mp3gain 無損調整音量（沒有 mp3gain 就原檔照存）
 *   其他                                 轉成 MP3 q2 並雙通道正規化（normalizeToMp3）
 * 成功時 outputPath 已寫好，回傳 { method: 'original'|'mp3gain'|'copy'|'transcode', gainDb? }
 * 呼叫端負責清理 inputPath / outputPath。
 */
async function processUpload(inputPath, outputPath, { mode = 'transcode' } = {}) {
  if (mode === 'original') {
    await fs.promises.copyFile(inputPath, outputPath);
    return { method: 'original' };
  }
  const info = await probeAudio(inputPath);
  if (info && info.codec === 'mp3' && info.kbps > 0 && info.kbps <= LOSSLESS_MP3_MAX_KBPS) {
    return _enqueue(async () => {
      const measured = await _analyzeLoudness(inputPath, MP3_SELECT);
      // 只取音訊、去掉封面等其他串流，但不重新編碼
      await _ffmpeg(['-hide_banner', '-nostats', '-y', ...SAFE_INPUT_ARGS, '-i', inputPath, ...MP3_SELECT, '-c:a', 'copy', outputPath]);
      const steps = gainSteps(measured);
      if (steps === 0) return { method: 'copy', kbps: info.kbps };
      if (!(await hasMp3gain())) {
        logger.warn('MusicNormalizer', '⚠️ 沒有安裝 mp3gain：低位元率 MP3 原檔照存，音量未對齊');
        return { method: 'copy', kbps: info.kbps };
      }
      await _runMp3gain(outputPath, steps);
      return { method: 'mp3gain', kbps: info.kbps, gainDb: steps * MP3GAIN_STEP_DB };
    });
  }
  await normalizeToMp3(inputPath, outputPath);
  return { method: 'transcode' };
}

function _ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    ff.on('error', (err) => reject(new Error('執行 ffmpeg 失敗: ' + err.message)));
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失敗 (code ${code}): ${stderr.slice(-300)}`))));
  });
}

function _normalizeOne(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`檔案不存在: ${filePath}`));
    }

    const dir  = path.dirname(filePath);
    const ext  = path.extname(filePath);
    const base = path.basename(filePath, ext);

    // 暫存檔建在與原檔相同的資料夾，確保同一個掛載點，rename 不會拋 EXDEV
    const tmpPath = path.join(dir, `${base}.norm_${Date.now()}.tmp${ext}`);

    _analyzeLoudness(filePath)
      .then((measured) => _applyLoudnorm(filePath, tmpPath, measured, [...MP3_SELECT, ...CACHE_ENCODE]))
      .then(() => {
        fs.renameSync(tmpPath, filePath);
        invalidateList(); // 檔案大小改變了
        logger.debug('MusicNormalizer', `✅ 響度正規化完成: ${path.basename(filePath)}`);
        resolve(filePath);
      })
      .catch((err) => {
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        logger.warn('MusicNormalizer', `⚠️ 正規化失敗，保留原檔: ${path.basename(filePath)} - ${err.message}`);
        reject(err);
      });
  });
}

function _analyzeLoudness(filePath, outputArgs = []) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      ...SAFE_INPUT_ARGS,
      '-i', filePath,
      ...outputArgs,
      '-af', `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:print_format=json`,
      '-f', 'null', '-',
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-20000); });

    ff.on('close', () => {
      // loudnorm 的 JSON 一定在輸出最後；用最後一個 '{' 起算，避免檔案標籤（標題含大括號）干擾
      const start = stderr.lastIndexOf('{');
      const end = stderr.lastIndexOf('}');
      if (start < 0 || end < start) return reject(new Error('無法解析 loudnorm 分析結果（可能是不支援的音訊格式）'));
      try {
        resolve(JSON.parse(stderr.slice(start, end + 1)));
      } catch (e) {
        reject(new Error('loudnorm JSON 解析失敗: ' + e.message));
      }
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 分析失敗: ' + err.message)));
  });
}

function _applyLoudnorm(inputPath, outputPath, measured, outputArgs = []) {
  return new Promise((resolve, reject) => {
    const af =
      `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:` +
      `measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:` +
      `measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:` +
      `offset=${measured.target_offset}:linear=true:print_format=summary`;

    const args = [
      '-hide_banner', '-nostats', '-y',
      ...SAFE_INPUT_ARGS,
      '-i', inputPath,
      ...outputArgs,
      '-af', af,
      outputPath,
    ];
    const ff = spawn('ffmpeg', args);
    let stderr = '';

    ff.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });

    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 套用正規化失敗 (code ${code}): ${stderr.slice(-300)}`));
    });

    ff.on('error', (err) => reject(new Error('執行 ffmpeg 轉檔失敗: ' + err.message)));
  });
}

module.exports = {
  normalizeAudioFile,
  normalizeToMp3,
  processUpload,
  gainSteps,
  LOSSLESS_MP3_MAX_KBPS,
  TARGET_LUFS,
  TARGET_LRA,
  TARGET_TP,
};
