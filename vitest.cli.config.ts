import { defineConfig } from 'vitest/config';

// Dedicated config for test/e2e-cli-daemon.spec.ts, which execs the real
// built dist/bin/bssh-agent.js — kept out of vitest.config.ts's `include` so
// the default `npm test` stays build-free. Run via `npm run test:cli`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e-cli-daemon.spec.ts'],
    testTimeout: 20_000,
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
