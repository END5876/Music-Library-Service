'use strict';
// logger：request id middleware
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const logger = require('../logger');

let base, server;
const origError = console.error;
test.before(async () => {
  console.error = () => {}; // 500 會記一行存取 log
  const app = express();
  app.use(logger.requestId());
  app.get('/ok', (req, res) => res.json({ id: req.id }));
  app.get('/boom', (req, res) => res.status(500).end());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { console.error = origError; server.close(); });

test('requestId：產生 id 並放在 X-Request-Id', async () => {
  const r = await fetch(base + '/ok');
  const { id } = await r.json();
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(r.headers.get('x-request-id'), id);
});

test('requestId：沿用上游（代理）帶來的合法 id，不合法的就換掉', async () => {
  assert.equal((await fetch(base + '/ok', { headers: { 'x-request-id': 'edge-123.abc' } })).headers.get('x-request-id'), 'edge-123.abc');
  const bad = (await fetch(base + '/ok', { headers: { 'x-request-id': 'a b<script>' } })).headers.get('x-request-id');
  assert.match(bad, /^[0-9a-f]{8}$/);
});

test('requestId：5xx 會記一行含 id 的存取 log', async () => {
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  const r = await fetch(base + '/boom');
  await new Promise((res) => setTimeout(res, 20));
  console.error = () => {};
  const id = r.headers.get('x-request-id');
  assert.ok(lines.some((l) => l.includes(id) && l.includes('GET /boom 500')), lines.join('\n'));
});
