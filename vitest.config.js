import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/setup/global-setup.js'],
    setupFiles: ['./tests/setup/per-file.js'],
    include: ['tests/{unit,integration,invariants}/**/*.test.js'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    sequence: { shuffle: false },
    env: {
      NODE_ENV: 'test',
      MOCK_CHAIN_LATENCY_MS: '0',
      RUN_JOBS: 'false',
      CHAIN_ADAPTER: 'mock',
      LOG_LEVEL: 'silent',
      DISPUTE_WINDOW_DAYS: '30',
    },
  },
});
