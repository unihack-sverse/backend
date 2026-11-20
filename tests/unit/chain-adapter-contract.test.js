import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AvalancheChainAdapter } from '../../src/adapters/chain/avalanche-chain-adapter.js';
import { MockChainAdapter } from '../../src/adapters/chain/mock-chain-adapter.js';
import { chainAdapter, setChainAdapter } from '../../src/adapters/chain/index.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { chainService } from '../../src/modules/chain/services/chain.service.js';

const TEST_RELAYER_KEY = `0x${'11'.repeat(32)}`;
const TEST_DEPLOYMENT = {
  contracts: {
    SverseItems: `0x${'1'.repeat(40)}`,
    SverseDeedRegistry: `0x${'2'.repeat(40)}`,
    SverseRewards: `0x${'3'.repeat(40)}`,
    MockSRV: `0x${'4'.repeat(40)}`,
  },
};

function makeMintOp(ref = 'mint:ord_contract_1', living = true) {
  return {
    kind: 'mint_item',
    ref,
    txHash: `0x${'a'.repeat(64)}`,
    payload: {
      to: `0x${'9'.repeat(40)}`,
      amount: 1,
      definition: {
        ref: 'def:itd_contract_1',
        studioRef: 'studio:std_1',
        gameRef: 'game:gam_1',
        studioWallet: `0x${'8'.repeat(40)}`,
        living,
      },
    },
  };
}

function makeDeedOp(ref = 'deed:ded_contract_1') {
  return {
    kind: 'record_deed',
    ref,
    txHash: `0x${'b'.repeat(64)}`,
    payload: {
      tokenId: '42',
      deedType: 'achievement',
      payloadHash: `sha256:${'c'.repeat(64)}`,
      payloadUri: 'https://example.com/deed.json',
      studioCustodyIndex: 0,
      witness: true,
    },
  };
}

function createOfflineAvalancheAdapter({ confirmations = 2 } = {}) {
  const adapter = new AvalancheChainAdapter({
    rpcUrl: 'http://127.0.0.1:8545',
    chainId: 43113,
    relayerKey: TEST_RELAYER_KEY,
    deployment: TEST_DEPLOYMENT,
    confirmations,
  });

  vi.spyOn(adapter.provider, 'getBlockNumber').mockResolvedValue(100);
  vi.spyOn(adapter.provider, 'getTransactionReceipt').mockResolvedValue({ status: 1, blockNumber: 98, logs: [] });
  vi.spyOn(adapter.provider, 'getTransaction').mockResolvedValue(null);
  vi.spyOn(adapter.provider, 'getFeeData').mockResolvedValue({ maxFeePerGas: 25_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  vi.spyOn(adapter.provider, 'estimateGas').mockResolvedValue(100_000n);
  vi.spyOn(adapter.provider, 'getTransactionCount').mockResolvedValue(7);
  vi.spyOn(adapter.provider, 'broadcastTransaction').mockResolvedValue({ hash: `0x${'d'.repeat(64)}` });
  vi.spyOn(adapter.provider, 'getLogs').mockResolvedValue([]);

  const realItems = adapter.contracts.SverseItems;
  const realDeeds = adapter.contracts.SverseDeedRegistry;
  const realRewards = adapter.contracts.SverseRewards;
  const realToken = adapter.contracts.MockSRV;

  adapter.contracts.SverseItems = {
    target: realItems.target,
    interface: realItems.interface,
    getAddress: vi.fn().mockResolvedValue(TEST_DEPLOYMENT.contracts.SverseItems),
    mintRefs: vi.fn().mockResolvedValue(0n),
    definitionRefs: vi.fn().mockResolvedValue(123n),
    mintWithRef: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.SverseItems,
        data: '0x1234',
      }),
    },
  };

  adapter.contracts.SverseDeedRegistry = {
    target: realDeeds.target,
    interface: realDeeds.interface,
    getAddress: vi.fn().mockResolvedValue(TEST_DEPLOYMENT.contracts.SverseDeedRegistry),
    usedNonces: vi.fn().mockResolvedValue(false),
    recordDeed: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.SverseDeedRegistry,
        data: '0x5678',
      }),
    },
  };

  adapter.contracts.SverseRewards = {
    target: realRewards.target,
    interface: realRewards.interface,
    getAddress: vi.fn().mockResolvedValue(TEST_DEPLOYMENT.contracts.SverseRewards),
    epochs: vi.fn().mockResolvedValue({ merkleRoot: `0x${'0'.repeat(64)}` }),
    publishEpoch: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.SverseRewards,
        data: '0x9abc',
      }),
    },
  };

  adapter.contracts.MockSRV = {
    target: realToken.target,
    interface: realToken.interface,
    balanceOf: vi.fn().mockResolvedValue(0n),
    allowance: vi.fn().mockResolvedValue(0n),
    mint: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.MockSRV,
        data: '0x0001',
      }),
    },
    approve: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.MockSRV,
        data: '0x0002',
      }),
    },
    transfer: {
      populateTransaction: vi.fn().mockResolvedValue({
        to: TEST_DEPLOYMENT.contracts.MockSRV,
        data: '0x0003',
      }),
    },
  };

  return adapter;
}

