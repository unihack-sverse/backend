import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Contract, JsonRpcProvider } from 'ethers';

import { app, buy, createLiveGame, living, registerPlayer, unique } from '../helpers.js';
import { chainAdapter } from '../../src/adapters/chain/index.js';
import { loadAbi } from '../../src/adapters/chain/contracts.js';
import { chainRef } from '../../src/adapters/chain/refs.js';
import { canonicalJson } from '../../src/lib/canonical-json.js';
import { hmacHex } from '../../src/lib/hmac.js';
import { epochNumberAt } from '../../src/lib/epoch.js';
import { ChainEventModel, ChainOpModel } from '../../src/modules/chain/models/index.js';
import { chainService } from '../../src/modules/chain/services/chain.service.js';
import { checkoutService } from '../../src/modules/checkout/services/checkout.service.js';
import { deedsService } from '../../src/modules/deeds/services/deeds.service.js';
import { InventoryItemModel } from '../../src/modules/inventory/models/index.js';
import { OrderModel } from '../../src/modules/checkout/models/index.js';
import { rewardsService } from '../../src/modules/rewards/services/rewards.service.js';
import { RewardEpochModel } from '../../src/modules/rewards/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';

const provider = new JsonRpcProvider('http://127.0.0.1:8547', 31337, { staticNetwork: true });

function contracts() {
  const { deployment } = chainAdapter();
  const at = (name) => new Contract(deployment.contracts[name], loadAbi(name), provider);
  return { items: at('SverseItems'), deeds: at('SverseDeedRegistry'), srv: at('MockSRV'), rewards: at('SverseRewards') };
}

