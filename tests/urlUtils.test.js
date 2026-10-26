'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanUrl, isAllowedUrl } = require('../ytdlp/urlUtils');
const { getCacheFilename } = require('../ytdlp/musicCache');

test('isAllowedUrl：只允許 https 的 YouTube / Bilibili 網域', () => {
  for (const u of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://bilibili.com/video/BV1xx411c7mD',
  ]) assert.equal(isAllowedUrl(u), true, u);
});

test('isAllowedUrl：拒絕其他網域、相似網域、http 與非 http 協定', () => {
  for (const u of [
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch',   // 前綴相同
    'https://notyoutube.com/watch',         // 後綴相同但不是子網域
    'https://evilbilibili.com/video/x',
    'http://www.bilibili.com/video/BV1xx411c7mD', // 明文 HTTP：帳號 cookie 會以明文送出（要先經過 cleanUrl 改成 https）
    'file:///etc/passwd',
    'ftp://youtube.com/x',
    'javascript:alert(1)',
    'youtube.com/watch?v=x',                // 沒有協定 → 不是合法 URL
    '',
    'not a url',
  ]) assert.equal(isAllowedUrl(u), false, u);
});

test('cleanUrl：http 網址改成 https，之後就能通過 isAllowedUrl', () => {
  const out = cleanUrl('http://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(isAllowedUrl(out), true);
  assert.equal(cleanUrl('http://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('cleanUrl：YouTube 重建成標準的 watch 網址，只保留影片 id 與開始時間', () => {
  assert.equal(cleanUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=3&start_radio=1&rv=x&feature=share&t=42'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42');
  for (const u of [
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ?start=1',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ?v=dQw4w9WgXcQ', // 同一支影片不算衝突
  ]) assert.equal(cleanUrl(u), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', u);
});

test('cleanUrl：網址裡的影片 ID 互相衝突就拒絕（快取投毒）', () => {
  for (const u of [
    'https://www.youtube.com/shorts/BBBBBBBBBBB?v=AAAAAAAAAAA', // yt-dlp 會下載 B，舊版快取卻存成 A
    'https://www.youtube.com/watch?v=AAAAAAAAAAA&v=BBBBBBBBBBB',
    'https://youtu.be/BBBBBBBBBBB?v=AAAAAAAAAAA',
    'https://www.youtube.com/embed/not-an-id?v=AAAAAAAAAAA',
  ]) {
    assert.equal(cleanUrl(u), '', u);
    assert.equal(isAllowedUrl(cleanUrl(u)), false, u);
  }
});

test('快取檔名的影片 ID 跟交給 yt-dlp 的網址一致', () => {
  // 查詢參數裡的 BV 號不能決定快取檔名
  assert.equal(getCacheFilename(cleanUrl('https://www.youtube.com/watch?v=EVILVIDEO01&x=BV1GJ411x7h7'), 'T'), 'T [yt_EVILVIDEO01].mp3');
  assert.equal(getCacheFilename(cleanUrl('https://www.bilibili.com/video/BV1GJ411x7h7?x=BV1aaaaaaaaa'), 'T'), 'T [BV1GJ411x7h7].mp3');
  assert.equal(getCacheFilename(cleanUrl('https://youtu.be/dQw4w9WgXcQ'), 'T'), 'T [yt_dQw4w9WgXcQ].mp3');
});

test('cleanUrl：Bilibili 只保留分 P 參數', () => {
  assert.equal(cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333&vd_source=abc'),
    'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
  assert.equal(cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333'),
    'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD/BV1aaaaaaaaa'),
    'https://www.bilibili.com/video/BV1xx411c7mD', '路徑後面多出來的部分丟掉');
});

test('cleanUrl：其他網址與不合法字串原樣回傳', () => {
  assert.equal(cleanUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(cleanUrl('not a url'), 'not a url');
});
