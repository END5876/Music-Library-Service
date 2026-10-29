'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { tempDir, touch } = require('./helpers');

const MUSIC = tempDir();
process.env.MUSIC_DIR = MUSIC;
process.env.MAX_UPLOAD_MB = '1';
process.env.MAX_CACHE_SIZE_MB = '2048'; // 這個檔案不測快取清理（見 musicStore.evict.test.js）
const store = require('../musicStore');

// 寫入／清理成功時 musicStore 會印 log。不靜音的話，Linux 上 node --test 偶爾會把子行程的 stdout
// 和測試結果的序列化訊息混在一起，整個檔案報「Unable to deserialize cloned data」失敗（斷言本身都通過）
const origLog = console.log;
test.before(() => { console.log = () => {}; });
test.after(() => {
  console.log = origLog;
  fs.rmSync(MUSIC, { recursive: true, force: true });
});

test('resolveForRead：合法的音訊路徑回傳 MUSIC_DIR 底下的絕對路徑（不檢查是否存在）', () => {
  assert.equal(store.resolveForRead('a.mp3'), path.resolve(MUSIC, 'a.mp3'));
  assert.equal(store.resolveForRead('fav/歌 名.FLAC'), path.resolve(MUSIC, 'fav', '歌 名.FLAC'));
  assert.equal(store.resolveForRead('/fav//x.mp3'), path.resolve(MUSIC, 'fav', 'x.mp3'), '開頭的 / 與重複的 / 會被正規化');
  assert.equal(store.resolveForRead('fav\\x.mp3'), path.resolve(MUSIC, 'fav', 'x.mp3'), '反斜線視為分隔符號');
  assert.equal(store.resolveForRead('fav/../x.mp3'), path.resolve(MUSIC, 'x.mp3'), '範圍內的 .. 允許');
});

test('resolveForRead：非音訊檔與暫存檔回傳 null', () => {
  for (const p of ['a.txt', 'playlists.json', 'x.mp3.exe', 'x.tmp.mp3', 'x.mp3.upload_1_ab.tmp', 'x.norm_1.tmp.mp3', 'noext']) {
    assert.equal(store.resolveForRead(p), null, p);
  }
});

test('resolveForRead：跳出音樂庫、保留資料夾、NUL 字元一律拒絕', () => {
  for (const p of ['../x.mp3', '../../etc/passwd.mp3', 'a/../../x.mp3', '..\\x.mp3', '.web/playlists.mp3', '/.web/x.mp3',
    'x\0.mp3', '', '.', '/', '..']) {
    assert.throws(() => store.resolveForRead(p), /不合法的檔案路徑/, JSON.stringify(p));
  }
});

test('exists：回傳存在與大小；不存在、資料夾、非音訊都視為不存在', async () => {
  touch(MUSIC, 'ex/one.mp3', '12345');
  fs.mkdirSync(path.join(MUSIC, 'ex', 'dir.mp3'), { recursive: true });
  touch(MUSIC, 'ex/note.txt');
  const one = await store.exists('ex/one.mp3');
  assert.equal(one.exists, true);
  assert.equal(one.filename, 'ex/one.mp3');
  assert.equal(one.size, 5);
  for (const p of ['ex/nope.mp3', 'ex/dir.mp3', 'ex/note.txt']) assert.equal((await store.exists(p)).exists, false, p);
  await assert.rejects(store.exists('../x.mp3'), /不合法/);
});

test('isNotFoundError：只把「找不到檔案」類的錯誤當成 404', () => {
  for (const e of [{ code: 'ENOENT' }, { code: 'ENOTDIR' }, { code: 'EISDIR' }, { status: 404 }]) assert.equal(store.isNotFoundError(e), true);
  for (const e of [null, undefined, { code: 'EACCES' }, { status: 500 }, new Error('x')]) assert.equal(store.isNotFoundError(e), false);
});

