# Changelog

## 1.0.0 (2026-10-19)

### Added

- Add independent, opt-in browser and server reporting for Astro.
- Bundle browser error capture for static and server-rendered pages.
- Report exceptions escaping request middleware with isolated SDK clients and bounded shutdown.
- Provide an explicit server reporting helper without process handlers.
- Support Astro 6.x and 7.4+ with packed-package SSG, browser and Node SSR tests.
- Verify local Cloudflare SSR with packed installs: Astro 6.4.8 / `@astrojs/cloudflare` 13.7.0 and Astro 7.4.0 / 14.4.0, using Wrangler 4.125.0 and workerd 1.20261012.1 through `astro build` / `astro preview`, without deployment or remote bindings.
- Cover browser/server project isolation, SSR exceptions, original responses, prerender silence, client-artifact isolation, disabled capture and bounded collector failures in local workerd.
- Include Astro integration discovery keywords and Utilities categorization.

### Requirements and limits

- Require Node 24+ and use `@bicho-fyi/javascript` 1.1.0.
- Require public-key-only ingestion for browser and server projects.
- Skip server reporting during prerendering and leave explicit error responses unchanged.
- Do not automatically capture errors after a streamed response has returned; report them at their source.
- Local Cloudflare preview returns 200 with an empty body for the tested streamed component failure; Node terminates the body after 200. Neither reports through middleware. Cloudflare/Astro 6 logs a throwing prerender but exits successfully; Cloudflare/Astro 7 fails the build. Neither sends a report during prerender.
- Local workerd tests do not verify hosted Cloudflare deployment.
