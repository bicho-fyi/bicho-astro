import type { AstroIntegration } from 'astro';
import { createClient } from '@bicho-fyi/javascript';
import type { Connection, ServerOptions } from './server.js';

export type BrowserOptions = Connection & { autoCapture?: boolean };
export type BichoOptions = { browser?: BrowserOptions | false; server?: ServerOptions | false };

function connection(options: Connection): Connection {
  const { endpoint, key, serviceName, environment, release } = options;
  const result = { endpoint, key, serviceName, environment, release };
  void createClient({ ...result, autoCapture: false }).close(0);
  return result;
}

export default function bicho(options: BichoOptions = {}): AstroIntegration {
  return {
    name: '@bicho-fyi/astro',
    hooks: {
      'astro:config:setup'({ injectScript, addMiddleware, updateConfig }) {
        if (options.browser) {
          const browser = { ...connection(options.browser), autoCapture: options.browser.autoCapture ?? true };
          if (typeof browser.autoCapture !== 'boolean') throw new TypeError('Invalid Bicho autoCapture');
          injectScript('page', `import { createClient } from '@bicho-fyi/javascript'; createClient(${JSON.stringify(browser).replaceAll('<', '\\u003c')});`);
        }
        if (options.server) {
          const server = { ...connection(options.server), closeTimeout: options.server.closeTimeout ?? 2000 };
          if (!Number.isFinite(server.closeTimeout) || server.closeTimeout < 0 || server.closeTimeout > 10000) throw new TypeError('Bicho closeTimeout must be between 0 and 10000 milliseconds');
          updateConfig({ vite: { plugins: [{
            name: 'bicho-server-options',
            resolveId(id) { if (id === 'virtual:bicho/server-options') return '\0' + id; },
            load(id, loadOptions) {
              if (id !== '\0virtual:bicho/server-options') return;
              if (!loadOptions?.ssr) throw new Error('Bicho server options cannot be imported in the browser');
              return `export default ${JSON.stringify(server)};`;
            },
          }] } });
          addMiddleware({ entrypoint: new URL('./middleware.js', import.meta.url), order: 'pre' });
        }
      },
    },
  };
}
