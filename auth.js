'use strict';
// auth.js
// 音樂庫服務的簡單金鑰驗證。
//
// 這個服務預期只透過Private Networking（同一個 Project 內的
// xxx.internal）被各個 Bot 服務呼叫，本來就不會曝露在公網上，
// 但仍建議設定 MUSIC_LIB_SECRET，避免同專案內其他服務、或設定失誤時
// 被誤用。
function createLibraryKeyMiddleware(secret) {
  return function libraryKeyMiddleware(req, res, next) {
    if (!secret) return next(); // 未設定金鑰時不驗證（僅建議在完全信任的內網環境這樣用）
    const provided = req.get('x-music-lib-key');
    if (provided !== secret) {
      return res.status(401).json({ error: '缺少或錯誤的音樂庫金鑰' });
    }
    next();
  };
}

module.exports = { createLibraryKeyMiddleware };
