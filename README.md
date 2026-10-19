# Bicho for Astro

[![npm version](https://img.shields.io/npm/v/@bicho-fyi/astro?color=4de034)](https://www.npmjs.com/package/@bicho-fyi/astro)
[![Astro 6.x and 7.x](https://img.shields.io/badge/Astro-6.x%20%7C%207.x-BC52EE)](https://astro.build/)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](https://nodejs.org/)
[![License Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

Report browser errors and server request exceptions to [Bicho](https://bicho.fyi) from an Astro integration. Enable browser capture on static sites, server reporting on SSR sites, or both with separate projects and public keys.

Supports Astro 6.x and 7.x. Requires Node 24+, matching `@bicho-fyi/javascript` 1.1.0, even if your Astro version supports an older Node release.

## Install

```sh
npm install @bicho-fyi/astro
```

Add the integration to `astro.config.mjs`:

```js
import { defineConfig } from 'astro/config';
import bicho from '@bicho-fyi/astro';

export default defineConfig({
  integrations: [bicho({
    browser: {
      endpoint: 'https://collector.example/v1/logs',
      key: 'BROWSER_PUBLIC_KEY',
    },
    server: {
      endpoint: 'https://collector.example/v1/logs',
      key: 'SERVER_PUBLIC_KEY',
    },
  })],
});
```

Keep your existing adapter and `output` settings for SSR. Static sites only need `browser`. Both modes are disabled unless you supply their options; `false` also disables a mode. Browser and server settings are independent, including endpoint and key. They can report to different projects or collectors.

Use the provisioned OTLP endpoint ending in `/v1/logs` and public `X-Bicho-Key`. HTTPS is required except on loopback. Both projects must accept public-key-only ingestion. The SDK cannot send ingest secrets, including on the server. Do not use a project requiring a backend secret. Browser configuration is public; never put secrets or admin credentials in it.

## Options

| Option | Applies to | Default | Purpose |
| --- | --- | --- | --- |
| `endpoint` | Both | Required | Your project's OTLP endpoint ending in `/v1/logs` |
| `key` | Both | Required | Public ingest key for that project |
| `serviceName` | Both | SDK default | Service name attached to reports |
| `environment` | Both | Unset | Deployment environment |
| `release` | Both | Unset | Application release |
| `autoCapture` | Browser | `true` | Capture uncaught errors and unhandled rejections |
| `closeTimeout` | Server | `2000` | Delivery deadline in milliseconds, from 0 to 10000 |

These are the only supported integration settings. SDK hooks, tags and custom contexts are not serialized from the Astro configuration.

## Browser capture

Astro bundles a page script with Vite for both SSG and SSR. The SDK captures uncaught JavaScript exceptions and unhandled promise rejections after that script initializes. Earlier errors, caught exceptions, `console.error()`, failed HTTP responses and resource failures without JavaScript error data are not captured. This is a module script, not an inline script guaranteed to run before other scripts.

The integration does not expose a global client. For consent-controlled initialization or manual browser reporting, omit `browser` here and initialize `@bicho-fyi/javascript` in your own client entry instead. Avoid initializing both or errors can be reported twice. Browser delivery is best effort, especially during navigation or shutdown. Allow your collector in CSP `connect-src`.

## Server capture

The integration installs pre middleware through Astro's integration API. When `next()` rejects, it reports that original exception with a fresh SDK client, waits for `close(closeTimeout)`, then rethrows the same value. Reporting failures do not replace the application error. Successful responses, including explicit 500/503 responses, pass through untouched and are not reported as exceptions.

Prerendered routes skip reporting. SSG builds therefore do not send server events. An SSR adapter is required for request-time server reporting. The middleware installs no process handlers and does not intercept build errors, errors before it runs or outside the request chain, errors after a streamed response has returned, or errors another handler catches and converts to a response. It does not infer an exception from a 500 status.

Node SSR tests cover Astro 6.0.0 with `@astrojs/node` 10.0.2, Astro 6.4.8 with 10.1.4, Astro 7.0.0/7.1.0/7.2.0 with 11.0.0, and Astro 7.3.1/7.4.0 with 11.1.8. Astro 7.3.0 has an upstream SSR build failure involving `astro/_internal/logger`, reproducible without this integration; use 7.3.1 or later instead. Local Cloudflare SSR tests cover Astro 6.4.8 with `@astrojs/cloudflare` 13.7.0 and Astro 7.4.0 with 14.4.0, both using Wrangler 4.125.0 and workerd 1.20261012.1 through `astro build` and `astro preview`. Use an adapter compatible with your Astro version.

| Failure | Result | Middleware capture |
| --- | --- | --- |
| Page frontmatter throws | 500; custom 500 page receives the original error | Original exception, once |
| Endpoint throws | 500; custom 500 page receives the original error | Original exception, once |
| Downstream middleware throws | 500; custom 500 page receives the original error | Original exception, once |
| Nested Astro component throws during streaming | Node: 200 then terminated body; local Cloudflare preview: 200 with empty body | None |
| Endpoint returns a 503 response | Original status, headers and body | None |
| Prerender throws | Node static build and Cloudflare/Astro 7: build fails; Cloudflare/Astro 6 logs the error but exits successfully | None |

The streamed component failure behaves the same with server capture disabled in each tested runtime. The middleware does not buffer or consume response streams to catch later errors. Report those errors at their source; a custom 500 page cannot recover an already-started stream. Other adapters or rendering paths may expose a different subset of errors to `next()`. Local workerd verification does not establish hosted Cloudflare behavior.

For an error boundary the middleware cannot observe, use the server helper explicitly:

```js
import { reportError } from '@bicho-fyi/astro/server';

await reportError(error, {
  endpoint: 'https://collector.example/v1/logs',
  key: 'SERVER_PUBLIC_KEY',
  closeTimeout: 2000,
});
```

It returns a delivery boolean and does not throw on reporting failure. It creates and closes an isolated client per call. You can call it from your existing `src/pages/500.astro` with `Astro.props.error`, guarded by `!Astro.isPrerendered` and an error-presence check. Only add that fallback for errors your middleware does not already report, or you can duplicate occurrences. The integration does not create or replace your 500 page.

For example, use your 500 page as the reporting boundary instead of the integration middleware (`server: false`):

```astro
---
import { reportError } from '@bicho-fyi/astro/server';

export const prerender = false;

if (!Astro.isPrerendered && Astro.props.error) {
  await reportError(Astro.props.error, {
    endpoint: 'https://collector.example/v1/logs',
    key: 'SERVER_PUBLIC_KEY',
  });
}
---
<h1>Something went wrong</h1>
```

This fallback receives the original page exception. It cannot report failures Astro never routes to the 500 page.

## Privacy and delivery

The integration adds no request metadata: it does not read headers, URL queries, request bodies or cookies. The SDK sends the exception's message and stack, applies its own best-effort filtering, and uses OTLP/HTTP JSON. Error text can still contain application data; avoid putting private data in exception messages. The collector sees the connection's IP and transport headers. Server options stay in server modules, not client bundles.

The SDK has an in-memory queue and bounded retries. A timeout or failed collector can lose an event. Server reporting delays a failed request by up to `closeTimeout` plus local processing time; it does not wait on healthy requests. This package does not upload source maps or provide tracing, replay or crash recovery.

## Development

```sh
npm ci
npm run check
npm test
npm pack
```

Tests use native Node assertions, the Node-adapter and two Cloudflare-adapter combinations above, a packed-and-installed integration and loopback collectors. The Cloudflare checks run the built app in real local workerd through the adapter's official preview command, with remote bindings disabled and local session KV. They verify SSR browser exceptions/rejections, separate browser/server routing, page/endpoint/downstream middleware exceptions, unchanged responses, successful and throwing prerender silence, client-artifact isolation, disabled capture, streaming limits and bounded delivery against a hanging collector. Run them alone after `npm run build` with `node --test test/cloudflare.test.mjs`.

Browser checks use Puppeteer Core with Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; set `CHROME_PATH` to use another installation. Tests install pinned fixture dependencies and write their lockfiles under ignored `_temp/`; they never deploy or send to a hosted collector. Tests run serially because the Node fixtures reset `_temp/`. The npm tarball includes built JavaScript, declarations, this README, the changelog and license. Hosted Cloudflare and other SSR adapters are outside this verification scope.

## License

Copyright 2026 [Alex Zappa](https://alex.zappa.dev/) ([FreshJuice](https://freshjuice.dev/)). Apache-2.0; see [LICENSE](./LICENSE).
