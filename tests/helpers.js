'use strict';
// 測試共用工具（不是測試檔：node --test 只會執行 tests/ 底下的 *.test.js）。每個測試檔由 node --test 在獨立行程執行，
// 所以各檔可以在 require 被測模組「之前」設定好自己的環境變數（模組在載入時讀取設定）。
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempDir(prefix = 'mls-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 建立檔案（自動建立上層資料夾），回傳絕對路徑
function touch(root, relPath, content = 'x') {
  const abs = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

module.exports = { tempDir, touch };