describe.each([
  { label: 'MockChainAdapter', create: () => new MockChainAdapter({ latencyMs: 0 }) },
  { label: 'AvalancheChainAdapter (offline)', create: () => createOfflineAvalancheAdapter() },
])('chain adapter contract — $label', ({ create }) => {
  it('exposes the full adapter surface', () => {
    const adapter = create();
    expect(typeof adapter.name).toBe('string');
    expect(typeof adapter.chainId).toBe('number');
    for (const method of ['explorerTxUrl', 'createAccount', 'prepare', 'broadcast', 'checkReceipt', 'lookupExisting', 'latestSafeBlock', 'fetchLogs', 'health']) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  it('derives deterministic custody accounts', async () => {
    const adapter = create();
    const first = await adapter.createAccount({ kind: 'user', index: 5 });
    const second = await adapter.createAccount({ kind: 'user', index: 5 });
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.address).toBe(second.address);
  });

  it('prepares mint_item and record_deed ops and checks confirmed receipts', async () => {
    const adapter = create();
    const mintOp = makeMintOp();
    const preparedMint = await adapter.prepare(mintOp);
    expect(preparedMint.txHash).toBeTruthy();
    expect(preparedMint.sender).toBeTruthy();

    const mintReceipt = await adapter.checkReceipt({ ...mintOp, txHash: preparedMint.txHash });
    expect(mintReceipt.state).toBe('confirmed');
    expect(mintReceipt.result).toBeTypeOf('object');

    const deedOp = makeDeedOp();
    const preparedDeed = await adapter.prepare(deedOp);
    expect(preparedDeed.txHash).toBeTruthy();

    const deedReceipt = await adapter.checkReceipt({ ...deedOp, txHash: preparedDeed.txHash });
    expect(deedReceipt.state).toBe('confirmed');
    expect(deedReceipt.result).toBeTypeOf('object');
  });

  it('returns null from lookupExisting for unknown op kinds', async () => {
    const adapter = create();
    await expect(adapter.lookupExisting({ kind: 'payout', ref: 'pay:1', payload: {} })).resolves.toBeNull();
  });

  it('returns safe block and empty logs when idle', async () => {
    const adapter = create();
    expect(await adapter.latestSafeBlock()).toBeGreaterThanOrEqual(0);
    expect(await adapter.fetchLogs(0, 10)).toEqual([]);
  });
});

describe('MockChainAdapter contract extensions', () => {
  it('supports fail-once retry via failNextSubmit', async () => {
    const adapter = new MockChainAdapter({ latencyMs: 0 });
    const op = makeMintOp('mint:ord_retry_1');
    adapter.failNextSubmit('mint_item', new Error('transient_rpc_error'));
    await expect(adapter.prepare(op)).rejects.toThrow('transient_rpc_error');
    const prepared = await adapter.prepare(op);
    expect(prepared.txHash).toBeTruthy();
  });

  it('assigns deterministic tokenIds for non-living and unique ones for living items', async () => {
    const adapter = new MockChainAdapter({ latencyMs: 0 });
    const nonLiving = await adapter.checkReceipt(makeMintOp('mint:ord_nl_1', false));
    const nonLiving2 = await adapter.checkReceipt(makeMintOp('mint:ord_nl_2', false));
    expect(nonLiving.result.tokenId).toBe(nonLiving2.result.tokenId);

    const living1 = await adapter.checkReceipt(makeMintOp('mint:ord_liv_1', true));
    const living2 = await adapter.checkReceipt(makeMintOp('mint:ord_liv_2', true));
    expect(living1.result.tokenId).not.toBe(living2.result.tokenId);
  });
});

describe('AvalancheChainAdapter offline state transitions', () => {
  it('reports pending, dropped, reverted, and lookup-recovered receipts', async () => {
    const adapter = createOfflineAvalancheAdapter({ confirmations: 3 });
    const op = makeMintOp();

    // Pending in mempool (no receipt yet, tx still pending)
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
    adapter.provider.getTransaction.mockResolvedValueOnce({ hash: op.txHash });
    expect(await adapter.checkReceipt(op)).toEqual({ state: 'pending' });

    // Dropped (no receipt, not in mempool, not on-chain)
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
    adapter.provider.getTransaction.mockResolvedValueOnce(null);
    expect(await adapter.checkReceipt(op)).toEqual({ state: 'dropped' });

    // Insufficient confirmations -> pending
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 99, logs: [] });
    adapter.provider.getBlockNumber.mockResolvedValueOnce(100);
    expect(await adapter.checkReceipt(op)).toEqual({ state: 'pending', blockNumber: 99 });

    // Reverted on-chain and not recovered via lookupExisting
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 0, blockNumber: 95, logs: [] });
    adapter.provider.getBlockNumber.mockResolvedValueOnce(100);
    expect(await adapter.checkReceipt(op)).toEqual({ state: 'reverted', blockNumber: 95 });

    // Reverted txHash but effect already landed on-chain (replaced tx) -> confirmed
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 0, blockNumber: 95, logs: [] });
    adapter.provider.getBlockNumber.mockResolvedValueOnce(100);
    adapter.contracts.SverseItems.mintRefs.mockResolvedValueOnce(777n);
    expect(await adapter.checkReceipt(op)).toEqual({
      state: 'confirmed',
      blockNumber: 95,
      result: { tokenId: '777', chainDefinitionId: '123' },
    });
  });

  it('handles duplicate and nonce-consumed broadcast errors idempotently', async () => {
    const adapter = createOfflineAvalancheAdapter();
    const rawTx = '0x02f8';

    adapter.provider.broadcastTransaction.mockRejectedValueOnce(new Error('already known'));
    const dup = await adapter.broadcast(rawTx);
    expect(dup.duplicate).toBe(true);
    expect(dup.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    adapter.provider.broadcastTransaction.mockRejectedValueOnce(new Error('nonce too low'));
    const nonceErr = await adapter.broadcast(rawTx);
    expect(nonceErr.duplicate).toBe(true);
    expect(nonceErr.nonceConsumed).toBe(true);
  });

  it('rejects unsupported op.kind in prepare and short-circuits alreadyDone ops', async () => {
    const adapter = createOfflineAvalancheAdapter();
    await expect(adapter.prepare({ kind: 'unknown_op', ref: 'x', payload: {} })).rejects.toThrow('Unsupported chain op kind: unknown_op');

    adapter.contracts.SverseItems.mintRefs.mockResolvedValueOnce(888n);
    const res = await adapter.prepare(makeMintOp());
    expect(res).toEqual({ alreadyDone: true, result: { tokenId: '888', chainDefinitionId: '123' } });
  });

  it('rolls back only the failed nonce in localNonces when estimateGas fails after prerequisite txs', async () => {
    const adapter = createOfflineAvalancheAdapter();
    vi.spyOn(adapter.provider, 'waitForTransaction').mockResolvedValue({ status: 1, blockNumber: 98, logs: [] });
    // RPC pending nonce stays stale at 7 even after 2 prerequisite txs advance localNonces to 9.
    adapter.provider.getTransactionCount.mockResolvedValue(7);
    adapter.provider.estimateGas
      .mockResolvedValueOnce(50_000n)
      .mockResolvedValueOnce(50_000n)
      .mockRejectedValueOnce(new Error('estimate_gas_failed'));

    const epochOp = {
      kind: 'publish_epoch',
      ref: 'epoch:1',
      payload: {
        epochNumber: 1,
        root: `0x${'f'.repeat(64)}`,
        totalUnits: '1000',
        claimDeadline: new Date(Date.now() + 86_400_000).toISOString(),
      },
    };

    await expect(adapter.prepare(epochOp)).rejects.toThrow('estimate_gas_failed');
    expect(adapter.localNonces.get(adapter.relayerAddress)).toBe(9);

    // Subsequent prepare uses nonce 9 (not 7) and advances to 10.
    adapter.contracts.MockSRV.balanceOf.mockResolvedValueOnce(1000n);
    adapter.contracts.MockSRV.allowance.mockResolvedValueOnce(1000n);
    const prepared = await adapter.prepare(epochOp);
    expect(prepared.nonce).toBe(9);
    expect(adapter.localNonces.get(adapter.relayerAddress)).toBe(10);
  });

  it('recovers already-confirmed payout hashes from op.txHashes in checkReceipt and prepare without re-signing', async () => {
    const adapter = createOfflineAvalancheAdapter({ confirmations: 2 });
    const oldHash = `0x${'1'.repeat(64)}`;
    const newHash = `0x${'2'.repeat(64)}`;
    const payoutOp = {
      kind: 'payout',
      ref: 'payout:wd_recover_1',
      txHash: newHash,
      txHashes: [oldHash, newHash],
      payload: {
        to: `0x${'9'.repeat(40)}`,
        amountUnits: '5000',
      },
    };

    // checkReceipt: current txHash is missing, prior hash in txHashes is mined & confirmed.
    adapter.provider.getTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 1, blockNumber: 98, logs: [] });
    adapter.provider.getTransaction.mockResolvedValueOnce(null);
    expect(await adapter.checkReceipt(payoutOp)).toEqual({
      state: 'confirmed',
      blockNumber: 98,
      txHash: oldHash,
      result: {},
    });

    // prepare: lookupExisting detects oldHash in txHashes and short-circuits without signing.
    adapter.provider.getTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 1, blockNumber: 98, logs: [] });
    const prepared = await adapter.prepare(payoutOp);
    expect(prepared).toEqual({ alreadyDone: true, result: { txHash: oldHash } });
    expect(adapter.contracts.MockSRV.mint.populateTransaction).not.toHaveBeenCalled();
    expect(adapter.contracts.MockSRV.transfer.populateTransaction).not.toHaveBeenCalled();
    expect(adapter.provider.estimateGas).not.toHaveBeenCalled();
  });

  it('does not auto-resign or trigger onFailed reversal when payout reconcile receives nonceConsumed', async () => {
    const previous = chainAdapter();
    const adapter = createOfflineAvalancheAdapter();
    const onFailed = vi.fn();
    chainService.registerHandler('payout', { onCompleted: vi.fn(), onFailed });
    setChainAdapter(adapter);

    const txHash = `0x${'e'.repeat(64)}`;
    const refId = new mongoose.Types.ObjectId();
    const op = await ChainOpModel.create({
      pid: `cop_payout_nc_${Date.now()}`,
      kind: 'payout',
      adapter: 'avalanche',
      ref: `payout:nc_${refId.toString()}`,
      refType: 'withdrawal',
      refId,
      payload: { to: `0x${'9'.repeat(40)}`, amountUnits: '1000' },
      status: 'submitted',
      txHash,
      txHashes: [txHash],
      sender: adapter.relayerAddress,
      nonce: 7,
      rawTx: '0x02f8deadbeef',
      submittedAt: new Date(Date.now() - 10 * 60_000),
    });

    try {
      adapter.provider.getTransactionReceipt.mockResolvedValue(null);
      adapter.provider.getTransaction.mockResolvedValue(null);
      adapter.provider.broadcastTransaction.mockRejectedValueOnce(new Error('nonce too low'));
      const prepareSpy = vi.spyOn(adapter, 'prepare');

      await chainService.reconcileSubmitted();

      const updated = await ChainOpModel.findById(op._id).select('+rawTx').lean();
      expect(updated.status).toBe('failed');
      expect(updated.lastError).toBe('payout_nonce_consumed_manual_reconcile');
      expect(updated.rawTx).toBe('0x02f8deadbeef');
      expect(updated.nonce).toBe(7);
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(onFailed).not.toHaveBeenCalled();
    } finally {
      setChainAdapter(previous);
      await ChainOpModel.deleteOne({ _id: op._id });
    }
  });

  it('keeps payout submitted with original rawTx/nonce on rebroadcast timeout, then rebroadcasts same rawTx and confirms', async () => {
    const previous = chainAdapter();
    const adapter = createOfflineAvalancheAdapter({ confirmations: 2 });
    const onCompleted = vi.fn();
    const onFailed = vi.fn();
    chainService.registerHandler('payout', { onCompleted, onFailed });
    setChainAdapter(adapter);

    const txHash = `0x${'3'.repeat(64)}`;
    const rawTx = '0x02f8payoutrebroadcast';
    const refId = new mongoose.Types.ObjectId();
    const op = await ChainOpModel.create({
      pid: `cop_payout_reb_${Date.now()}`,
      kind: 'payout',
      adapter: 'avalanche',
      ref: `payout:reb_${refId.toString()}`,
      refType: 'withdrawal',
      refId,
      payload: { to: `0x${'9'.repeat(40)}`, amountUnits: '2500' },
      status: 'submitted',
      txHash,
      txHashes: [txHash],
      sender: adapter.relayerAddress,
      nonce: 11,
      rawTx,
      submittedAt: new Date(Date.now() - 10 * 60_000),
    });

    try {
      const prepareSpy = vi.spyOn(adapter, 'prepare');
      const broadcastSpy = vi.spyOn(adapter, 'broadcast');

      // 1st reconcile: tx appears dropped and rebroadcast times out -> stay submitted, preserve rawTx/nonce/txHash.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
      adapter.provider.getTransaction.mockResolvedValueOnce(null);
      adapter.provider.broadcastTransaction.mockRejectedValueOnce(new Error('ETIMEDOUT'));

      await chainService.reconcileSubmitted();

      const afterTimeout = await ChainOpModel.findById(op._id).select('+rawTx').lean();
      expect(afterTimeout.status).toBe('submitted');
      expect(afterTimeout.rawTx).toBe(rawTx);
      expect(afterTimeout.nonce).toBe(11);
      expect(afterTimeout.txHash).toBe(txHash);
      expect(afterTimeout.lastError).toContain('ETIMEDOUT');
      expect(prepareSpy).not.toHaveBeenCalled();

      // dispatchDue must not pick up the op or sign a second tx.
      await chainService.dispatchDue();
      expect(prepareSpy).not.toHaveBeenCalled();

      // 2nd reconcile: rebroadcasts the exact same rawTx successfully.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
      adapter.provider.getTransaction.mockResolvedValueOnce(null);
      adapter.provider.broadcastTransaction.mockResolvedValueOnce({ hash: txHash });

      await chainService.reconcileSubmitted();
      expect(broadcastSpy).toHaveBeenCalledTimes(2);
      expect(broadcastSpy).toHaveBeenNthCalledWith(1, rawTx);
      expect(broadcastSpy).toHaveBeenNthCalledWith(2, rawTx);
      expect(prepareSpy).not.toHaveBeenCalled();

      // 3rd reconcile: original txHash confirms.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 98, logs: [] });

      await chainService.reconcileSubmitted();

      const confirmed = await ChainOpModel.findById(op._id).select('+rawTx').lean();
      expect(confirmed.status).toBe('completed');
      expect(confirmed.txHash).toBe(txHash);
      expect(confirmed.nonce).toBe(11);
      expect(confirmed.rawTx).toBe(rawTx);
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
      expect(prepareSpy).not.toHaveBeenCalled();
    } finally {
      setChainAdapter(previous);
      await ChainOpModel.deleteOne({ _id: op._id });
    }
  });

  it('keeps payout submitted when broadcast fails after persist in processOp, never re-signs, and confirms on reconcile', async () => {
    const previous = chainAdapter();
    const adapter = createOfflineAvalancheAdapter({ confirmations: 2 });
    const onCompleted = vi.fn();
    const onFailed = vi.fn();
    chainService.registerHandler('payout', { onCompleted, onFailed });
    setChainAdapter(adapter);

    const refId = new mongoose.Types.ObjectId();
    const op = await ChainOpModel.create({
      pid: `cop_payout_bc_${Date.now()}`,
      kind: 'payout',
      adapter: 'avalanche',
      ref: `payout:bc_${refId.toString()}`,
      refType: 'withdrawal',
      refId,
      payload: { to: `0x${'9'.repeat(40)}`, amountUnits: '3000' },
      status: 'created',
    });

    try {
      const prepareSpy = vi.spyOn(adapter, 'prepare');
      const broadcastSpy = vi.spyOn(adapter, 'broadcast');

      // Initial broadcast after persisting submitted times out.
      adapter.provider.broadcastTransaction.mockRejectedValueOnce(new Error('rpc_broadcast_timeout'));

      await chainService.dispatchDue();

      const afterBroadcastErr = await ChainOpModel.findById(op._id).select('+rawTx').lean();
      expect(afterBroadcastErr.status).toBe('submitted');
      expect(afterBroadcastErr.rawTx).toBeTruthy();
      expect(afterBroadcastErr.nonce).toBe(7);
      expect(afterBroadcastErr.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(afterBroadcastErr.lastError).toContain('rpc_broadcast_timeout');
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledTimes(1);

      // Subsequent dispatchDue must not create a second tx.
      await chainService.dispatchDue();
      expect(prepareSpy).toHaveBeenCalledTimes(1);

      // Move submittedAt past dropped grace period so reconcile rebroadcasts the same rawTx.
      await ChainOpModel.updateOne(
        { _id: op._id },
        { $set: { submittedAt: new Date(Date.now() - 10 * 60_000) } },
      );
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
      adapter.provider.getTransaction.mockResolvedValueOnce(null);
      adapter.provider.broadcastTransaction.mockResolvedValueOnce({ hash: afterBroadcastErr.txHash });

      await chainService.reconcileSubmitted();
      expect(broadcastSpy).toHaveBeenCalledTimes(2);
      expect(broadcastSpy).toHaveBeenNthCalledWith(2, afterBroadcastErr.rawTx);
      expect(prepareSpy).toHaveBeenCalledTimes(1);

      // Next reconcile confirms the original txHash.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 98, logs: [] });

      await chainService.reconcileSubmitted();

      const finalOp = await ChainOpModel.findById(op._id).select('+rawTx').lean();
      expect(finalOp.status).toBe('completed');
      expect(finalOp.txHash).toBe(afterBroadcastErr.txHash);
      expect(finalOp.txHashes).toEqual([afterBroadcastErr.txHash]);
      expect(finalOp.nonce).toBe(7);
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(onFailed).not.toHaveBeenCalled();
      expect(prepareSpy).toHaveBeenCalledTimes(1);
    } finally {
      setChainAdapter(previous);
      await ChainOpModel.deleteOne({ _id: op._id });
    }
  });

  it('returns pending without signing a second tx when a prior payout tx is pending (mined < confirmations or in mempool)', async () => {
    const previous = chainAdapter();
    const adapter = createOfflineAvalancheAdapter({ confirmations: 3 });
    const onCompleted = vi.fn();
    chainService.registerHandler('payout', { onCompleted, onFailed: vi.fn() });
    setChainAdapter(adapter);

    const oldHash = `0x${'5'.repeat(64)}`;
    const payoutOp = {
      kind: 'payout',
      ref: 'payout:wd_pending_check',
      txHash: null,
      txHashes: [oldHash],
      payload: { to: `0x${'9'.repeat(40)}`, amountUnits: '5000' },
    };

    // 1. Mined with insufficient confirmations (100 - 99 + 1 = 2 < 3)
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 99, logs: [] });
    expect(await adapter.lookupExisting(payoutOp)).toEqual({
      pending: true,
      txHash: oldHash,
      blockNumber: 99,
    });

    adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 99, logs: [] });
    expect(await adapter.prepare(payoutOp)).toEqual({
      pending: true,
      txHash: oldHash,
      blockNumber: 99,
    });

    // 2. Pending in mempool (receipt null, getTransaction returns tx)
    adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
    adapter.provider.getTransaction.mockResolvedValueOnce({ hash: oldHash });
    expect(await adapter.lookupExisting(payoutOp)).toEqual({
      pending: true,
      txHash: oldHash,
      blockNumber: null,
    });

    adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
    adapter.provider.getTransaction.mockResolvedValueOnce({ hash: oldHash });
    expect(await adapter.prepare(payoutOp)).toEqual({
      pending: true,
      txHash: oldHash,
      blockNumber: null,
    });

    expect(adapter.contracts.MockSRV.mint.populateTransaction).not.toHaveBeenCalled();
    expect(adapter.contracts.MockSRV.transfer.populateTransaction).not.toHaveBeenCalled();
    expect(adapter.provider.estimateGas).not.toHaveBeenCalled();

    // 3. Full dispatcher flow: dispatchDue moves op to submitted without signing/broadcasting, then reconcile confirms.
    const refId = new mongoose.Types.ObjectId();
    const op = await ChainOpModel.create({
      pid: `cop_payout_pend_${Date.now()}`,
      kind: 'payout',
      adapter: 'avalanche',
      ref: `payout:pend_${refId.toString()}`,
      refType: 'withdrawal',
      refId,
      payload: { to: `0x${'9'.repeat(40)}`, amountUnits: '5000' },
      status: 'created',
      txHash: null,
      txHashes: [oldHash],
    });

    try {
      const broadcastSpy = vi.spyOn(adapter, 'broadcast');
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce(null);
      adapter.provider.getTransaction.mockResolvedValueOnce({ hash: oldHash });

      await chainService.dispatchDue();

      const afterDispatch = await ChainOpModel.findById(op._id).lean();
      expect(afterDispatch.status).toBe('submitted');
      expect(afterDispatch.txHash).toBe(oldHash);
      expect(afterDispatch.lockedUntil).toBeNull();
      expect(afterDispatch.submittedAt).toBeInstanceOf(Date);
      expect(broadcastSpy).not.toHaveBeenCalled();
      expect(adapter.contracts.MockSRV.mint.populateTransaction).not.toHaveBeenCalled();
      expect(adapter.contracts.MockSRV.transfer.populateTransaction).not.toHaveBeenCalled();

      // Reconcile while mined with < confirmations -> stays submitted.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 99, logs: [] });
      await chainService.reconcileSubmitted();
      const stillPending = await ChainOpModel.findById(op._id).lean();
      expect(stillPending.status).toBe('submitted');
      expect(onCompleted).not.toHaveBeenCalled();

      // Reconcile once confirmed (100 - 97 + 1 = 4 >= 3) -> completes with oldHash.
      adapter.provider.getTransactionReceipt.mockResolvedValueOnce({ status: 1, blockNumber: 97, logs: [] });
      await chainService.reconcileSubmitted();
      const completed = await ChainOpModel.findById(op._id).lean();
      expect(completed.status).toBe('completed');
      expect(completed.txHash).toBe(oldHash);
      expect(completed.blockNumber).toBe(97);
      expect(onCompleted).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).not.toHaveBeenCalled();
    } finally {
      setChainAdapter(previous);
      await ChainOpModel.deleteOne({ _id: op._id });
    }
  });
});
