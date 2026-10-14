'use strict';
// ESLint（flat config）：只開推薦規則，重點是抓未定義／未使用的變數與明顯錯誤，不管排版風格。
// 執行：npm run lint
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', 'data/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }], // 專案慣例：try {} catch {} 刻意忽略錯誤
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-control-regex': 'off', // 輸入清理刻意比對 0x00-0x1f 控制字元
      'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }], // 中文字串裡的全形空白
    },
  },
  {
    // 瀏覽器端：各檔是一般 <script>，彼此透過 window.ML* 溝通
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, zhFold: 'readonly' } },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
];
