'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { clientIp, rateLimitKey, isCloudflareIp, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } = require('../webplayer/clientIp');

// 模擬 express 的 req：ip 是 trust proxy = 1 時取到的值（平台代理看到的上一層）
const req = (ip, headers = {}) => ({
  ip,
  get: (name) => headers[name.toLowerCase()],
});

test('isCloudflareIp：Cloudflare 公布的 IP 段內為 true，其他為 false', () => {
  for (const ip of ['172.68.87.188', '172.64.0.1', '104.16.0.1', '162.159.1.1', '2606:4700::1', '2a06:98c0:3600::103', '::ffff:172.68.87.188']) {
    assert.equal(isCloudflareIp(ip), true, ip);
  }
  for (const ip of ['203.204.184.15', '10.42.0.1', '127.0.0.1', '172.63.255.255', '172.72.0.0', '8.8.8.8', '2001:db8::1', '', 'garbage', undefined]) {
    assert.equal(isCloudflareIp(ip), false, String(ip));
  }
});

test('isCloudflareIp：每個公布的 IP 段的起點都會被認出來（清單格式正確）', () => {
  for (const c of [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]) assert.equal(isCloudflareIp(c.split('/')[0]), true, c);
});

test('clientIp：經過 Cloudflare 時使用 CF-Connecting-IP（正式環境 log 的實際數值）', () => {
  assert.equal(clientIp(req('172.68.87.188', { 'cf-connecting-ip': '203.204.184.15' })), '203.204.184.15');
  assert.equal(clientIp(req('2606:4700::6810:1', { 'cf-connecting-ip': '2001:db8::5' })), '2001:db8::5', 'IPv6');
  assert.equal(clientIp(req('::ffff:172.68.87.188', { 'cf-connecting-ip': ' 203.204.184.15 ' })), '203.204.184.15', 'IPv4-mapped 與空白');
});

test('clientIp：繞過 Cloudflare 直接連線時，忽略可偽造的 CF-Connecting-IP', () => {
  assert.equal(clientIp(req('198.51.100.9', { 'cf-connecting-ip': '1.2.3.4' })), '198.51.100.9');
  assert.equal(clientIp(req('::ffff:198.51.100.9')), '198.51.100.9');
});

test('clientIp：上一層是 Cloudflare 但 CF-Connecting-IP 缺少或不合法時，退回節點 IP', () => {
  assert.equal(clientIp(req('172.68.87.188')), '172.68.87.188');
  assert.equal(clientIp(req('172.68.87.188', { 'cf-connecting-ip': 'not-an-ip' })), '172.68.87.188');
  assert.equal(clientIp(req('172.68.87.188', { 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' })), '172.68.87.188');
});

test('rateLimitKey：IPv4 用完整位址；IPv6 以 /64 為單位（換同網段的位址不能換額度）', () => {
  assert.equal(rateLimitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateLimitKey('::ffff:203.0.113.7'), '203.0.113.7');
  for (const ip of ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::9', '2001:DB8:0001:0002:ffff::1']) {
    assert.equal(rateLimitKey(ip), '2001:db8:1:2::/64', ip);
  }
  assert.notEqual(rateLimitKey('2001:db8:1:3::1'), rateLimitKey('2001:db8:1:2::1'), '不同 /64');
  assert.equal(rateLimitKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
});
