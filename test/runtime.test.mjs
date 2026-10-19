import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const fixture = join(root, '_temp/site');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const astroVersion = process.env.BICHO_TEST_ASTRO || '7.4.0';
const adapterVersion = process.env.BICHO_TEST_NODE_ADAPTER || '11.1.8';

async function run(command, args, cwd = root, expected = 0) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, expected, output);
  return output;
}

async function file(path, content) {
  const target = join(fixture, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function collector() {
  const events = [];
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type,x-bicho-key');
    res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/logs');
    let body = '';
    for await (const chunk of req) body += chunk;
    events.push({ key: req.headers['x-bicho-key'], data: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  return { server, events, endpoint: await listen(server) + '/v1/logs' };
}

async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, typeof label === 'function' ? label() : label);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

function record(event) {
  return event.data.resourceLogs[0].scopeLogs[0].logRecords[0];
}

async function config(options, ssr) {
  await file('astro.config.mjs', `import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import bicho from '@bicho-fyi/astro';
export default defineConfig({ output: '${ssr ? 'server' : 'static'}', ${ssr ? "adapter: node({ mode: 'standalone' })," : ''} integrations: [bicho(${JSON.stringify(options)})] });`);
}

async function build(expected = 0) {
  await rm(join(fixture, 'dist'), { recursive: true, force: true });
  return run(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build'], fixture, expected);
}

async function startSSR() {
  const probe = createServer();
  const url = await listen(probe);
  const port = probe.address().port;
  await stop(probe);
  const child = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: fixture, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  await waitFor(async () => {
    assert.equal(child.exitCode, null, output);
    try { return (await fetch(url)).ok; } catch { return false; }
  }, 'SSR server ready');
  return { url, output: () => output, close: async () => { child.kill(); await once(child, 'exit'); } };
}

async function browserErrors(browser, url, events, active) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', message => consoleErrors.push(message.text()));
  page.on('pageerror', error => consoleErrors.push(error.message));
  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    const before = events.length;
    await page.addScriptTag({ content: "setTimeout(() => { throw new Error('browser auto exception'); }, 0); setTimeout(() => { Promise.reject(new Error('browser auto rejection')); }, 0);" });
    if (active) {
      await waitFor(() => events.length === before + 2, () => `browser exception and rejection delivered: ${JSON.stringify(events)}, console: ${consoleErrors.join('; ')}`);
      assert.deepEqual(events.slice(before).map(event => record(event).body.stringValue).sort(), ['browser auto exception', 'browser auto rejection']);
      for (const event of events.slice(before)) {
        assert.equal(event.key, 'browser_project');
        assert.equal(event.data.resourceLogs[0].scopeLogs[0].scope.name, 'bicho.javascript.browser');
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(events.length, before);
    }
  } finally { await page.close(); }
}

test(`packed integration runs in Astro ${astroVersion} SSG and Node SSR with separate projects`, { timeout: 180000 }, async t => {
  await rm(join(root, '_temp'), { recursive: true, force: true });
  await mkdir(fixture, { recursive: true });
  const packOutput = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', '_temp']);
  const [pack] = JSON.parse(packOutput);
  const paths = pack.files.map(file => file.path);
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/middleware.js', 'dist/server.js', 'dist/server.d.ts', 'LICENSE', 'README.md', 'CHANGELOG.md']) assert.ok(paths.includes(path), path);
  assert.ok(paths.every(path => /^(dist\/|README.md$|CHANGELOG.md$|LICENSE$|package.json$)/.test(path)));

  await file('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { '@bicho-fyi/astro': `file:../${pack.filename}`, astro: astroVersion, '@astrojs/node': adapterVersion } }));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
  const installed = JSON.parse(await readFile(join(fixture, 'node_modules/@bicho-fyi/javascript/package.json'), 'utf8'));
  assert.equal(installed.version, '1.1.0');
  assert.equal(await readFile(join(fixture, 'node_modules/@bicho-fyi/astro/LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'));
  await file('typecheck.ts', `import bicho, { type BichoOptions } from '@bicho-fyi/astro';
import { reportError, type ServerOptions } from '@bicho-fyi/astro/server';
const server: ServerOptions = { endpoint: 'http://127.0.0.1:1234/v1/logs', key: 'public_key', closeTimeout: 100 };
const options = { browser: false, server } satisfies BichoOptions;
bicho(options);
const result: Promise<boolean> = reportError(new Error('typecheck only'), server);
void result;`);
  await run(join(root, 'node_modules/.bin/tsc'), ['--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', 'typecheck.ts'], fixture);
  await file('src/pages/index.astro', '<html><head><title>Fixture</title></head><body>working</body></html>');
  await file('src/pages/static.astro', '---\nexport const prerender = true;\n---\n<html><head><title>Static</title></head><body>prerendered</body></html>');
  const client = await collector();
  const backend = await collector();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  try {
    const options = { browser: { endpoint: client.endpoint, key: 'browser_project', secret: 'UNSUPPORTED_SECRET_MUST_NOT_LEAK' }, server: { endpoint: backend.endpoint, key: 'server_project_only', serviceName: 'server-only-service', closeTimeout: 250 } };
    await config(options, false);
    await build();
    assert.equal(client.events.length + backend.events.length, 0, 'no sends during SSG build');
    for (const path of await files(join(fixture, 'dist'))) {
      const text = await readFile(path, 'utf8');
      for (const forbidden of ['server_project_only', 'server-only-service', backend.endpoint, 'UNSUPPORTED_SECRET_MUST_NOT_LEAK']) assert.ok(!text.includes(forbidden), `${forbidden} leaked into ${path}`);
    }
    const staticServer = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://localhost').pathname;
        const target = join(fixture, 'dist', path.endsWith('/') ? path + 'index.html' : path);
        res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
        res.end(await readFile(target));
      } catch { res.writeHead(404).end(); }
    });
    try { await browserErrors(browser, await listen(staticServer), client.events, true); }
    finally { await stop(staticServer); }
    await file('src/pages/page-error.astro', '---\nthrow new Error("page original");\n---');
    assert.match(await build(1), /page original/);
    assert.equal(backend.events.length, 0, 'failed prerender does not send errors');
    await file('src/components/Broken.astro', '---\nthrow new Error("component original");\n---');
    await file('src/pages/component-error.astro', '---\nimport Broken from "../components/Broken.astro";\n---\n<Broken />');
    await file('src/pages/endpoint-error.ts', 'export function GET() { throw new Error("endpoint original"); }');
    await file('src/pages/middleware-error.astro', '<p>not reached</p>');
    await file('src/pages/response.ts', 'export function GET() { return new Response("original response", { status: 503, headers: { "x-original": "yes" } }); }');
    await file('src/middleware.ts', 'export const onRequest = (context, next) => { if (context.routePattern === "/middleware-error") throw new Error("middleware original"); return next(); };');
    await file('src/pages/500.astro', '---\nexport const prerender = false;\n---\n<p id="original">{Astro.props.error?.message ?? "no error"}</p>');
    await config(options, true);
    await build();
    assert.equal(backend.events.length, 0, 'no backend sends during SSR prerender');
    for (const path of await files(join(fixture, 'dist/client'))) {
      const text = await readFile(path, 'utf8');
      for (const forbidden of ['server_project_only', 'server-only-service', backend.endpoint, 'UNSUPPORTED_SECRET_MUST_NOT_LEAK']) assert.ok(!text.includes(forbidden), `${forbidden} leaked into ${path}`);
    }
    let server = await startSSR();
    try {
      await browserErrors(browser, server.url, client.events, true);
      const response = await fetch(server.url + '/response');
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('x-original'), 'yes');
      assert.equal(await response.text(), 'original response');
      assert.equal(backend.events.length, 0, 'a returned 503 is not an exception');
      for (const kind of ['page', 'component', 'endpoint', 'middleware']) {
        const before = backend.events.length;
        const failure = await fetch(server.url + `/${kind}-error?private=query`, { headers: { authorization: 'Bearer sensitive', 'x-private': 'private-header' } });
        if (kind === 'component') {
          assert.equal(failure.status, 200);
          await assert.rejects(failure.text(), /terminated/);
          assert.equal(backend.events.length, before, 'streamed component errors escape middleware reporting');
        } else {
          const html = await failure.text();
          assert.equal(failure.status, 500);
          assert.ok(html.includes(`${kind} original`), `${kind}: ${html}\n${server.output()}`);
          assert.equal(backend.events.length, before + 1, kind);
          assert.equal(record(backend.events.at(-1)).body.stringValue, `${kind} original`);
        }
        t.diagnostic(`${kind}: status ${failure.status}; middleware events: ${backend.events.length - before}`);
      }
      t.diagnostic(JSON.stringify(backend.events.map(event => record(event).body.stringValue)));
      for (const event of backend.events) {
        assert.equal(event.key, 'server_project_only');
        const text = JSON.stringify(event);
        for (const forbidden of ['private=query', 'private-header', 'sensitive']) assert.ok(!text.includes(forbidden));
      }
      assert.equal(client.events.length, 4);
    } finally { await server.close(); }
    await config({ browser: false, server: false }, true);
    await build();
    server = await startSSR();
    try {
      const before = backend.events.length;
      await browserErrors(browser, server.url, client.events, false);
      assert.equal((await fetch(server.url + '/endpoint-error')).status, 500);
      const component = await fetch(server.url + '/component-error');
      assert.equal(component.status, 200);
      await assert.rejects(component.text(), /terminated/);
      assert.equal(backend.events.length, before);
    } finally { await server.close(); }
    await config({ browser: { endpoint: client.endpoint, key: 'browser_project', autoCapture: false } }, true);
    await build();
    server = await startSSR();
    try { await browserErrors(browser, server.url, client.events, false); }
    finally { await server.close(); }
    await file('src/pages/500.astro', `---
import { reportError } from '@bicho-fyi/astro/server';
export const prerender = false;
if (!Astro.isPrerendered && Astro.props.error) await reportError(Astro.props.error, ${JSON.stringify(options.server)});
---
<p id="original">{Astro.props.error?.message ?? 'no error'}</p>`);
    await config({ server: false }, true);
    await build();
    server = await startSSR();
    try {
      const before = backend.events.length;
      const failure = await fetch(server.url + '/page-error');
      assert.equal(failure.status, 500);
      assert.ok((await failure.text()).includes('page original'));
      assert.equal(backend.events.length, before + 1);
      assert.equal(record(backend.events.at(-1)).body.stringValue, 'page original');
      t.diagnostic('Manual 500.astro helper: original page exception delivered with integration server capture disabled');
    } finally { await server.close(); }
    await config(options, true);
    await file('src/pages/leak.astro', '<script>import config from "virtual:bicho/server-options"; console.log(config);</script>');
    assert.match(await build(1), /Bicho server options cannot be imported in the browser/);
    t.diagnostic(`Installable tarball: ${join(root, '_temp', pack.filename)}`);
  } finally {
    await browser.close();
    await stop(client.server);
    await stop(backend.server);
  }
});
