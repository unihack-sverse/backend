import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, buy, createLiveGame, living, registerPlayer, unique } from '../helpers.js';
import { canonicalJson } from '../../src/lib/canonical-json.js';
import { hmacHex } from '../../src/lib/hmac.js';
import { verifyEntitlementToken } from '../../src/lib/entitlement.js';
import { deedsService } from '../../src/modules/deeds/services/deeds.service.js';
import { DeedStatusModel } from '../../src/modules/deeds/models/index.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { PlaySessionModel, PlayRollupModel } from '../../src/modules/telemetry/models/index.js';
import { ReviewCaseModel } from '../../src/modules/review/models/index.js';
import { telemetryService } from '../../src/modules/telemetry/services/telemetry.service.js';
import { ClubPostModel } from '../../src/modules/clubs/models/index.js';

async function setup() {
  const ctx = await createLiveGame({ items: [living()], tokenizationLevel: 'L3' });
  const keyRes = await ctx.creator.agent.post('/api/v1/studios/me/api-keys').send({ label: 'game', scopes: ['game', 'read'], gameId: ctx.game.pid });
  const secret = keyRes.body.data.secret;
  const player = await registerPlayer({ fund: 500_000_000n });
  const purchase = await buy(player.agent, ctx.items[0].id);
  return { ...ctx, secret, keyId: keyRes.body.data.id, player, inventoryItemId: purchase.body.data.inventoryItem.id };
}

function sign(secret, { inventoryItemId, deedType, detail, nonce }) {
  return `sha256=${hmacHex(secret, `${inventoryItemId}.${deedType}.${canonicalJson(detail)}.${nonce}`)}`;
}

const sdk = (secret) => ({
  get: (path) => request(app).get(`/sdk/v1${path}`).set('Authorization', `Bearer ${secret}`),
  post: (path) => request(app).post(`/sdk/v1${path}`).set('Authorization', `Bearer ${secret}`),
});

