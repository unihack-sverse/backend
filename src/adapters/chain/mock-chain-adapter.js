import { createHash } from 'node:crypto';

import { env } from '../../config/env.js';
import { custodyAddress } from './custody.js';
import { chainRef } from './refs.js';

/**
 * Deterministic stand-in for Avalanche. Same op contract as the real adapter; business logic
 * cannot tell them apart (00 §2.2).
 */
export class MockChainAdapter {
  constructor({ latencyMs = env.MOCK_CHAIN_LATENCY_MS } = {}) {
    this.latencyMs = latencyMs;
    this.failNext = new Map();
    this.tokenCounter = 100000;
    this.mintedRefs = new Map();
  }

  get name() {
    return 'mock';
  }

  get chainId() {
    return 0;
  }

  explorerTxUrl() {
    return null;
  }

  async createAccount({ kind, index }) {
    return { address: custodyAddress(kind, index) };
  }

  /** Test hook: make the next submit of `kind` throw. */
  failNextSubmit(kind, error = new Error('mock_chain_failure')) {
    this.failNext.set(kind, error);
  }

  async prepare(op) {
    await this.#latency();
    const failure = this.failNext.get(op.kind);
    if (failure) {
      this.failNext.delete(op.kind);
      throw failure;
    }
    return { txHash: mockHash(op.kind, op.ref), sender: 'mock-relayer', nonce: null, rawTx: null };
  }

  async broadcast() {
    return {};
  }

  async checkReceipt(op) {
    return { state: 'confirmed', blockNumber: 0, result: this.#resultFor(op) };
  }

  async lookupExisting() {
    return null;
  }

  async latestSafeBlock() {
    return 0;
  }

  async fetchLogs() {
    return [];
  }

  async health() {
    return { ok: true, adapter: 'mock', chainId: 0 };
  }

  #resultFor(op) {
    switch (op.kind) {
      case 'mint_item': {
        const definitionId = BigInt(chainRef(op.payload.definition.ref)) % 1_000_000n;
        if (!op.payload.definition.living) {
          return { tokenId: `mock_${definitionId}`, chainDefinitionId: definitionId.toString() };
        }
        if (!this.mintedRefs.has(op.ref)) {
          this.tokenCounter += 1;
          this.mintedRefs.set(op.ref, `mock_${this.tokenCounter}`);
        }
        return { tokenId: this.mintedRefs.get(op.ref), chainDefinitionId: definitionId.toString() };
      }
      case 'record_deed':
        return { chainDeedId: mockHash('deed', op.ref) };
      default:
        return {};
    }
  }

  async #latency() {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function mockHash(kind, ref) {
  return `0xmock_${createHash('sha256').update(`${kind}:${ref}`).digest('hex').slice(0, 40)}`;
}
