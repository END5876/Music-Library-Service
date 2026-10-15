'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');

test('isAllowedUrl：只允許 http(s) 的 YouTube / Bilibili 網域', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'http://www.bilibili.com/video/BV1xx411c7mD',
    'https://bilibili.com/video/BV1xx411c7mD',
  ]) assert.equal(isAllowedUrl(u), true, u);
});

test('isAllowedUrl：拒絕其他網域、相似網域與非 http 協定', () => {
  for (const u of [
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch',   // 前綴相同
    'https://notyoutube.com/watch',         // 後綴相同但不是子網域
    'https://evilbilibili.com/video/x',
    'file:///etc/passwd',
    'ftp://youtube.com/x',
    'javascript:alert(1)',
    'youtube.com/watch?v=x',                // 沒有協定 → 不是合法 URL
    '',
    'not a url',
  ]) assert.equal(isAllowedUrl(u), false, u);
});

test('cleanUrl：YouTube 移除播放清單等追蹤參數，保留影片 id', () => {
  const out = new URL(cleanUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=3&start_radio=1&rv=x&feature=share&t=42'));
  assert.equal(out.searchParams.get('v'), 'dQw4w9WgXcQ');
  assert.equal(out.searchParams.get('t'), '42');
  for (const k of ['list', 'index', 'start_radio', 'rv', 'feature']) assert.equal(out.searchParams.has(k), false, k);
});

test('cleanUrl：Bilibili 只保留分 P 參數', () => {
  assert.equal(cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333&vd_source=abc'),
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333'),
    'https://www.bilibili.com/video/BV1xx411c7mD');
});

test('cleanUrl：其他網址與不合法字串原樣回傳', () => {
  assert.equal(cleanUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(cleanUrl('not a url'), 'not a url');
});
