import { describe, expect, it } from 'vitest';

import { buy, cosmetic, createLiveGame, living, registerPlayer, unique } from '../helpers.js';
import { OrderModel } from '../../src/modules/checkout/models/index.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { InventoryItemModel } from '../../src/modules/inventory/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { checkoutService } from '../../src/modules/checkout/services/checkout.service.js';
import { verifyEntitlementToken } from '../../src/lib/entitlement.js';
import { toBigInt } from '../../src/lib/money.js';

describe('checkout (UC-07…09)', () => {
  it('quotes with fee breakdown, settles 90/10, mints on-chain and issues an entitlement', async () => {
    const { items, studio } = await createLiveGame({ items: [living()] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const intent = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}abcdefgh`).send({ itemDefinitionId: items[0].id });
    expect(intent.status).toBe(201);
    expect(intent.body.data.feeBreakdown.studioUnits).toBe('189000000');
    expect(intent.body.data.quote.usdAmount).toBe('8.82');

    const vaultBefore = toBigInt((await ledgerService.vaultFor(studio._id)).balanceUnits);
    const res = await buyer.agent.post(`/api/v1/checkout/intents/${intent.body.data.id}/confirm`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.txHash).toMatch(/^0xmock_/);
    expect(res.body.data.chain.status).toBe('confirmed');
    expect(res.body.data.inventoryItem.tokenId).toMatch(/^mock_/);
    expect(verifyEntitlementToken(res.body.data.entitlementToken)?.sub).toBe(buyer.id);

    const vault = await ledgerService.vaultFor(studio._id);
    expect(toBigInt(vault.balanceUnits) - vaultBefore).toBe(189_000_000n);
    expect(toBigInt(vault.lockedUnits)).toBeGreaterThanOrEqual(189_000_000n);
    expect(await ChainOpModel.countDocuments({ kind: 'mint_item', status: 'completed' })).toBeGreaterThan(0);
  });

  it('rejects already-owned, insufficient funds, unknown item and expired quotes', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ priceUnits: '100000000' })] });
    const poor = await registerPlayer({ fund: 1_000_000n });
    const broke = await poor.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}abcdefgh`).send({ itemDefinitionId: items[0].id });
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe('insufficient_funds');

    const buyer = await registerPlayer({ fund: 500_000_000n });
    expect((await buy(buyer.agent, items[0].id)).status).toBe(200);
    const again = await buy(buyer.agent, items[0].id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_owned');

    const missing = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}abcdefgh`).send({ itemDefinitionId: 'itd_doesnotexist' });
    expect(missing.body.error.code).toBe('item_not_found');

    const other = await registerPlayer({ fund: 500_000_000n });
    const intent = await other.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}abcdefgh`).send({ itemDefinitionId: items[0].id });
    await OrderModel.updateOne({ pid: intent.body.data.id }, { $set: { 'quote.expiresAt': new Date(Date.now() - 1000) } });
    const expired = await other.agent.post(`/api/v1/checkout/intents/${intent.body.data.id}/confirm`).send({});
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('quote_expired');
  });

  it('requires an Idempotency-Key and replays the identical response', async () => {
    const { items } = await createLiveGame({ items: [cosmetic()] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const missing = await buyer.agent.post('/api/v1/checkout/intents').send({ itemDefinitionId: items[0].id });
    expect(missing.body.error.code).toBe('idempotency_key_required');
    const key = `${unique('k')}abcdefgh`;
    const first = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', key).send({ itemDefinitionId: items[0].id });
    const replay = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', key).send({ itemDefinitionId: items[0].id });
    expect(replay.status).toBe(first.status);
    expect(replay.text).toBe(first.text);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await OrderModel.countDocuments({ userId: buyer.user._id })).toBe(1);
  });

  it('refund mirrors the ledger, revokes the item and restores the trial balance', async () => {
    const { items } = await createLiveGame({ items: [living()] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const res = await buy(buyer.agent, items[0].id);
    const before = toBigInt((await ledgerService.walletFor(buyer.user._id)).balanceUnits);
    const refunded = await checkoutService.refund({ type: 'system' }, res.body.data.id, { reason: 'chargeback' });
    expect(refunded.status).toBe('refunded');
    expect(toBigInt((await ledgerService.walletFor(buyer.user._id)).balanceUnits) - before).toBe(210_000_000n);
    const item = await InventoryItemModel.findOne({ pid: res.body.data.inventoryItem.id }).lean();
    expect(item.status).toBe('revoked');
    expect(await ChainOpModel.countDocuments({ kind: 'burn_item', refId: item._id })).toBe(1);
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
    await expect(checkoutService.refund(null, res.body.data.id, {})).rejects.toMatchObject({ code: 'order_not_refundable' });
  });

  it('refund after the studio withdrew posts the deficit to treasury, never unbalancing the ledger', async () => {
    const { items, studio } = await createLiveGame({ items: [cosmetic({ priceUnits: '100000000' })] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    const res = await buy(buyer.agent, items[0].id);
    // Drain the vault as if the studio had already withdrawn.
    const { withTransaction } = await import('../../src/lib/transaction.js');
    await withTransaction(async (session) => {
      const vault = await ledgerService.vaultFor(studio._id, session);
      await ledgerService.unlock(vault._id, vault.lockedUnits, session);
      await ledgerService.post({ legs: [
        { accountId: vault._id, direction: 'debit', amountUnits: vault.balanceUnits, reason: 'withdrawal' },
        { accountId: await ledgerService.systemAccountId('payable', session), direction: 'credit', amountUnits: vault.balanceUnits, reason: 'withdrawal' },
      ] }, session);
    });
    const refunded = await checkoutService.refund(null, res.body.data.id, { reason: 'chargeback' });
    expect(refunded.status).toBe('refunded');
    const { StudioModel } = await import('../../src/modules/studios/models/index.js');
    expect(toBigInt((await StudioModel.findById(studio._id).lean()).debtUnits)).toBe(90_000_000n);
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
  });

  it('fiat on-ramp credits SRV and settles the pending order once, even if the webhook repeats', async () => {
    const { items } = await createLiveGame({ items: [cosmetic()] });
    const buyer = await registerPlayer();
    const intent = await buyer.agent.post('/api/v1/checkout/intents').set('Idempotency-Key', `${unique('k')}abcdefgh`).send({ itemDefinitionId: items[0].id, paymentMethod: 'fiat_onramp' });
    expect(intent.status).toBe(201);
    const session = await buyer.agent.post('/api/v1/checkout/fiat-sessions').send({ orderId: intent.body.data.id });
    expect(session.status).toBe(201);
    const { checkoutService: service } = await import('../../src/modules/checkout/services/checkout.service.js');
    const first = await service.completeFiatSession({ sessionId: session.body.data.sessionId, status: 'succeeded' });
    const second = await service.completeFiatSession({ sessionId: session.body.data.sessionId, status: 'succeeded' });
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    expect(toBigInt((await ledgerService.walletFor(buyer.user._id)).balanceUnits)).toBe(0n);
  });
});
