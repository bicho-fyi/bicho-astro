import { spawnSync } from 'node:child_process';

for (const [astro, adapter] of [['6.0.0', '10.0.2'], ['6.4.8', '10.1.4'], ['7.0.0', '11.0.0'], ['7.1.0', '11.0.0'], ['7.2.0', '11.0.0'], ['7.3.1', '11.1.8']]) {
  const result = spawnSync(process.execPath, ['--test', 'test/runtime.test.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, BICHO_TEST_ASTRO: astro, BICHO_TEST_NODE_ADAPTER: adapter },
    stdio: 'inherit',
    timeout: 240000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
