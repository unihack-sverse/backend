import { describe, expect, it } from 'vitest';

import { RewardClaimModel, RewardEpochModel } from '../../src/modules/rewards/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { publicId } from '../../src/lib/ids.js';
import { toBigInt } from '../../src/lib/money.js';
import { registerPlayer } from '../helpers.js';

describe('double-claim — parallel claims credit exactly once', () => {
  it('ten parallel claims produce one credit', async () => {
    const player = await registerPlayer();
    const epoch = await RewardEpochModel.create({ pid: publicId('epo'), number: 9000 + Math.floor(Math.random() * 1000), startAt: new Date(0), endAt: new Date(1), status: 'published' });
    await RewardClaimModel.create({
      pid: publicId('clm'),
      epochId: epoch._id,
      epochNumber: epoch.number,
      claimantType: 'user',
      claimantId: player.user._id,
      claimantAddress: player.user.custodialAddress,
      leafIndex: 0,
      amountUnits: 7_000_000n,
    });
    const results = await Promise.all([...Array(10)].map(() => player.agent.post(`/api/v1/passport/me/rewards/${epoch.pid}/claim`).send({})));
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409 && res.body.error.code === 'already_claimed')).toHaveLength(9);
    expect(toBigInt((await ledgerService.walletFor(player.user._id)).balanceUnits)).toBe(7_000_000n);
  });
});