/** Drives the outbox until every op is terminal (the scheduler does this in production). */
async function settle(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await ChainOpModel.updateMany({ status: 'created' }, { $set: { nextAttemptAt: new Date(0) } });
    await chainService.dispatchDue();
    await chainService.reconcileSubmitted();
    const open = await ChainOpModel.find({ status: { $in: ['created', 'submitted', 'chain_confirmed'] } }).lean();
    if (!open.length) return;
    if (Date.now() > deadline) {
      throw new Error(`ops not settled: ${open.map((op) => `${op.kind}:${op.status}:${op.lastError}`).join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('Avalanche adapter end-to-end on a local EVM', () => {
  it('health reports the relayer holds every operational role', async () => {
    const health = await chainAdapter().health();
    expect(health.ok).toBe(true);
    expect(health.chainId).toBe(31337);
    expect(health.roles).toEqual({ minter: true, platform: true, witness: true, publisher: true });
    const status = await request(app).get('/api/v1/chain/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ adapter: 'avalanche', chainId: 31337, network: 'hardhat-local', explorer: null });
    const admin = await registerPlayer({ roles: ['player', 'admin'] });
    const adminHealth = await admin.agent.get('/admin/v1/chain/health');
    expect(adminHealth.body.data.adapterHealth.ok).toBe(true);
  });

  it('a purchase provisions the catalog and mints the Living Item to the custodial address — exactly once', async () => {
    const { items } = await createLiveGame({ items: [living({ supplyMax: 50 })], tokenizationLevel: 'L3' });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const res = await buy(buyer.agent, items[0].id);
    expect(res.status).toBe(200);
    await settle();

    const item = await InventoryItemModel.findOne({ pid: res.body.data.inventoryItem.id }).lean();
    expect(item.chain.status).toBe('confirmed');
    expect(item.tokenId).toMatch(/^\d+$/);
    expect(item.chain.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const { items: sverseItems } = contracts();
    expect(await sverseItems.balanceOf(buyer.user.custodialAddress, BigInt(item.tokenId))).toBe(1n);
    const op = await ChainOpModel.findById(item.chain.opId).lean();
    expect(await sverseItems.mintRefs(chainRef(op.ref))).toBe(BigInt(item.tokenId));
    const definitionId = await sverseItems.definitionOf(BigInt(item.tokenId));
    const before = await sverseItems.totalMinted(definitionId);

    // Replaying the op (e.g. after a crash) must find the mint on-chain and not mint again.
    await ChainOpModel.updateOne({ _id: op._id }, { $set: { status: 'created', nextAttemptAt: new Date(0), lockedUntil: null } });
    await settle();
    expect(await sverseItems.totalMinted(definitionId)).toBe(before);
    expect((await ChainOpModel.findById(op._id).lean()).status).toBe('completed');
  });

  it('anchors a verified deed with the studio’s EIP-712 signature and the Sverse witness', async () => {
    const ctx = await createLiveGame({ items: [living()], tokenizationLevel: 'L3' });
    const key = await ctx.creator.agent.post('/api/v1/studios/me/api-keys').send({ scopes: ['game'], gameId: ctx.game.pid });
    const secret = key.body.data.secret;
    const player = await registerPlayer({ fund: 500_000_000n });
    const purchase = await buy(player.agent, ctx.items[0].id);
    const inventoryItemId = purchase.body.data.inventoryItem.id;
    await settle();

    await request(app).post('/sdk/v1/sessions').set('Authorization', `Bearer ${secret}`).send({ passportId: player.id });
    const body = { deedType: 'boss_defeated', detail: { boss: 'Ashmaw', difficulty: 'mythic' }, nonce: `n-${unique('n')}` };
    const signature = `sha256=${hmacHex(secret, `${inventoryItemId}.${body.deedType}.${canonicalJson(body.detail)}.${body.nonce}`)}`;
    const deed = await request(app).post(`/sdk/v1/items/${inventoryItemId}/deeds`).set('Authorization', `Bearer ${secret}`).send({ ...body, studioSignature: signature });
    expect(deed.status).toBe(201);

    await deedsService.verifyPending();
    await settle();
    const [anchored] = await deedsService.listForItem(inventoryItemId, { _id: player.user._id });
    expect(anchored.verified).toBe(true);
    expect(anchored.chain.status).toBe('confirmed');

    const { items: sverseItems, deeds } = contracts();
    const item = await InventoryItemModel.findOne({ pid: inventoryItemId }).lean();
    expect(await deeds.deedCount(await sverseItems.getAddress(), BigInt(item.tokenId))).toBe(1n);
    const onChain = await deeds.deeds(anchored.chain.chainDeedId);
    expect(onChain.studioSigner).toBe(ctx.studio.signerAddress);
    expect(onChain.witnessSigner).toBe(chainAdapter().relayerAddress);
  });

  it('a secondary sale moves the token between custodial wallets (gas topped up by the relayer)', async () => {
    const { items } = await createLiveGame({ items: [living()], tokenizationLevel: 'L3' });
    const seller = await registerPlayer({ fund: 500_000_000n });
    const purchase = await buy(seller.agent, items[0].id);
    await settle();
    const listing = await seller.agent.post('/api/v1/market/listings').send({ inventoryItemId: purchase.body.data.inventoryItem.id, priceUnits: '300000000' });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    expect((await buyer.agent.post(`/api/v1/market/listings/${listing.body.data.id}/buy`).send({})).status).toBe(200);
    await settle();

    const item = await InventoryItemModel.findOne({ pid: purchase.body.data.inventoryItem.id }).lean();
    expect(item.chain.status).toBe('confirmed');
    const { items: sverseItems } = contracts();
    expect(await sverseItems.balanceOf(buyer.user.custodialAddress, BigInt(item.tokenId))).toBe(1n);
    expect(await sverseItems.balanceOf(seller.user.custodialAddress, BigInt(item.tokenId))).toBe(0n);
  });

  it('a refund burns the token on-chain', async () => {
    const { items } = await createLiveGame({ items: [living()], tokenizationLevel: 'L3' });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const purchase = await buy(buyer.agent, items[0].id);
    await settle();
    const item = await InventoryItemModel.findOne({ pid: purchase.body.data.inventoryItem.id }).lean();
    await checkoutService.refund(null, purchase.body.data.id, { reason: 'chargeback' });
    await settle();
    expect(await contracts().items.balanceOf(buyer.user.custodialAddress, BigInt(item.tokenId))).toBe(0n);
  });

  it('a studio withdrawal settles as tSRV at the destination address', async () => {
    const { creator, items, studio } = await createLiveGame({ items: [living({ priceUnits: '100000000' })], tokenizationLevel: 'L3' });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    await buy(buyer.agent, items[0].id);
    await OrderModel.updateMany({ studioId: studio._id }, { $set: { disputeWindowEndsAt: new Date(Date.now() - 1000) } });
    await checkoutService.releaseDisputeLocks();
    const destination = '0x000000000000000000000000000000000000bEEF';
    const before = await contracts().srv.balanceOf(destination);
    const res = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '90000000', destinationAddress: destination });
    expect(res.status).toBe(201);
    await settle();
    expect((await contracts().srv.balanceOf(destination)) - before).toBe(90_000_000n);
    const list = await creator.agent.get('/api/v1/studios/me/withdrawals');
    expect(list.body.data[0].status).toBe('settled');
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
  });

  it('recovers a payout signed but never broadcast (crash) by rebroadcasting the same raw tx — paid once', async () => {
    const { creator, studio } = await createLiveGame({ tokenizationLevel: 'L3' });
    const { withTransaction } = await import('../../src/lib/transaction.js');
    await withTransaction(async (session) =>
      ledgerService.post({ legs: [
        { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: 40_000_000n, reason: 'onramp_credit' },
        { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: 40_000_000n, reason: 'onramp_credit' },
      ] }, session),
    );
    const destination = '0x000000000000000000000000000000000000c0DE';
    const adapter = chainAdapter();
    const realBroadcast = adapter.broadcast.bind(adapter);
    let swallowed = 0;
    // Simulate a crash after the signed tx was persisted but before it reached the node.
    adapter.broadcast = async (rawTx) => {
      if (swallowed === 0) {
        swallowed += 1;
        return { txHash: null };
      }
      return realBroadcast(rawTx);
    };
    const res = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '40000000', destinationAddress: destination });
    expect(res.status).toBe(201);
    const op = await ChainOpModel.findOne({ ref: `payout:${res.body.data.id}` }).select('+rawTx').lean();
    expect(op.status).toBe('submitted');
    expect(op.rawTx).toMatch(/^0x/);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await settle();
    adapter.broadcast = realBroadcast;
    expect(await contracts().srv.balanceOf(destination)).toBe(40_000_000n);
    // Replaying the completed op cannot pay twice: the same nonce is already used.
    await ChainOpModel.updateOne({ _id: op._id }, { $set: { status: 'submitted' } });
    await settle();
    expect(await contracts().srv.balanceOf(destination)).toBe(40_000_000n);
    expect(swallowed).toBe(1);
  });

  it('publishes the reward epoch root on-chain, funded by the relayer', async () => {
    const { items } = await createLiveGame({ items: [living({ priceUnits: '1000000000' })], tokenizationLevel: 'L3' });
    const buyer = await registerPlayer({ fund: 2_000_000_000n });
    await buy(buyer.agent, items[0].id);
    const number = epochNumberAt(new Date());
    const epoch = await rewardsService.closeEpoch(number, { force: true });
    await settle();
    const onChain = await contracts().rewards.epochs(number);
    expect(onChain.merkleRoot).toBe(epoch.merkleRoot);
    expect(onChain.totalUnits).toBe(BigInt(epoch.distributedUnits));
    expect((await RewardEpochModel.findOne({ number }).lean()).publishMerkleTxHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('indexes contract events and reports a healthy reconciliation', async () => {
    let indexed = 0;
    for (let i = 0; i < 20; i += 1) {
      const result = await chainService.indexEvents({ maxRange: 5000 });
      indexed += result.indexed;
      if (result.toBlock === undefined || result.toBlock >= result.head) break;
    }
    expect(indexed).toBeGreaterThan(0);
    const names = await ChainEventModel.distinct('event');
    expect(names).toEqual(expect.arrayContaining(['ItemMintedWithRef', 'DeedRecorded', 'TransferSingle', 'EpochPublished']));
    const report = await chainService.reconciliationReport();
    expect(report.failed).toEqual([]);
  });
});