describe('SDK surface (UC-07, UC-11, UC-25)', () => {
  it('returns the plaintext secret once and authenticates by hash', async () => {
    const ctx = await setup();
    expect(ctx.secret).toMatch(/^sk_live_[0-9A-Za-z]{32}$/);
    const list = await ctx.creator.agent.get('/api/v1/studios/me/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(ctx.secret);
    expect(list.body.data[0].prefix).toBe(ctx.secret.slice(0, 12));
    expect((await sdk(ctx.secret).get('/me')).body.data.game.id).toBe(ctx.game.pid);
    expect((await sdk('sk_live_00000000000000000000000000000000').get('/me')).status).toBe(401);
    await ctx.creator.agent.delete(`/api/v1/studios/me/api-keys/${ctx.keyId}`);
    expect((await sdk(ctx.secret).get('/me')).status).toBe(401);
  });

  it('serves offline-verifiable entitlements scoped to the key’s game only', async () => {
    const ctx = await setup();
    const res = await sdk(ctx.secret).get(`/passports/${ctx.player.id}/entitlements`);
    expect(res.status).toBe(200);
    expect(res.body.data.entitlements).toHaveLength(1);
    const payload = verifyEntitlementToken(res.body.data.token);
    expect(payload.sub).toBe(ctx.player.id);
    expect(payload.gam).toBe(ctx.game.pid);
    expect(new Date(res.body.data.tokenExpiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);

    const other = await createLiveGame({ items: [living()] });
    const otherKey = await other.creator.agent.post('/api/v1/studios/me/api-keys').send({ scopes: ['game'], gameId: other.game.pid });
    const foreign = await sdk(otherKey.body.data.secret).get(`/passports/${ctx.player.id}/entitlements`);
    expect(foreign.body.data.entitlements).toHaveLength(0);
    const spoof = await sdk(otherKey.body.data.secret).get(`/passports/${ctx.player.id}/entitlements?gameId=${ctx.game.pid}`);
    expect(spoof.body.data.gameId).toBe(other.game.pid);
  });

  it('appends attested deeds, mutates traits, replays nonces and enforces velocity', async () => {
    const ctx = await setup();
    const body = { deedType: 'boss_defeated', detail: { boss: 'Ashmaw', difficulty: 'mythic', partySize: 1 }, nonce: `n-${unique('n')}` };
    const bad = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...body, studioSignature: `sha256=${'0'.repeat(64)}` });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('bad_attestation');

    const signature = sign(ctx.secret, { inventoryItemId: ctx.inventoryItemId, ...body });
    const first = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...body, studioSignature: signature });
    expect(first.status).toBe(201);
    expect(first.body.data.verified).toBeNull();
    expect(first.body.data.traitsAfter.level).toBe(first.body.data.traitsBefore.level + 1);

    const replay = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...body, studioSignature: signature });
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const deeds = await request(app).get(`/api/v1/items/${ctx.inventoryItemId}/deeds`).set('Cookie', ctx.player.agent.jar.getCookies({ path: '/', domain: '127.0.0.1', secure: false, script: false }).toString());
    void deeds;

    const undeclared = { deedType: 'teleported', detail: {}, nonce: `n-${unique('n')}` };
    const und = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...undeclared, studioSignature: sign(ctx.secret, { inventoryItemId: ctx.inventoryItemId, ...undeclared }) });
    expect(und.status).toBe(422);
    expect(und.body.error.code).toBe('undeclared_deed');

    let limited;
    for (let i = 0; i < 6; i += 1) {
      const next = { deedType: 'first_clear', detail: { route: `r${i}` }, nonce: `fc-${i}-${unique('n')}` };
      limited = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...next, studioSignature: sign(ctx.secret, { inventoryItemId: ctx.inventoryItemId, ...next }) });
    }
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('mutation_rate_exceeded');

    // item.evolved auto-posts to the club exactly once per deed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await ClubPostModel.countDocuments({ kind: 'deed_auto', gameId: ctx.game._id })).toBe(6);
  });

  it('rejects deeds from another studio’s key with not_your_item', async () => {
    const ctx = await setup();
    const other = await createLiveGame({ items: [living()] });
    const otherKey = (await other.creator.agent.post('/api/v1/studios/me/api-keys').send({ scopes: ['game'], gameId: other.game.pid })).body.data.secret;
    const body = { deedType: 'boss_defeated', detail: {}, nonce: `n-${unique('n')}` };
    const res = await sdk(otherKey).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...body, studioSignature: sign(otherKey, { inventoryItemId: ctx.inventoryItemId, ...body }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('not_your_item');
  });

  it('verifies deeds against telemetry, anchors them on-chain, and flags mismatches', async () => {
    const ctx = await setup();
    const session = await sdk(ctx.secret).post('/sessions').send({ passportId: ctx.player.id });
    expect(session.status).toBe(201);
    const good = { deedType: 'boss_defeated', detail: { boss: 'Ashmaw' }, nonce: `n-${unique('n')}` };
    const okDeed = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...good, studioSignature: sign(ctx.secret, { inventoryItemId: ctx.inventoryItemId, ...good }) });
    const lie = { deedType: 'boss_defeated', detail: { boss: 'Ashmaw', playtimeMinutes: 900 }, nonce: `n-${unique('n')}` };
    const badDeed = await sdk(ctx.secret).post(`/items/${ctx.inventoryItemId}/deeds`).send({ ...lie, studioSignature: sign(ctx.secret, { inventoryItemId: ctx.inventoryItemId, ...lie }) });

    await deedsService.verifyPending();
    const okStatus = await DeedStatusModel.findOne({ deedId: (await import('../../src/modules/deeds/models/index.js')).DeedModel.findOne({ pid: okDeed.body.data.id }).then((d) => d._id) }).lean().catch(() => null);
    void okStatus;
    const list = await deedsService.listForItem(ctx.inventoryItemId, { _id: ctx.player.user._id });
    const verified = list.find((deed) => deed.id === okDeed.body.data.id);
    const flagged = list.find((deed) => deed.id === badDeed.body.data.id);
    expect(verified.verified).toBe(true);
    expect(verified.chain.status).toBe('confirmed');
    expect(verified.sverseWitness).toBe(true);
    expect(flagged.verified).toBe(false);
    expect(flagged.verificationNote).toMatch(/claimed 900 min/);
    expect(await ReviewCaseModel.countDocuments({ kind: 'deed_mismatch', subjectRef: badDeed.body.data.id })).toBe(1);
    const op = await ChainOpModel.findOne({ ref: `deed:${okDeed.body.data.id}` }).lean();
    expect(op.payload.witness).toBe(true);
    expect((await ChainOpModel.findOne({ ref: `deed:${badDeed.body.data.id}` }).lean()).payload.witness).toBe(false);
  });

  it('derives minutes from heartbeats only, closes timeouts at the last heartbeat, newest session wins', async () => {
    const ctx = await setup();
    const open = await sdk(ctx.secret).post('/sessions').send({ passportId: ctx.player.id });
    const sessionId = open.body.data.id;
    const start = new Date(Date.now() - 10 * 60_000);
    await PlaySessionModel.updateOne({ pid: sessionId }, { $set: { startedAt: start, lastHeartbeatAt: start } });
    const late = await sdk(ctx.secret).post(`/sessions/${sessionId}/heartbeat`).send({ durationMinutes: 999 });
    expect(late.status).toBe(409);
    const closed = await PlaySessionModel.findOne({ pid: sessionId }).lean();
    expect(closed.closedAt.getTime()).toBe(start.getTime());
    expect(closed.minutes).toBe(0);

    const a = await sdk(ctx.secret).post('/sessions').send({ passportId: ctx.player.id });
    const b = await sdk(ctx.secret).post('/sessions').send({ passportId: ctx.player.id });
    expect((await PlaySessionModel.findOne({ pid: a.body.data.id }).lean()).closeReason).toBe('superseded');
    const beat = await sdk(ctx.secret).post(`/sessions/${b.body.data.id}/heartbeat`).send({});
    expect(beat.status).toBe(200);
    await sdk(ctx.secret).post(`/sessions/${b.body.data.id}/close`).send({ minutes: 500 });
    await telemetryService.rollup();
    await telemetryService.rollup();
    const rollup = await PlayRollupModel.findOne({ userId: ctx.player.user._id, gameId: ctx.game._id }).lean();
    expect(rollup.sessions).toBe(3);
    expect(rollup.minutes).toBe(0);
  });

  it('SDK purchases need the player’s game grant', async () => {
    const ctx = await setup();
    const extra = await ctx.creator.agent.post(`/api/v1/games/${ctx.game.pid}/items`).send(living({ name: 'Second blade' }));
    const intentNoGrant = await sdk(ctx.secret).post('/checkout/intents').set('Idempotency-Key', `${unique('k')}12345678`).send({ itemDefinitionId: extra.body.data.id });
    expect(intentNoGrant.status).toBe(401);
    expect(intentNoGrant.body.error.code).toBe('passport_grant_required');
    const grant = await ctx.player.agent.post('/api/v1/passport/me/game-grants').send({ gameId: ctx.game.pid });
    const intent = await sdk(ctx.secret)
      .post('/checkout/intents')
      .set('Idempotency-Key', `${unique('k')}12345678`)
      .set('X-Sverse-Passport-Token', grant.body.data.token)
      .send({ itemDefinitionId: extra.body.data.id });
    expect(intent.status).toBe(201);
    const confirm = await sdk(ctx.secret).post(`/checkout/intents/${intent.body.data.id}/confirm`).set('X-Sverse-Passport-Token', grant.body.data.token).send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.status).toBe('completed');
  });
});
