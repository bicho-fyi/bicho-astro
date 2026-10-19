import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createMiddleware, reportError } from '../dist/server.js';

test('request errors use the installed SDK and preserve error and response identity', async () => {
  const received = [];
  const collector = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ key: req.headers['x-bicho-key'], body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  try {
    const middleware = createMiddleware({ endpoint: `http://127.0.0.1:${collector.address().port}/v1/logs`, key: 'server_project', closeTimeout: 200 });
    const context = { isPrerendered: false };
    const original = new Error('original failure');
    await assert.rejects(middleware(context, () => { throw original; }), error => error === original);
    assert.equal(received.length, 1);
    assert.equal(received[0].key, 'server_project');
    assert.equal(received[0].body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, 'original failure');
    const response = new Response('unchanged', { status: 503, headers: { 'x-original': 'yes' } });
    assert.equal(await middleware(context, async () => response), response);
    await assert.rejects(middleware({ isPrerendered: true }, () => { throw original; }), error => error === original);
    assert.equal(received.length, 1);
    await Promise.all(['one', 'two', 'three'].map(async key => {
      const handler = createMiddleware({ endpoint: `http://127.0.0.1:${collector.address().port}/v1/logs`, key, closeTimeout: 200 });
      const error = new Error(key);
      await assert.rejects(handler(context, async () => { throw error; }), value => value === error);
    }));
    assert.deepEqual(received.slice(1).map(event => [event.key, event.body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue]).sort(), [['one', 'one'], ['three', 'three'], ['two', 'two']]);
  } finally {
    collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve));
  }
});

test('server reporting bounds shutdown and preserves errors when the collector stalls', async () => {
  const received = [];
  const collector = createServer(async (req) => {
    for await (const chunk of req) {}
    received.push(req.headers['x-bicho-key']);
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const options = { endpoint: `http://127.0.0.1:${collector.address().port}/v1/logs`, key: 'stalled', closeTimeout: 50 };
  try {
    const original = new Error('unchanged during collector failure');
    const start = performance.now();
    await assert.rejects(createMiddleware(options)({ isPrerendered: false }, () => { throw original; }), error => error === original);
    assert.ok(performance.now() - start < 1000);
    assert.deepEqual(received, ['stalled']);
    assert.equal(await reportError(original, { ...options, key: '' }), false);
    assert.equal(await reportError(original, { ...options, closeTimeout: 10001 }), false);
    assert.equal(await reportError(original, { ...options, closeTimeout: -1 }), false);
    assert.equal(await reportError(original, { ...options, closeTimeout: Infinity }), false);
    assert.equal(received.length, 1);
  } finally {
    collector.closeAllConnections();
    await new Promise(resolve => collector.close(resolve));
  }
});
