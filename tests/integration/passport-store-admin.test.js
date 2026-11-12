import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, buy, cosmetic, createLiveGame, living, registerPlayer } from '../helpers.js';
import { GameModel } from '../../src/modules/games/models/index.js';
import { InventoryItemModel } from '../../src/modules/inventory/models/index.js';
import { PlayRollupModel, PlaySessionModel } from '../../src/modules/telemetry/models/index.js';
import { telemetryService } from '../../src/modules/telemetry/services/telemetry.service.js';
import { UserModel } from '../../src/modules/auth/models/index.js';
import { startScheduler } from '../../src/jobs/scheduler.js';
import { JobLockModel } from '../../src/db/system-models.js';
import { publicId } from '../../src/lib/ids.js';

describe('wardrobe (UC-14, T05)', () => {
  it('equipping a second torso item displaces the first in one operation; T0 is not interoperable', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ name: 'Jacket A' }), cosmetic({ name: 'Jacket B' }), cosmetic({ name: 'Plain', schemaId: null, interopTier: 'T0', traits: {} })] });
    const player = await registerPlayer({ fund: 1_000_000_000n });
    const a = await buy(player.agent, items[0].id);
    const b = await buy(player.agent, items[1].id);
    const plain = await buy(player.agent, items[2].id);
    const first = await player.agent.patch('/api/v1/passport/me/wardrobe').send({ equip: [a.body.data.inventoryItem.id] });
    expect(first.body.data.equipped.map((row) => row.inventoryItemId)).toEqual([a.body.data.inventoryItem.id]);
    const second = await player.agent.patch('/api/v1/passport/me/wardrobe').send({ equip: [b.body.data.inventoryItem.id] });
    expect(second.body.data.equipped.map((row) => row.inventoryItemId)).toEqual([b.body.data.inventoryItem.id]);
    const t0 = await player.agent.patch('/api/v1/passport/me/wardrobe').send({ equip: [plain.body.data.inventoryItem.id] });
    expect(t0.status).toBe(422);
    expect(t0.body.error.code).toBe('not_interoperable');
  });

  it('renderTargets list other live games whose envelope accepts the schema at T1', async () => {
    const origin = await createLiveGame({ items: [cosmetic()] });
    const host = await createLiveGame();
    await host.creator.agent.put(`/api/v1/games/${host.game.pid}/envelope`).send({ acceptsTierMax: 'T1', accepts: [{ schemaId: 'sts/cosmetic/wearable/v1', tierMax: 'T1', mapping: {} }] });
    const player = await registerPlayer({ fund: 500_000_000n });
    const bought = await buy(player.agent, origin.items[0].id);
    const wardrobe = await player.agent.get('/api/v1/passport/me/wardrobe');
    const item = wardrobe.body.data.candidates.find((row) => row.id === bought.body.data.inventoryItem.id);
    expect(item.renderTargets.map((target) => target.gameId)).toContain(host.game.pid);
  });
});