test('listAll：遞迴列出音訊檔、清理顯示名稱、排除暫存檔／保留資料夾／非音訊檔', async () => {
  // listAll 掃的是整個 MUSIC_DIR（模組載入時決定），這裡在獨立的 L/ 子樹建測試檔，只檢查這個子樹的結果
  touch(MUSIC, 'L/歌名 [BV1xx411c7mD].mp3');
  touch(MUSIC, 'L/Some_Song (yt_dQw4w9WgXcQ).m4a');
  touch(MUSIC, 'L/sub/Deep.ogg');
  touch(MUSIC, 'L/x.tmp.mp3');
  touch(MUSIC, 'L/x.mp3.upload_1_ab.tmp');
  touch(MUSIC, 'L/readme.txt');
  touch(MUSIC, '.web/hidden.mp3');
  store.invalidateList();
  const files = (await store.listAll()).filter((f) => f.filename.startsWith('L/') || f.filename.startsWith('.web/'));
  const byName = Object.fromEntries(files.map((f) => [f.filename, f.name]));
  assert.deepEqual(Object.keys(byName).sort(), ['L/Some_Song (yt_dQw4w9WgXcQ).m4a', 'L/sub/Deep.ogg', 'L/歌名 [BV1xx411c7mD].mp3']);
  // 顯示名稱規則與 Bot 相同：去副檔名、去結尾的 [BV…]/(yt_…) 影片 id、去開頭的 [第一層資料夾]、底線換空白
  assert.equal(byName['L/歌名 [BV1xx411c7mD].mp3'], '歌名');
  assert.equal(byName['L/Some_Song (yt_dQw4w9WgXcQ).m4a'], 'Some Song');
  assert.equal(byName['L/sub/Deep.ogg'], 'Deep');
  for (const f of files) assert.ok(typeof f.size === 'number' && typeof f.mtimeMs === 'number');
});

test('listAll：短時間內重複呼叫共用同一份結果；invalidateList 後重新掃描', async () => {
  store.invalidateList();
  const [a, b] = await Promise.all([store.listAll(), store.listAll()]);
  assert.equal(a, b, '同時呼叫共用同一次掃描');
  assert.equal(await store.listAll(), a, 'TTL 內回傳快取');
  touch(MUSIC, 'L/new.mp3');
  assert.equal((await store.listAll()).some((f) => f.filename === 'L/new.mp3'), false, '未 invalidate 前看不到新檔');
  store.invalidateList();
  assert.equal((await store.listAll()).some((f) => f.filename === 'L/new.mp3'), true, 'invalidate 後看得到新檔');
});

test('listAll：掃描進行中 invalidateList，之後的呼叫重新掃描，舊的結果不寫進快取', async () => {
  store.invalidateList();
  const stale = store.listAll(); // 掃描開始、還沒完成
  store.invalidateList();         // 例如期間有檔案被刪除／移動
  const fresh = store.listAll();
  const [s, f] = await Promise.all([stale, fresh]);
  assert.notEqual(s, f, 'invalidate 後不加入異動前開始的掃描');
  assert.equal(await store.listAll(), f, '快取的是異動後的掃描結果');
});

