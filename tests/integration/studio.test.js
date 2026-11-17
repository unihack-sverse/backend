import { describe, expect, it } from 'vitest';

import { buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';
import { env } from '../../src/config/env.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { WithdrawalModel } from '../../src/modules/studios/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { checkoutService } from '../../src/modules/checkout/services/checkout.service.js';
import { OrderModel } from '../../src/modules/checkout/models/index.js';
import { toBigInt } from '../../src/lib/money.js';

describe('studio console (UC-18, UC-23, UC-24, UC-29)', () => {
  it('creating a studio promotes the player and opens vault + bond accounts', async () => {
    const player = await registerPlayer();
    const res = await player.agent.post('/api/v1/studios').send({ handle: `st${player.handle}`.slice(0, 20), displayName: 'Solo' });
    expect(res.status).toBe(201);
    expect(res.body.data.vault.balanceUnits).toBe('0');
    expect(res.body.data.signerAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const me = await player.agent.get('/api/v1/auth/me');
    expect(me.body.data.roles).toContain('creator');
    expect((await player.agent.post('/api/v1/studios').send({ handle: 'another1', displayName: 'Again' })).body.error.code).toBe('studio_exists');

    const otherPlayer = await registerPlayer();
    const resWithGrant = await otherPlayer.agent.post('/api/v1/studios').send({ handle: `st${otherPlayer.handle}`.slice(0, 20), displayName: 'Funded', grantTestFunds: true });
    expect(resWithGrant.status).toBe(201);
    expect(resWithGrant.body.data.vault.balanceUnits).toBe('1000000000');
  });

  it('IDOR sweep: a creator cannot touch another studio’s resources', async () => {
    const a = await createLiveGame({ items: [cosmetic()] });
    const b = await createLiveGame({ items: [cosmetic()] });
    const attempts = [
      a.creator.agent.patch(`/api/v1/games/${b.game.pid}`).send({ title: 'hijack' }),
      a.creator.agent.post(`/api/v1/games/${b.game.pid}/items`).send(cosmetic()),
      a.creator.agent.patch(`/api/v1/items/${b.items[0].id}`).send({ name: 'hijack' }),
      a.creator.agent.post(`/api/v1/items/${b.items[0].id}/archive`).send({}),
      a.creator.agent.put(`/api/v1/games/${b.game.pid}/envelope`).send({ acceptsTierMax: 'T1', accepts: [] }),
      a.creator.agent.get(`/api/v1/games/${b.game.pid}/manage`),
      a.creator.agent.post(`/api/v1/games/${b.game.pid}/submit`).send({}),
      a.creator.agent.post('/api/v1/publish/jobs').send({ gameId: b.game.pid }),
    ];
    for (const res of await Promise.all(attempts)) expect([403, 404]).toContain(res.status);
  });

  it('locked dispute-window funds cannot be withdrawn; available funds settle on-chain', async () => {
    const { creator, items, studio } = await createLiveGame({ items: [cosmetic({ priceUnits: '100000000' })] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    await buy(buyer.agent, items[0].id);
    const me = await creator.agent.get('/api/v1/studios/me');
    expect(me.body.data.vault.availableUnits).toBe('0');
    const blocked = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '90000000', destinationAddress: '0x000000000000000000000000000000000000dEaD' });
    expect(blocked.status).toBe(402);

    await OrderModel.updateMany({ studioId: studio._id }, { $set: { disputeWindowEndsAt: new Date(Date.now() - 1000) } });
    await checkoutService.releaseDisputeLocks();
    const ok = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '90000000', destinationAddress: '0x000000000000000000000000000000000000dEaD' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.status).toBe('settled');
    expect(ok.body.data.txHash).toMatch(/^0xmock_/);
    expect(await ChainOpModel.countDocuments({ kind: 'payout', status: 'completed' })).toBeGreaterThan(0);
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
  });

  it('a failed payout reverses the posting and returns funds to the vault', async () => {
    const { creator, studio } = await createLiveGame();
    await creator.agent.post('/api/v1/studios/me/bond/stake').send({ amountUnits: '1' }).catch(() => {});
    const { withTransaction } = await import('../../src/lib/transaction.js');
    await withTransaction(async (session) =>
      ledgerService.post({ legs: [
        { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: 50_000_000n, reason: 'onramp_credit' },
        { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: 50_000_000n, reason: 'onramp_credit' },
      ] }, session),
    );
    const { chainAdapter } = await import('../../src/adapters/chain/index.js');
    const adapter = chainAdapter();
    for (let i = 0; i < 8; i += 1) adapter.failNext.set('payout', new Error('rpc down'));
    const originalPrepare = adapter.prepare.bind(adapter);
    adapter.prepare = async (op) => {
      if (op.kind === 'payout') throw new Error('rpc down');
      return originalPrepare(op);
    };
    const res = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '50000000', destinationAddress: '0x000000000000000000000000000000000000dEaD' });
    expect(res.status).toBe(201);
    const { chainService } = await import('../../src/modules/chain/services/chain.service.js');
    for (let i = 0; i < 10; i += 1) {
      await ChainOpModel.updateMany({ kind: 'payout', status: 'created' }, { $set: { nextAttemptAt: new Date(0) } });
      await chainService.dispatchDue();
    }
    adapter.prepare = originalPrepare;
    adapter.failNext.clear();
    const withdrawal = await WithdrawalModel.findOne({ pid: res.body.data.id }).lean();
    expect(withdrawal.status).toBe('failed');
    expect(toBigInt((await ledgerService.vaultFor(studio._id)).balanceUnits)).toBe(50_000_000n);
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
  });

  it('requires KYC above the cumulative threshold', async () => {
    const { creator, studio } = await createLiveGame();
    const { StudioModel } = await import('../../src/modules/studios/models/index.js');
    await StudioModel.updateOne({ _id: studio._id }, { $set: { withdrawnUnits: 49_999_000_000n } });
    const res = await creator.agent.post('/api/v1/studios/me/withdrawals').send({ amountUnits: '2000000', destinationAddress: '0x000000000000000000000000000000000000dEaD' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('kyc_required');
  });

  it('analytics aggregate real orders for the studio', async () => {
    const { creator, items } = await createLiveGame({ items: [cosmetic({ priceUnits: '100000000' })] });
    const buyer = await registerPlayer({ fund: 500_000_000n });
    await buy(buyer.agent, items[0].id);
    const res = await creator.agent.get('/api/v1/studios/me/analytics');
    expect(res.status).toBe(200);
    expect(res.body.data.grossUnits).toBe('100000000');
    expect(res.body.data.netUnits).toBe('90000000');
    expect(res.body.data.buyers).toBe(1);
    expect(res.body.data.revenueSeries).toHaveLength(1);
  });

  it('studio faucet credits test SRV to the vault', async () => {
    const player = await registerPlayer();
    await player.agent.post('/api/v1/studios').send({ handle: `f${player.handle}`.slice(0, 20), displayName: 'Faucet Studio' });
    const res = await player.agent.post('/api/v1/studios/me/faucet').send({});
    expect(res.status).toBe(200);
    expect(BigInt(res.body.data.vault.balanceUnits)).toBeGreaterThanOrEqual(BigInt(env.FAUCET_AMOUNT_UNITS));
  });
});