describe('store (UC-04, UC-05, T07)', () => {
  it('lists live games by Proof-of-Play, filters, paginates and prepends the owner’s drafts', async () => {
    const { creator } = await createLiveGame();
    const draft = await creator.agent.post('/api/v1/studios/me/games').send({ title: 'Secret Draft', genre: 'cozy' });
    await GameModel.updateMany({ status: 'live' }, { $inc: { 'stats.proofOfPlayScore': 0 } });
    const page1 = await request(app).get('/api/v1/games?limit=1');
    expect(page1.status).toBe(200);
    expect(page1.body.meta.hasMore).toBe(true);
    const page2 = await request(app).get(`/api/v1/games?limit=1&cursor=${page1.body.meta.nextCursor}`);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    expect((await request(app).get('/api/v1/games?sort=downloads')).body.error.code).toBe('invalid_sort');
    expect((await request(app).get('/api/v1/games?genre=action_rpg')).body.data.every((game) => game.genre === 'action_rpg')).toBe(true);

    const mine = await creator.agent.get('/api/v1/games');
    expect(mine.body.data[0]).toMatchObject({ id: draft.body.data.id, mine: true });
    expect((await request(app).get('/api/v1/games')).body.data.some((game) => game.id === draft.body.data.id)).toBe(false);
  });

  it('unpublished games are 404 to strangers (never 403) and 200 to the owner', async () => {
    const { creator } = await createLiveGame();
    const draft = await creator.agent.post('/api/v1/studios/me/games').send({ title: 'Hidden Draft', genre: 'cozy' });
    const stranger = await request(app).get(`/api/v1/games/${draft.body.data.slug}`);
    expect(stranger.status).toBe(404);
    expect((await creator.agent.get(`/api/v1/games/${draft.body.data.slug}`)).status).toBe(200);
  });

  it('item rows carry owned flags for the caller', async () => {
    const { game, items } = await createLiveGame({ items: [cosmetic()] });
    const player = await registerPlayer({ fund: 500_000_000n });
    await buy(player.agent, items[0].id);
    const res = await player.agent.get(`/api/v1/games/${game.slug}/items`);
    expect(res.body.data[0].owned).toBe(true);
    expect((await request(app).get(`/api/v1/games/${game.slug}/items`)).body.data[0].owned).toBe(false);
  });

  it('the entitlement lookup is served by the {gameId, userId} index alone', async () => {
    const { game, items } = await createLiveGame({ items: [cosmetic()] });
    const player = await registerPlayer({ fund: 500_000_000n });
    await buy(player.agent, items[0].id);
    const plan = await InventoryItemModel.find({ gameId: game._id, userId: player.user._id, status: { $in: ['owned', 'listed'] } }).explain('queryPlanner');
    const text = JSON.stringify(plan, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    expect(text).toContain('IXSCAN');
    expect(text).not.toContain('COLLSCAN');
    expect(text).not.toContain('$lookup');
  });
});

describe('passport', () => {
  it('the testnet faucet credits once per 24h', async () => {
    const player = await registerPlayer();
    const first = await player.agent.post('/api/v1/passport/me/faucet').send({});
    expect(first.status).toBe(200);
    expect(first.body.data.balanceUnits).toBe('1000000000');
    const again = await player.agent.post('/api/v1/passport/me/faucet').send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('faucet_cooldown');
  });

  it('lists orders and inventory with filters', async () => {
    const { items } = await createLiveGame({ items: [cosmetic(), living()] });
    const player = await registerPlayer({ fund: 1_000_000_000n });
    await buy(player.agent, items[0].id);
    await buy(player.agent, items[1].id);
    expect((await player.agent.get('/api/v1/passport/me/orders')).body.data).toHaveLength(2);
    const livingOnly = await player.agent.get('/api/v1/passport/me/inventory?living=true');
    expect(livingOnly.body.data.every((row) => row.kind === 'living')).toBe(true);
    const me = await player.agent.get('/api/v1/passport/me');
    expect(me.body.data.inventory).toEqual({ count: 2, gameCount: 1 });
  });
});

describe('telemetry rollups and stats (T12)', () => {
  it('turns rollups into Proof-of-Play scores and retention, skipping demo-seeded games', async () => {
    const { game } = await createLiveGame();
    const seeded = await createLiveGame();
    await GameModel.updateOne({ _id: seeded.game._id }, { $set: { statsSource: 'seed', 'stats.proofOfPlayScore': 999 } });
    const player = await registerPlayer();
    const day = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    for (const offset of [0, 1, 7]) {
      await PlayRollupModel.create({ pid: publicId('rol'), userId: player.user._id, gameId: game._id, date: day(offset), minutes: 30, sessions: 1, reputationWeight: 0.5, weightedMinutes: 15, epoch: 1 });
    }
    await telemetryService.refreshGameStats();
    const stats = (await GameModel.findById(game._id).lean()).stats;
    expect(stats.proofOfPlayScore).toBeGreaterThan(15);
    expect(stats.dau).toBe(1);
    expect(stats.mau).toBe(1);
    expect((await GameModel.findById(seeded.game._id).lean()).stats.proofOfPlayScore).toBe(999);
  });

  it('recomputes reputation from observed behaviour', async () => {
    const player = await registerPlayer();
    // createdAt is immutable through Mongoose; age the account at the driver level.
    await UserModel.collection.updateOne({ _id: player.user._id }, { $set: { createdAt: new Date(Date.now() - 400 * 86_400_000), lastSeenAt: new Date() } });
    await PlayRollupModel.create({ pid: publicId('rol'), userId: player.user._id, gameId: player.user._id, date: '2026-01-01', minutes: 40_000, sessions: 100, reputationWeight: 1, weightedMinutes: 40_000, epoch: 1 });
    await telemetryService.refreshReputation();
    expect((await UserModel.findById(player.user._id).lean()).reputation).toBeGreaterThan(40);
  });

  it('the sweeper closes silent sessions at their last heartbeat', async () => {
    const { game } = await createLiveGame();
    const player = await registerPlayer();
    const last = new Date(Date.now() - 6 * 60_000);
    const session = await PlaySessionModel.create({ pid: publicId('ses'), userId: player.user._id, gameId: game._id, startedAt: last, lastHeartbeatAt: last });
    await telemetryService.sweepTimeouts();
    const closed = await PlaySessionModel.findById(session._id).lean();
    expect(closed.closedAt.getTime()).toBe(last.getTime());
    expect(closed.closeReason).toBe('timeout');
  });
});

describe('admin console API', () => {
  it('moderators suspend and reinstate users with an audited reason; admins edit roles and see chain ops', async () => {
    const moderator = await registerPlayer({ roles: ['player', 'moderator'] });
    const admin = await registerPlayer({ roles: ['player', 'admin'] });
    const target = await registerPlayer();
    expect((await moderator.agent.post(`/admin/v1/users/${target.id}/suspend`).send({})).status).toBe(400);
    expect((await moderator.agent.post(`/admin/v1/users/${target.id}/suspend`).send({ reason: 'spam wave' })).body.data.status).toBe('suspended');
    expect((await target.agent.get('/api/v1/passport/me')).body.error.code).toBe('account_suspended');
    expect((await moderator.agent.post(`/admin/v1/users/${target.id}/reinstate`).send({ reason: 'appeal accepted' })).body.data.status).toBe('active');
    expect((await moderator.agent.post(`/admin/v1/users/${target.id}/roles`).send({ roles: ['curator'] })).status).toBe(404);
    expect((await admin.agent.post(`/admin/v1/users/${target.id}/roles`).send({ roles: ['curator'], reason: 'top guide writer' })).body.data.roles).toContain('curator');

    const audit = await admin.agent.get(`/admin/v1/audit-log?targetType=user&targetId=${target.id}`);
    expect(audit.body.data.map((row) => row.action)).toEqual(expect.arrayContaining(['user.suspended', 'user.active', 'user.roles']));
    expect((await admin.agent.get('/admin/v1/users?q=' + target.handle)).body.data).toHaveLength(1);
    expect((await admin.agent.get('/admin/v1/studios')).status).toBe(200);
    expect((await admin.agent.get('/admin/v1/chain/ops')).status).toBe(200);
    expect((await admin.agent.get('/admin/v1/chain/reconciliation')).body.data.healthy).toBe(true);
    expect((await admin.agent.get('/admin/v1/chain/health')).body.data.adapter).toBe('mock');
    expect((await admin.agent.get('/admin/v1/epochs')).status).toBe(200);
    expect((await admin.agent.get('/admin/v1/ledger/entries?limit=5')).body.data.length).toBeLessThanOrEqual(5);
  });
});

describe('scheduler', () => {
  it('runs each job under a lease and records the outcome', async () => {
    let runs = 0;
    const scheduler = startScheduler({ jobs: [{ name: `test-job-${Date.now()}`, everyMs: 50, run: async () => ({ ran: ++runs }) }] });
    // The first tick is jittered by up to a second; poll rather than sleep a fixed time.
    for (let i = 0; i < 50 && runs === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();
    expect(runs).toBeGreaterThan(0);
    let lock = await JobLockModel.findOne({ name: /^test-job-/ }).lean();
    for (let i = 0; i < 20 && !lock?.lastRunAt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      lock = await JobLockModel.findOne({ name: /^test-job-/ }).lean();
    }
    expect(lock.owner).toBe(scheduler.owner);
    expect(lock.lastRunAt).toBeTruthy();
  });
});