test('writeFileFromStream：寫入成功後才出現在清單，且不留暫存檔', async () => {
  const r = await store.writeFileFromStream('W/up.mp3', Readable.from([Buffer.from('hello')]));
  assert.equal(r.relPath, 'W/up.mp3');
  assert.equal(fs.readFileSync(path.join(MUSIC, 'W', 'up.mp3'), 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(path.join(MUSIC, 'W')), ['up.mp3']);
  assert.equal((await store.listAll()).some((f) => f.filename === 'W/up.mp3'), true);
});

test('writeFileFromStream：預設不覆寫既有檔案（409），overwrite: true 才取代', async () => {
  await store.writeFileFromStream('W/over.mp3', Readable.from([Buffer.from('old')]));
  await assert.rejects(store.writeFileFromStream('W/over.mp3', Readable.from([Buffer.from('evil')])), (err) => err.status === 409);
  assert.equal(fs.readFileSync(path.join(MUSIC, 'W', 'over.mp3'), 'utf8'), 'old');
  assert.ok(!fs.readdirSync(path.join(MUSIC, 'W')).some((n) => n.includes('.tmp')), '失敗時不留暫存檔');
  await store.writeFileFromStream('W/over.mp3', Readable.from([Buffer.from('new!')]), { overwrite: true });
  assert.equal(fs.readFileSync(path.join(MUSIC, 'W', 'over.mp3'), 'utf8'), 'new!');
});

test('writeErrorStatus：磁碟已滿回 507，StoreError 沿用自己的狀態碼，其他 400', () => {
  assert.equal(store.writeErrorStatus(Object.assign(new Error('x'), { code: 'ENOSPC' })), 507);
  assert.equal(store.writeErrorStatus(new store.StoreError(409, 'x')), 409);
  assert.equal(store.writeErrorStatus(new Error('x')), 400);
});

test('writeFileFromStream：拒絕不合法路徑與非音訊檔，不建立任何檔案', async () => {
  await assert.rejects(store.writeFileFromStream('../evil.mp3', Readable.from([Buffer.from('x')])), /不合法/);
  await assert.rejects(store.writeFileFromStream('W2/evil.txt', Readable.from([Buffer.from('x')])), /只允許上傳音訊檔/);
  assert.equal(fs.existsSync(path.join(MUSIC, 'W2')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(MUSIC), 'evil.mp3')), false);
});

test('writeFileFromStream：超過 MAX_UPLOAD_MB 時中止，不留下半成品', async () => {
  // Content-Length 宣告超過上限：直接拒絕
  const declared = Readable.from([Buffer.from('x')]);
  declared.headers = { 'content-length': String(2 * 1024 * 1024) };
  await assert.rejects(store.writeFileFromStream('W3/big.mp3', declared), /檔案過大/);
  // 沒有宣告長度（chunked）：傳輸中累計超過上限才中止
  const chunks = Array.from({ length: 5 }, () => Buffer.alloc(300 * 1024));
  await assert.rejects(store.writeFileFromStream('W3/big2.mp3', Readable.from(chunks)), /檔案過大/);
  const left = fs.existsSync(path.join(MUSIC, 'W3')) ? fs.readdirSync(path.join(MUSIC, 'W3')) : [];
  assert.deepEqual(left, [], '沒有正式檔，也沒有殘留暫存檔');
});

test('writeTempFileFromStream：檔案先寫到不會被列出的暫存檔', async () => {
  const { tmpPath, absPath, relPath } = await store.writeTempFileFromStream('T/a.mp3', Readable.from([Buffer.from('data')]), '.flac');
  assert.equal(relPath, 'T/a.mp3');
  assert.equal(fs.existsSync(absPath), false, '正式路徑還沒出現');
  assert.match(path.basename(tmpPath), /^a\.mp3\.upload_\d+_[a-z0-9]+\.tmp\.flac$/);
  store.invalidateList();
  assert.equal((await store.listAll()).some((f) => f.filename.startsWith('T/')), false, '暫存檔不會出現在清單');
  await assert.rejects(store.writeTempFileFromStream('T/b.mp3', Readable.from([Buffer.from('x')]), '.exe'), /不支援的音訊格式/);
});

test('cleanupStaleTemps：只刪超過 1 小時的暫存檔，不碰一般檔案與保留資料夾', async () => {
  const old = Date.now() / 1000 - 2 * 3600;
  const staleA = touch(MUSIC, 'C/x.tmp.mp3');
  const staleB = touch(MUSIC, 'C/deep/y.mp3.upload_1_ab.tmp');
  const fresh = touch(MUSIC, 'C/z.tmp.mp3');
  const song = touch(MUSIC, 'C/song.mp3');
  const reserved = touch(MUSIC, '.web/old.tmp');
  for (const f of [staleA, staleB, song, reserved]) fs.utimesSync(f, old, old);
  const n = await store.cleanupStaleTemps();
  assert.equal(n, 2);
  assert.equal(fs.existsSync(staleA), false);
  assert.equal(fs.existsSync(staleB), false);
  for (const f of [fresh, song, reserved]) assert.equal(fs.existsSync(f), true, f);
});
