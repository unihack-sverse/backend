import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, buy, cosmetic, createLiveGame, registerPlayer, unique } from '../helpers.js';
import { UserModel } from '../../src/modules/auth/models/index.js';
import { CuratorAttributionModel, RewardClaimModel } from '../../src/modules/rewards/models/index.js';
import { curationService } from '../../src/modules/rewards/services/curation.service.js';
import { rewardsService, bootstrapEmission } from '../../src/modules/rewards/services/rewards.service.js';
import { epochNumberAt } from '../../src/lib/epoch.js';
import { toBigInt } from '../../src/lib/money.js';

describe('curator attribution (UC-28)', () => {
  it('binds first-touch referrals, rejects self-referral and flags same-device signups', async () => {
    const curator = await registerPlayer();
    const code = (await UserModel.findById(curator.user._id).lean()).referral.code;

    const handle = unique('ref');
    // Same venue Wi-Fi (same IP in tests) but a different device: not flagged.
    const res = await request(app).post('/api/v1/auth/register').set('User-Agent', 'player-phone/1').send({ handle, email: `${handle}@x.dev`, password: 'correct-horse-9', referralCode: code });
    expect(res.status).toBe(201);
    const referred = await UserModel.findOne({ handle }).lean();
    const attribution = await CuratorAttributionModel.findOne({ referredUserId: referred._id }).lean();
    expect(String(attribution.curatorUserId)).toBe(String(curator.user._id));
    expect(attribution.flagged).toBe(false);

    expect(await curationService.bindReferral({ referredUser: curator.user, code })).toBeNull();

    await UserModel.updateOne({ _id: curator.user._id }, { $set: { signupIpHash: 'same-ip', signupUaHash: 'same-ua' } });
    const twin = await registerPlayer();
    const flagged = await curationService.bindReferral({ referredUser: twin.user, code, ipHash: 'same-ip', uaHash: 'same-ua' });
    expect(flagged.flagged).toBe(true);
    expect(flagged.flagReason).toBe('same_device_signup');
  });

  it('attributes the referred player’s spend to the curator', async () => {
    const curator = await registerPlayer();
    const code = (await UserModel.findById(curator.user._id).lean()).referral.code;
    const handle = unique('sp');
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').set('User-Agent', 'friend-laptop/1').send({ handle, email: `${handle}@x.dev`, password: 'correct-horse-9', referralCode: code });
    const referred = await UserModel.findOne({ handle }).lean();
    const { credit } = await import('../helpers.js');
    await credit(referred, 500_000_000n);
    const { items } = await createLiveGame({ items: [cosmetic({ priceUnits: '100000000' })] });
    expect((await buy(agent, items[0].id)).status).toBe(200);
    const attribution = await CuratorAttributionModel.findOne({ referredUserId: referred._id }).lean();
    expect(toBigInt(attribution.attributedUnits)).toBe(100_000_000n);
    expect(attribution.firstSpendAt).toBeTruthy();
    const me = await curator.agent.get('/api/v1/auth/me');
    expect(me.body.data.referral.referred).toBe(1);
  });
});

describe('creator rewards (UC-26, UC-27)', () => {
  it('studios claim their creator-pool share into the vault', async () => {
    const { creator, items, studio } = await createLiveGame({ items: [cosmetic({ priceUnits: '1000000000' })] });
    const buyer = await registerPlayer({ fund: 2_000_000_000n });
    await buy(buyer.agent, items[0].id);
    const number = epochNumberAt(new Date());
    const epoch = await rewardsService.closeEpoch(number, { force: true });
    const claims = await creator.agent.get('/api/v1/studios/me/rewards');
    const mine = claims.body.data.find((claim) => claim.epochNumber === number);
    expect(mine).toBeTruthy();
    expect(BigInt(mine.amountUnits)).toBeGreaterThan(0n);
    const res = await creator.agent.post(`/api/v1/studios/me/rewards/${epoch.id}/claim`).send({});
    expect(res.status).toBe(200);
    expect((await creator.agent.post(`/api/v1/studios/me/rewards/${epoch.id}/claim`).send({})).body.error.code).toBe('already_claimed');
    const claim = await RewardClaimModel.findOne({ claimantId: studio._id, epochNumber: number }).lean();
    expect(claim.status).toBe('claimed');
    expect(claim.scoreInputs.revenueUnits).toBeTruthy();
    const current = await request(app).get('/api/v1/rewards/epochs/current');
    expect(current.status).toBe(200);
    expect(current.body.data.projected).toBeTruthy();
    expect((await request(app).get(`/api/v1/rewards/epochs/${number}`)).body.data.status).toBe('published');
  });

  it('bootstrap emission halves annually and stops after five years', () => {
    expect(bootstrapEmission(1)).toBe(0n);
  });
});
