// ytdlp/musicNormalizer.js
// 移植自 Mousebot handlers/musicplayer/musicNormalizer.js（邏輯與參數完全相同）
// 職責：對已下載的音檔進行響度正規化 (Loudness Normalization)
// 原理：使用 ffmpeg 內建 loudnorm 濾鏡，雙通道 (two-pass) 分析 + 套用
// 參數對齊指令：ffmpeg-normalize "$f" -o "output/$f" -nt ebu -t -16 -lrt 20

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const logger = require('../logger');
const { invalidateList } = require('../musicStore');

const TARGET_LUFS = -16;   // -t -16
const TARGET_LRA  = 20;    // -lrt 20
const TARGET_TP   = -2.0;  // 未指定 -tp 時，ffmpeg-normalize 於 ebu 模式的預設值

const MAX_CONCURRENT = 2;
let running = 0;
const queue = [];

function _runNext() {
  if (running >= MAX_CONCURRENT || queue.length === 0) return;
  running++;
  const { filePath, resolve, reject } = queue.shift();
  _normalizeOne(filePath)
    .then(resolve, reject)
    .finally(() => {
      running--;
      _runNext();
    });
}

/**
 * 成功：覆蓋原檔案，resolve(filePath)
 * 失敗：保留原檔案不動，reject(err)（呼叫端應 catch 但不中斷主流程）
 */
function normalizeAudioFile(filePath) {
  return new Promise((resolve, reject) => {
    queue.push({ filePath, resolve, reject });
    _runNext();
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
      .then((measured) => _applyLoudnorm(filePath, tmpPath, measured))
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

function _analyzeLoudness(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostats',
      '-i', filePath,
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

function _applyLoudnorm(inputPath, outputPath, measured) {
  return new Promise((resolve, reject) => {
    const af =
      `loudnorm=I=${TARGET_LUFS}:LRA=${TARGET_LRA}:TP=${TARGET_TP}:` +
      `measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:` +
      `measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:` +
      `offset=${measured.target_offset}:linear=true:print_format=summary`;

    const args = [
      '-hide_banner', '-nostats', '-y',
      '-i', inputPath,
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
  TARGET_LUFS,
  TARGET_LRA,
  TARGET_TP,
};
