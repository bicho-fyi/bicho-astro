import assert from 'node:assert/strict';
import { test } from 'node:test';

test('integration defaults off and serializes only explicit browser fields', async () => {
  const { default: bicho } = await import('../dist/index.js');
  const scripts = [];
  const middleware = [];
  const configs = [];
  const setup = options => bicho(options).hooks['astro:config:setup']({
    injectScript: (...args) => scripts.push(args),
    addMiddleware: value => middleware.push(value),
    updateConfig: value => configs.push(value),
  });
  setup();
  assert.equal(scripts.length, 0);
  assert.equal(middleware.length, 0);
  setup({ browser: { endpoint: 'http://127.0.0.1:1234/v1/logs', key: 'browser', secret: 'DO_NOT_SERIALIZE' }, server: { endpoint: 'http://127.0.0.1:5678/v1/logs', key: 'server_only' } });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][0], 'page');
  assert.ok(scripts[0][1].includes('browser'));
  assert.ok(!scripts[0][1].includes('server_only'));
  assert.ok(!scripts[0][1].includes('DO_NOT_SERIALIZE'));
  assert.equal(middleware[0].order, 'pre');
  assert.ok(middleware[0].entrypoint instanceof URL);
  assert.throws(() => setup({ browser: { endpoint: 'https://example.com/v1/logs', key: '' } }));
  assert.throws(() => setup({ server: { endpoint: 'https://example.com/v1/logs', key: 'valid', closeTimeout: Infinity } }));
});
