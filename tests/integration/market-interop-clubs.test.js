import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, buy, cosmetic, createLiveGame, living, registerPlayer } from '../helpers.js';
import { InteropImportModel, InteropEnvelopeModel } from '../../src/modules/interop/models/index.js';
import { ClubPostModel } from '../../src/modules/clubs/models/index.js';
import { UserModel } from '../../src/modules/auth/models/index.js';
import { ledgerService } from '../../src/modules/ledger/services/ledger.service.js';
import { toBigInt } from '../../src/lib/money.js';
import { DeedModel } from '../../src/modules/deeds/models/index.js';
import { publicId } from '../../src/lib/ids.js';

describe('secondary market (UC-10)', () => {
  it('splits seller/royalty/protocol, moves ownership and carries the deed history', async () => {
    const { items, studio } = await createLiveGame({ items: [living()] });
    const seller = await registerPlayer({ fund: 500_000_000n });
    const purchase = await buy(seller.agent, items[0].id);
    const inventoryItemId = purchase.body.data.inventoryItem.id;
    const { InventoryItemModel } = await import('../../src/modules/inventory/models/index.js');
    const item = await InventoryItemModel.findOne({ pid: inventoryItemId }).lean();
    await DeedModel.create({ pid: publicId('ded'), inventoryItemId: item._id, userId: item.userId, gameId: item.gameId, studioId: item.studioId, deedType: 'boss_defeated', epoch: 1, nonce: 'nonce-market-1', studioSignature: 'sha256=x', payloadHash: 'sha256:x' });

    const listing = await seller.agent.post('/api/v1/market/listings').send({ inventoryItemId, priceUnits: '1000000000' });
    expect(listing.status).toBe(201);
    expect((await seller.agent.patch('/api/v1/passport/me/wardrobe').send({ equip: [inventoryItemId] })).status).toBe(409);

    const buyer = await registerPlayer({ fund: 2_000_000_000n });
    const publicDeeds = await request(app).get(`/api/v1/items/${inventoryItemId}/deeds`);
    expect(publicDeeds.status).toBe(200);
    expect(publicDeeds.body.data).toHaveLength(1);

    const sellerBefore = toBigInt((await ledgerService.walletFor(seller.user._id)).balanceUnits);
    const vaultBefore = toBigInt((await ledgerService.vaultFor(studio._id)).balanceUnits);
    const res = await buyer.agent.post(`/api/v1/market/listings/${listing.body.data.id}/buy`).send({});
    expect(res.status).toBe(200);
    expect(toBigInt((await ledgerService.walletFor(seller.user._id)).balanceUnits) - sellerBefore).toBe(925_000_000n);
    expect(toBigInt((await ledgerService.vaultFor(studio._id)).balanceUnits) - vaultBefore).toBe(50_000_000n);

    const after = await buyer.agent.get(`/api/v1/items/${inventoryItemId}/deeds`);
    expect(after.body.data).toHaveLength(1);
    const inventory = await buyer.agent.get('/api/v1/passport/me/inventory');
    expect(inventory.body.data.map((row) => row.id)).toContain(inventoryItemId);
    expect((await ledgerService.trialBalance()).balanced).toBe(true);
  });

  it('rejects non-transferable items and stale listings', async () => {
    const { items } = await createLiveGame({ items: [cosmetic({ transferable: false }), living()] });
    const seller = await registerPlayer({ fund: 1_000_000_000n });
    const bound = await buy(seller.agent, items[0].id);
    const nt = await seller.agent.post('/api/v1/market/listings').send({ inventoryItemId: bound.body.data.inventoryItem.id, priceUnits: '10' });
    expect(nt.status).toBe(422);
    expect(nt.body.error.code).toBe('not_transferable');

    const blade = await buy(seller.agent, items[1].id);
    const listing = await seller.agent.post('/api/v1/market/listings').send({ inventoryItemId: blade.body.data.inventoryItem.id, priceUnits: '10000000' });
    const { InventoryItemModel } = await import('../../src/modules/inventory/models/index.js');
    const thief = await registerPlayer();
    await InventoryItemModel.updateOne({ pid: blade.body.data.inventoryItem.id }, { $set: { userId: thief.user._id } });
    const buyer = await registerPlayer({ fund: 100_000_000n });
    const res = await buyer.agent.post(`/api/v1/market/listings/${listing.body.data.id}/buy`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('listing_stale');
    expect((await request(app).get(`/api/v1/market/listings/${listing.body.data.id}`)).body.data.status).toBe('stale');
  });
});

describe('interop import (UC-13)', () => {
  it('runs the four checks, dry-runs for free, charges on commit, and snapshots the envelope', async () => {
    const source = await createLiveGame({ items: [living()] });
    const host = await createLiveGame({ items: [] });
    await host.creator.agent.put(`/api/v1/games/${host.game.pid}/envelope`).send({
      acceptsTierMax: 'T2',
      accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T2', powerTierRange: [1, 5], mapping: { damage: { from: 'power_tier', curve: 'linear', inRange: [1, 5], outRange: [10, 80] } }, clampPolicy: 'reject' }],
      licenseRequirement: 'derivative',
      feeUnits: '12000000',
      hostSharePct: 50,
    });
    const player = await registerPlayer({ fund: 500_000_000n });
    const purchase = await buy(player.agent, source.items[0].id);
    const inventoryItemId = purchase.body.data.inventoryItem.id;

    const dry = await player.agent.post('/api/v1/interop/imports').send({ inventoryItemId, hostGameId: host.game.pid, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.data.checks.map((check) => check.name)).toEqual(['schema_match', 'tier', 'license', 'normalization']);
    expect(dry.body.data.checks.every((check) => check.passed)).toBe(true);
    expect(dry.body.data.mapped.damage).toBe(63);
    const balance = toBigInt((await ledgerService.walletFor(player.user._id)).balanceUnits);

    const commit = await player.agent.post('/api/v1/interop/imports').send({ inventoryItemId, hostGameId: host.game.pid, dryRun: false });
    expect(commit.status).toBe(201);
    expect(balance - toBigInt((await ledgerService.walletFor(player.user._id)).balanceUnits)).toBe(12_000_000n);

    await InteropEnvelopeModel.updateOne({ gameId: host.game._id }, { $set: { 'accepts.0.mapping.damage.outRange': [1, 2] } });
    const record = await InteropImportModel.findOne({ pid: commit.body.data.id }).lean();
    expect(record.envelopeSnapshot.accepts[0].mapping.damage.outRange).toEqual([10, 80]);
    expect((await player.agent.post('/api/v1/interop/imports').send({ inventoryItemId, hostGameId: host.game.pid, dryRun: false })).body.error.code).toBe('already_imported');
  });

  it('names the failing check', async () => {
    const source = await createLiveGame({ items: [cosmetic(), living({ traits: { power_tier: 5, rarity: 'epic', element: 'fire', slot: 'main_hand' } })] });
    const host = await createLiveGame();
    const player = await registerPlayer({ fund: 1_000_000_000n });
    const jacket = await buy(player.agent, source.items[0].id);
    const blade = await buy(player.agent, source.items[1].id);
    const put = (body) => host.creator.agent.put(`/api/v1/games/${host.game.pid}/envelope`).send({ licenseRequirement: 'display_only', feeUnits: '0', ...body });
    const attempt = (id) => player.agent.post('/api/v1/interop/imports').send({ inventoryItemId: id, hostGameId: host.game.pid, dryRun: true });

    await put({ acceptsTierMax: 'T2', accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T2', mapping: {} }] });
    expect((await attempt(jacket.body.data.inventoryItem.id)).body.error.code).toBe('schema_not_accepted');
    await put({ acceptsTierMax: 'T1', accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T1', mapping: {} }] });
    expect((await attempt(blade.body.data.inventoryItem.id)).body.error.code).toBe('tier_too_low');
    await put({ acceptsTierMax: 'T2', licenseRequirement: 'commercial', accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T2', mapping: {} }] });
    expect((await attempt(blade.body.data.inventoryItem.id)).body.error.code).toBe('license_denied');
    await put({ acceptsTierMax: 'T2', accepts: [{ schemaId: 'sts/weapon/melee/v1', tierMax: 'T2', powerTierRange: [1, 3], mapping: {} }] });
    expect((await attempt(blade.body.data.inventoryItem.id)).body.error.code).toBe('normalization_out_of_band');
  });
});

describe('clubs (UC-15…17)', () => {
  it('gates posting on ownership, keeps low-reputation posts visible, and audits moderation', async () => {
    const { creator, game, items } = await createLiveGame({ items: [cosmetic()] });
    const stranger = await registerPlayer();
    const denied = await stranger.agent.post(`/api/v1/games/${game.slug}/club/posts`).send({ body: 'hello' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('gate_not_met');

    const owner = await registerPlayer({ fund: 500_000_000n });
    await buy(owner.agent, items[0].id);
    const post = await owner.agent.post(`/api/v1/games/${game.slug}/club/posts`).send({ body: '<b>first</b> run!' });
    expect(post.status).toBe(201);
    expect(post.body.data.body).toBe('first run!');
    expect(post.body.data.weight).toBe(0);
    expect(post.body.data.lowSignal).toBe(true);

    const feed = await request(app).get(`/api/v1/games/${game.slug}/club/posts`);
    expect(feed.body.data.map((row) => row.id)).toContain(post.body.data.id);

    await UserModel.updateOne({ _id: owner.user._id }, { $set: { reputation: 90 } });
    const high = await owner.agent.post(`/api/v1/games/${game.slug}/club/posts`).send({ body: 'guide' });
    expect(high.body.data.weight).toBeGreaterThan(0.8);

    const hide = await creator.agent.patch(`/api/v1/club/posts/${post.body.data.id}`).send({ status: 'hidden', reason: 'spoilers' });
    expect(hide.status).toBe(200);
    const { AuditLogModel } = await import('../../src/modules/admin/models/index.js');
    expect(await AuditLogModel.countDocuments({ targetId: post.body.data.id, action: 'club_post.hidden' })).toBe(1);
    const persisted = await ClubPostModel.findOne({ pid: post.body.data.id }).lean();
    expect(persisted.status).toBe('hidden');
  });

  it('no code path hides a post for low reputation', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/modules/clubs/services/clubs.service.js', import.meta.url), 'utf8');
    const hiddenWrites = source.match(/status:\s*'hidden'/g) ?? [];
    expect(hiddenWrites).toHaveLength(0);
  });
});
