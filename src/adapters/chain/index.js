import { env } from '../../config/env.js';
import { AvalancheChainAdapter } from './avalanche-chain-adapter.js';
import { MockChainAdapter } from './mock-chain-adapter.js';

let adapter;

/**
 * The only entry point to chain code. Modules outside adapters/ never import ethers or ABIs and
 * never learn whether hashes are real (00 §2.2).
 */
export function chainAdapter() {
  adapter ??= createChainAdapter();
  return adapter;
}

export function createChainAdapter(options = {}) {
  if ((options.kind ?? env.CHAIN_ADAPTER) === 'avalanche') return new AvalancheChainAdapter(options);
  return new MockChainAdapter(options);
}

/** Tests and the worker bootstrap inject a configured instance. */
export function setChainAdapter(instance) {
  adapter = instance;
}

export { custodyAddress } from './custody.js';
