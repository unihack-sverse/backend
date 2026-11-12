import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../../config/env.js';

const abiDir = path.dirname(fileURLToPath(import.meta.url));

export const CONTRACT_NAMES = [
  'MockSRV',
  'SverseItems',
  'SverseDeedRegistry',
  'SverseStore',
  'SverseMarketplace',
  'SverseRewards',
];

export function loadAbi(name) {
  return JSON.parse(readFileSync(path.join(abiDir, 'abi', `${name}.json`), 'utf8')).abi;
}

/** Addresses come from explicit env vars, falling back to a Hardhat deployment manifest. */
export function resolveDeployment() {
  const manifest = env.AVALANCHE_DEPLOYMENT_FILE
    ? JSON.parse(readFileSync(path.resolve(env.AVALANCHE_DEPLOYMENT_FILE), 'utf8'))
    : { contracts: {} };
  const contracts = {
    MockSRV: env.SRV_TOKEN_ADDRESS ?? manifest.contracts.MockSRV,
    SverseItems: env.SVERSE_ITEMS_ADDRESS ?? manifest.contracts.SverseItems,
    SverseDeedRegistry: env.SVERSE_DEED_REGISTRY_ADDRESS ?? manifest.contracts.SverseDeedRegistry,
    SverseStore: env.SVERSE_STORE_ADDRESS ?? manifest.contracts.SverseStore,
    SverseMarketplace: env.SVERSE_MARKETPLACE_ADDRESS ?? manifest.contracts.SverseMarketplace,
    SverseRewards: env.SVERSE_REWARDS_ADDRESS ?? manifest.contracts.SverseRewards,
  };
  for (const name of ['MockSRV', 'SverseItems', 'SverseDeedRegistry', 'SverseRewards']) {
    if (!contracts[name]) throw new Error(`Avalanche adapter: missing address for ${name}`);
  }
  return {
    contracts,
    startBlock: env.AVALANCHE_START_BLOCK ?? manifest.startBlock ?? 0,
    chainId: manifest.chainId ?? env.AVALANCHE_CHAIN_ID,
  };
}
