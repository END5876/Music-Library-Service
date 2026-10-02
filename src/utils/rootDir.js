'use strict';
// 專案根目錄（<repo>/）。各模組用它組預設的 data/ 路徑，
// 不再依賴「自己所在資料夾的相對層數」，搬動檔案時不會算錯。
const path = require('path');
module.exports = path.resolve(__dirname, '..', '..');
