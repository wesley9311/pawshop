'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { expectHttpStatus } = require('../scripts/http-probe.cjs');

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('accepts exact status and rejects unexpected status without exposing body', async t => {
  const url = await listen(t, (req, res) => { res.writeHead(503); res.end('private response'); });
  await expectHttpStatus(url, { status: 503 });
  await assert.rejects(expectHttpStatus(url, { status: 200 }), error => {
    assert.match(error.message, /returned 503; expected 200/);
    assert.doesNotMatch(error.message, /private response/);
    return true;
  });
});

test('a live loopback server that does not respond times out', { timeout: 5000 }, async t => {
  const url = await listen(t, () => {});
  await assert.rejects(expectHttpStatus(url, { status: 200, timeoutMs: 100 }), /exceeded 100ms/);
});

test('does not follow redirects or forward probe credentials', async t => {
  let destinationHits = 0;
  const destination = await listen(t, (req, res) => { destinationHits++; res.end(); });
  const source = await listen(t, (req, res) => { res.writeHead(302, { location: destination }); res.end(); });
  await assert.rejects(expectHttpStatus(source, { status: 200, headers: { 'x-publishable-api-key': 'test-only' } }), /returned 302/);
  assert.equal(destinationHits, 0);
});

test('cancels an unfinished body after checking headers', { timeout: 5000 }, async t => {
  const url = await listen(t, (req, res) => { res.writeHead(200); res.flushHeaders(); });
  await expectHttpStatus(url, { status: 200, timeoutMs: 1000 });
});

test('rejects unbounded timeout configuration', async () => {
  for (const timeoutMs of [0, -1, Infinity, 30001, 1.5]) {
    await assert.rejects(expectHttpStatus('http://127.0.0.1', { status: 200, timeoutMs }), /Probe timeout/);
  }
});

test('accepts a matching refusal type and rejects a different one without exposing the body', async t => {
  const url = await listen(t, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'not_allowed', message: 'private response' }));
  });
  await expectHttpStatus(url, { status: 400, type: 'not_allowed' });
  await assert.rejects(expectHttpStatus(url, { status: 400, type: 'invalid_data' }), error => {
    assert.match(error.message, /returned refusal type not_allowed; expected invalid_data/);
    assert.doesNotMatch(error.message, /private response/);
    return true;
  });
});

test('rejects an unreadable or oversized refusal body', async t => {
  const unreadable = await listen(t, (req, res) => { res.writeHead(400); res.end('not json'); });
  await assert.rejects(expectHttpStatus(unreadable, { status: 400, type: 'not_allowed' }), /unreadable refusal body/);
  const oversized = await listen(t, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'not_allowed', padding: 'x'.repeat(4096) }));
  });
  await assert.rejects(expectHttpStatus(oversized, { status: 400, type: 'not_allowed' }), /exceeded the reviewed bound/);
});
