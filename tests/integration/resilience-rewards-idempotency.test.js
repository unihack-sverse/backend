import { describe, expect, it } from 'vitest';

import { buy, cosmetic, createLiveGame, registerPlayer } from '../helpers.js';
import { epochNumberAt } from '../../src/lib/epoch.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { RewardClaimModel } from '../../src/modules/rewards/models/index.js';
import { rewardsService } from '../../src/modules/rewards/services/rewards.service.js';

describe('resilience: rewards idempotency', () => {
  it('closeEpoch is idempotent and concurrent claims credit the vault only once', async () => {
    const { creator, items, studio } = await createLiveGame({ items: [cosmetic({ priceUnits: '1000000000' })] });
    const buyer = await registerPlayer({ fund: 2_000_000_000n });
    const buyRes = await buy(buyer.agent, items[0].id);
    expect(buyRes.status).toBe(200);

    const number = epochNumberAt(new Date());
    const firstClose = await rewardsService.closeEpoch(number, { force: true });
    const claimsAfterFirst = await RewardClaimModel.find({ epochNumber: number, claimantId: studio._id }).lean();
    expect(claimsAfterFirst).toHaveLength(1);

    // Closing the same epoch again must be idempotent.
    const secondClose = await rewardsService.closeEpoch(number, { force: true });
    expect(secondClose.id).toBe(firstClose.id);
    const claimsAfterSecond = await RewardClaimModel.find({ epochNumber: number, claimantId: studio._id }).lean();
    expect(claimsAfterSecond).toHaveLength(1);

    const beforeBalance = BigInt((await ledgerService.balance(studio.vaultAccountId)).balanceUnits);
    const claimAmount = BigInt(claimsAfterFirst[0].amountUnits);
    expect(claimAmount).toBeGreaterThan(0n);

    // Concurrent claims for the same epoch/claimant: exactly one succeeds.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        creator.agent.post(`/api/v1/studios/me/rewards/${firstClose.id}/claim`).send({}),
      ),
    );

    const ok = responses.filter((r) => r.status === 200);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(ok[0].body.data.settlementMode).toBe('ledger');
    expect(ok[0].body.data.merkleRoot).toBeTruthy();
    expect(ok[0].body.data.merkleProof).toBeUndefined();
    expect(conflicts).toHaveLength(3);
    for (const c of conflicts) {
      expect(c.body.error.code).toBe('already_claimed');
    }

    const afterBalance = BigInt((await ledgerService.balance(studio.vaultAccountId)).balanceUnits);
    expect(afterBalance - beforeBalance).toBe(claimAmount);
  });
});
