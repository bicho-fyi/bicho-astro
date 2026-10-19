import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false', CI: 'true' };

async function run(args, cwd) {
  const child = spawn(args[0], args.slice(1), { cwd, env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const [code] = await once(child, 'exit');
  return { code, output };
}

async function file(base, path, text) {
  const target = join(base, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function waitFor(check, label) {
  const deadline = Date.now() + 30000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function files(base) {
  return (await Promise.all((await readdir(base, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(base, entry.name)) : [join(base, entry.name)]))).flat();
}

function message(event) {
  return event.data.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue;
}

async function browserErrors(browser, url, events, active) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle0' });
    const before = events.length;
    await page.addScriptTag({ content: "setTimeout(() => { throw new Error('workerd browser exception'); }, 0); setTimeout(() => Promise.reject(new Error('workerd browser rejection')), 0);" });
    if (active) {
      await waitFor(() => events.length === before + 2, () => JSON.stringify(events));
      assert.deepEqual(events.slice(before).map(message).sort(), ['workerd browser exception', 'workerd browser rejection']);
      for (const event of events.slice(before)) assert.equal(event.key, 'cloudflare_browser');
    } else {
      await new Promise(resolve => setTimeout(resolve, 350));
      assert.equal(events.length, before);
    }
  } finally { await page.close(); }
}

for (const [astro, adapter, wrangler] of [['7.4.0', '14.4.0', '4.125.0'], ['6.4.8', '13.7.0', '4.125.0']]) {
  test(`packed Astro ${astro}, Cloudflare ${adapter}, Wrangler ${wrangler} runs in local workerd`, { timeout: 300000 }, async t => {
    const fixture = join(root, '_temp', `cloudflare-${astro}`);
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    const pack = await run(['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', fixture], root);
    assert.equal(pack.code, 0, pack.output);
    const tarball = JSON.parse(pack.output)[0].filename;
    await file(fixture, 'package.json', JSON.stringify({ private: true, type: 'module', dependencies: { '@bicho-fyi/astro': `file:./${tarball}`, astro, '@astrojs/cloudflare': adapter, wrangler } }));
    const install = await run(['npm', 'install', '--no-audit', '--no-fund'], fixture);
    assert.equal(install.code, 0, install.output);
    const versions = {};
    for (const name of ['astro', '@astrojs/cloudflare', 'wrangler', 'workerd', '@bicho-fyi/javascript']) versions[name] = JSON.parse(await readFile(join(fixture, 'node_modules', name, 'package.json'), 'utf8')).version;
    t.diagnostic(JSON.stringify(versions));
    await file(fixture, 'versions.json', JSON.stringify(versions, null, 2));
    assert.equal(versions['@bicho-fyi/javascript'], '1.1.0');
    await file(fixture, 'wrangler.json', JSON.stringify({ name: 'bicho-local-test', compatibility_date: '2026-10-19', compatibility_flags: ['nodejs_compat'], kv_namespaces: [{ binding: 'SESSION', id: 'local-session', remote: false }] }));
    await file(fixture, 'src/pages/index.astro', '<html><head><title>Workerd</title></head><body>local workerd</body></html>');
    await file(fixture, 'src/pages/runtime.ts', 'export function GET() { return Response.json({ workerd: typeof WebSocketPair === "function" }); }');
    await file(fixture, 'src/pages/static.astro', '---\nexport const prerender = true;\n---\n<p>static local page</p>');
    await file(fixture, 'src/pages/page-error.astro', '---\nthrow new Error("page original");\n---');
    await file(fixture, 'src/components/Broken.astro', '---\nthrow new Error("component original");\n---');
    await file(fixture, 'src/pages/component-error.astro', '---\nimport Broken from "../components/Broken.astro";\n---\n<Broken />');
    await file(fixture, 'src/pages/endpoint-error.ts', 'export function GET() { throw new Error("endpoint original"); }');
    await file(fixture, 'src/pages/middleware-error.astro', '<p>not reached</p>');
    await file(fixture, 'src/pages/response.ts', 'export function GET() { return new Response("original response", { status: 503, headers: { "x-original": "yes" } }); }');
    await file(fixture, 'src/pages/500.astro', '---\nexport const prerender = false;\n---\n<p>{Astro.props.error?.message ?? "no error"}</p>');
    await file(fixture, 'src/middleware.ts', 'export const onRequest = (context, next) => { if (context.routePattern === "/middleware-error") throw new Error("middleware original"); return next(); };');
    const events = [];
    const collect = destination => async (req, res) => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type,x-bicho-key');
      res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
      if (req.method === 'OPTIONS') return res.writeHead(204).end();
      let body = '';
      for await (const chunk of req) body += chunk;
      events.push({ destination, path: req.url, key: req.headers['x-bicho-key'], data: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    };
    const collector = createServer(collect('browser'));
    const backendCollector = createServer(collect('server'));
    const collectorURL = await listen(collector);
    const backendURL = await listen(backendCollector);
    const hanging = createServer(async req => { for await (const chunk of req) void chunk; });
    const hangingURL = await listen(hanging);
    let browser;
    let preview;
    const options = { browser: { endpoint: collectorURL + '/v1/logs', key: 'cloudflare_browser' }, server: { endpoint: backendURL + '/v1/logs', key: 'cloudflare_server_only', serviceName: 'cloudflare-server-only-service', closeTimeout: 200 } };
    async function build(settings, expected = 0) {
      await file(fixture, 'astro.config.mjs', `import { defineConfig } from 'astro/config';\nimport cloudflare from '@astrojs/cloudflare';\nimport bicho from '@bicho-fyi/astro';\nexport default defineConfig({ output: 'server', adapter: cloudflare({ remoteBindings: false, imageService: 'passthrough', inspectorPort: false }), integrations: [bicho(${JSON.stringify(settings)})] });`);
      await rm(join(fixture, 'dist'), { recursive: true, force: true });
      const result = await run([process.execPath, 'node_modules/astro/bin/astro.mjs', 'build'], fixture);
      await file(fixture, 'build.log', result.output);
      assert.equal(result.code, expected, result.output);
      return result.output;
    }
    async function start() {
      const probe = createServer();
      const url = await listen(probe);
      const port = probe.address().port;
      await stop(probe);
      const child = spawn(process.execPath, ['node_modules/astro/bin/astro.mjs', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: fixture, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => output += chunk);
      child.stderr.on('data', chunk => output += chunk);
      preview = { url, close: async () => {
        if (child.exitCode === null) {
          process.kill(-child.pid, 'SIGTERM');
          await once(child, 'exit');
        }
        await file(fixture, 'preview.log', output);
      } };
      await waitFor(async () => {
        assert.equal(child.exitCode, null, output);
        try { return (await fetch(url)).ok; } catch { return false; }
      }, () => output);
      assert.deepEqual(await (await fetch(url + '/runtime')).json(), { workerd: true });
      return preview;
    }
    async function failures(server) {
      const results = [];
      for (const kind of ['page', 'endpoint', 'middleware']) {
        const response = await fetch(server.url + `/${kind}-error?private=query`, { headers: { authorization: 'Bearer sensitive', 'x-private': 'private-header' } });
        const body = await response.text();
        assert.equal(response.status, 500, body);
        assert.ok(body.includes(`${kind} original`), body);
        results.push({ kind, status: response.status, body: body.replace(/<script type="module" src="\/_astro\/page\.[^"]+"><\/script>/g, '') });
      }
      return results;
    }
    try {
      browser = await puppeteer.launch({ executablePath: chrome, headless: true });
      await build(options);
      assert.equal(events.length, 0, 'no sends during workerd prerender');
      for (const path of await files(join(fixture, 'dist/client'))) {
        const text = await readFile(path, 'utf8');
        for (const forbidden of ['cloudflare_server_only', 'cloudflare-server-only-service', options.server.endpoint]) assert.ok(!text.includes(forbidden), `${forbidden}: ${path}`);
      }
      const server = await start();
      await browserErrors(browser, server.url, events, true);
      const original = await fetch(server.url + '/response');
      assert.equal(original.status, 503);
      assert.equal(original.headers.get('x-original'), 'yes');
      assert.equal(await original.text(), 'original response');
      assert.equal(events.length, 2);
      const enabled = await failures(server);
      const backend = events.filter(event => event.key === 'cloudflare_server_only');
      assert.deepEqual(backend.map(message), ['page original', 'endpoint original', 'middleware original']);
      for (const event of events) {
        assert.equal(event.path, '/v1/logs');
        assert.equal(event.destination, event.key === 'cloudflare_browser' ? 'browser' : 'server');
        for (const forbidden of ['private=query', 'private-header', 'sensitive']) assert.ok(!JSON.stringify(event).includes(forbidden));
      }
      const streamed = await fetch(server.url + '/component-error');
      const streamResult = await streamed.text().then(body => ({ body }), error => ({ error: error.message }));
      assert.equal(streamed.status, 200);
      assert.deepEqual(streamResult, { body: '' });
      assert.equal(events.length, 5, 'streamed component error is outside middleware');
      t.diagnostic(`streamed component: ${streamed.status} ${JSON.stringify(streamResult)}`);
      await server.close();
      await build({ browser: false, server: false });
      assert.equal(events.length, 5);
      const disabled = await start();
      await browserErrors(browser, disabled.url, events, false);
      assert.deepEqual(await failures(disabled), enabled, 'original error responses preserved');
      const disabledStream = await fetch(disabled.url + '/component-error');
      assert.equal(disabledStream.status, streamed.status);
      assert.deepEqual(await disabledStream.text().then(body => ({ body }), error => ({ error: error.message })), streamResult);
      assert.equal(events.length, 5);
      await disabled.close();
      await build({ server: { ...options.server, endpoint: hangingURL + '/v1/logs', closeTimeout: 100 } });
      const failing = await start();
      const before = Date.now();
      assert.deepEqual(await failures(failing), enabled);
      assert.ok(Date.now() - before < 3000, 'hanging collector cannot replace or indefinitely delay application errors');
      t.diagnostic(`three hanging-collector failures completed in ${Date.now() - before}ms`);
      await failing.close();
      await file(fixture, 'src/pages/failed-static.astro', '---\nexport const prerender = true;\nthrow new Error("failed workerd prerender");\n---');
      assert.match(await build(options, astro === '6.4.8' ? 0 : 1), /failed workerd prerender/);
      t.diagnostic(`throwing prerender: build exit ${astro === '6.4.8' ? 0 : 1}; no reports`);
      assert.equal(events.length, 5, 'failed prerender does not report');
      await file(fixture, 'failed-prerender.log', await readFile(join(fixture, 'build.log'), 'utf8'));
      await rm(join(fixture, 'src/pages/failed-static.astro'));
      await build(options);
      await file(fixture, 'events.json', JSON.stringify(events, null, 2));
      t.diagnostic(`Fixture and installed tarball: ${fixture}`);
    } finally {
      await preview?.close();
      await browser?.close();
      await stop(collector);
      await stop(backendCollector);
      await stop(hanging);
    }
  });
}
