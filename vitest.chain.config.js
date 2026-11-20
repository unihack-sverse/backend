import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// End-to-end against a real EVM: a local Hardhat node running the Sverse contracts.
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/setup/global-setup.js', './tests/setup/hardhat-setup.js'],
    setupFiles: ['./tests/setup/per-file-chain.js'],
    include: ['tests/chain/**/*.test.js'],
    testTimeout: 180_000,
    hookTimeout: 240_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: 'test',
      RUN_JOBS: 'false',
      CHAIN_ADAPTER: 'avalanche',
      AVALANCHE_RPC_URL: 'http://127.0.0.1:8547',
      AVALANCHE_CHAIN_ID: '31337',
      AVALANCHE_CONFIRMATIONS: '1',
      AVALANCHE_DEPLOYMENT_FILE: path.join(os.tmpdir(), 'sverse-chain', 'deployment.json'),
      AVALANCHE_START_BLOCK: '',
      SRV_TOKEN_ADDRESS: '',
      SVERSE_ITEMS_ADDRESS: '',
      SVERSE_DEED_REGISTRY_ADDRESS: '',
      SVERSE_STORE_ADDRESS: '',
      SVERSE_MARKETPLACE_ADDRESS: '',
      SVERSE_REWARDS_ADDRESS: '',
      CUSTODY_MNEMONIC: '',
      // Hardhat account #1 — the relayer. Never a real key.
      RELAYER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      SRV_SETTLEMENT_MODE: 'mint',
      CHAIN_DROPPED_GRACE_MS: '500',
      DISPUTE_WINDOW_DAYS: '30',
      LOG_LEVEL: 'silent',
      COOKIE_DOMAIN: '',
      COOKIE_SECURE: 'false',
      COOKIE_SAMESITE: 'lax',
    },
  },
});
