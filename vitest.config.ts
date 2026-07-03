import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // e2e-cli-daemon.spec.ts execs the built dist/bin/bssh-agent.js and
    // requires a prior `npm run build` — run it explicitly via `npm run
    // test:cli`, not the default `npm test`.
    exclude: [...configDefaults.exclude, 'test/e2e-cli-daemon.spec.ts'],
    testTimeout: 15_000,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
