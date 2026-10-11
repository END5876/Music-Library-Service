'use strict';
// webplayer/clientIp.js
// ─────────────────────────────────────────────────────────────
// 取得「真正的使用者 IP」，給登入限流使用。
//
// 正式環境的連線路徑（2026-10 以 log 實測）：
//   瀏覽器 → Cloudflare → 部署平台代理（10.42.0.1）→ Node
//   X-Forwarded-For: <使用者>, <Cloudflare 節點>     ← 平台代理在最右邊追加它看到的來源
//   CF-Connecting-IP: <使用者>
//
// app 的 trust proxy = 1（只信任平台代理），所以 req.ip 是「平台代理看到的上一層」：
//   - 上一層是 Cloudflare 節點 → 改用 CF-Connecting-IP（Cloudflare 自己設定，使用者無法偽造）
//   - 上一層不是 Cloudflare（有人繞過 Cloudflare 直接連平台）→ 直接用 req.ip；
//     這時 CF-Connecting-IP / X-Forwarded-For 都可能是偽造的，一律不採信
//
// 為什麼不直接把 Cloudflare 加進 trust proxy、改用 X-Forwarded-For 往前一格：
//   任何人都能用 Cloudflare Workers 從 Cloudflare 的 IP 發請求並自填 X-Forwarded-For；
//   CF-Connecting-IP 則由 Cloudflare 覆寫（Workers 發出的請求會是固定位址），偽造不了。
//
// 之後不再使用 Cloudflare 也不必改程式：上一層不是 Cloudflare 時自動退回 req.ip。

const net = require('net');

// 來源：https://www.cloudflare.com/ips-v4 、https://www.cloudflare.com/ips-v6（2026-10-11 取得）
// Cloudflare 很少變動這份清單；若有新增，漏掉的節點只會退回以節點 IP 計算限流，不會造成安全問題。
const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new net.BlockList();
for (const c of CLOUDFLARE_IPV4) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv4'); }
for (const c of CLOUDFLARE_IPV6) { const [a, p] = c.split('/'); cloudflare.addSubnet(a, Number(p), 'ipv6'); }

// '::ffff:1.2.3.4'（IPv4-mapped IPv6）→ '1.2.3.4'；不是合法 IP 時回傳 null
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

function isCloudflareIp(raw) {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  return cloudflare.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

function clientIp(req) {
  const hop = req.ip;
  if (isCloudflareIp(hop)) {
    const cf = normalizeIp(req.get('cf-connecting-ip'));
    if (cf) return cf;
  }
  return normalizeIp(hop) || hop;
}

module.exports = { clientIp, isCloudflareIp, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 };
