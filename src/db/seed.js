import mongoose from 'mongoose';

import { chainAdapter } from '../adapters/chain/index.js';
import { env } from '../config/env.js';
import { REWARD_CHANNEL_SPLIT } from '../config/constants.js';
import { epochBounds, epochNumberAt } from '../lib/epoch.js';
import { randomToken } from '../lib/hmac.js';
import { publicId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { buildMerkleTree, rewardLeaf } from '../lib/merkle.js';
import { hashPassword } from '../lib/password.js';
import { toBigInt } from '../lib/money.js';
import { withTransaction } from '../lib/transaction.js';
import { UserModel } from '../modules/auth/models/index.js';
import { chainService } from '../modules/chain/services/chain.service.js';
import { ClubModel, ClubPostModel } from '../modules/clubs/models/index.js';
import { rankScore } from '../modules/clubs/services/clubs.service.js';
import { DeedModel, DeedStatusModel } from '../modules/deeds/models/index.js';
import { GameModel } from '../modules/games/models/index.js';
import { InventoryItemModel } from '../modules/inventory/models/index.js';
import { inventoryService } from '../modules/inventory/services/inventory.service.js';
import { InteropEnvelopeModel } from '../modules/interop/models/index.js';
import { AssetLicenseModel, ItemDefinitionModel, TraitSchemaModel } from '../modules/items/models/index.js';
import { ledgerService } from '../modules/ledger/services/ledger.service.js';
import { ListingModel } from '../modules/market/models/index.js';
import { ReviewCaseModel } from '../modules/review/models/index.js';
import { RewardClaimModel, RewardEpochModel } from '../modules/rewards/models/index.js';
import { StudioModel } from '../modules/studios/models/index.js';
import { nextSequence } from './system-models.js';
import {
  demoPassword,
  gameCoverUrl,
  generateSeedImages,
  getBlueprintGames,
  getBlueprintItems,
  itemArtUrl,
  resolveAssetBaseUrl,
  studioAvatarUrl,
  studioBlueprints,
} from './seed-blueprints.js';

const BOND_UNITS = 250_000_000n;

/** Trait schema registry (07 §7). Effects are declarative so studios cannot ship trait code. */
export const TRAIT_SCHEMAS = [
  {
    schemaId: 'sts/weapon/melee/v1',
    class: 'weapon',
    subclass: 'melee',
    fields: [
      { name: 'power_tier', type: 'int', min: 1, max: 5 },
      { name: 'rarity', type: 'enum', values: ['common', 'rare', 'epic', 'legendary'] },
      { name: 'element', type: 'enum', values: ['none', 'fire', 'ice', 'void'] },
      { name: 'slot', type: 'enum', values: ['main_hand', 'off_hand'] },
      { name: 'level', type: 'int', min: 0, max: 100 },
      { name: 'wear', type: 'number', min: 0, max: 1 },
      { name: 'kills', type: 'int', min: 0 },
    ],
    mutation: {
      traits: ['level', 'wear', 'kills'],
      deedTypes: ['boss_defeated', 'kills', 'tournament_top8', 'flawless_run', 'first_clear'],
      maxVelocity: [
        { deedType: 'boss_defeated', max: 20, windowHours: 24 },
        { deedType: 'kills', max: 5000, windowHours: 24 },
        { deedType: 'first_clear', max: 5, windowHours: 24 },
      ],
      effects: [
        { deedType: 'boss_defeated', trait: 'level', op: 'inc', by: 1 },
        { deedType: 'boss_defeated', trait: 'kills', op: 'inc', by: 1 },
        { deedType: 'kills', trait: 'kills', op: 'inc', from: 'count' },
        { deedType: 'flawless_run', trait: 'wear', op: 'inc', by: 0.01 },
        { deedType: 'first_clear', trait: 'level', op: 'inc', by: 2 },
      ],
    },
    allowedInteropTiers: ['T0', 'T1', 'T2'],
  },
  {
    schemaId: 'sts/weapon/relic/v1',
    class: 'weapon',
    subclass: 'relic',
    fields: [
      { name: 'rarity', type: 'enum', values: ['common', 'rare', 'epic', 'legendary'] },
      { name: 'slot', type: 'enum', values: ['off_hand', 'trinket'] },
      { name: 'level', type: 'int', min: 0, max: 100 },
      { name: 'escapes', type: 'int', min: 0 },
    ],
    mutation: {
      traits: ['level', 'escapes'],
      deedTypes: ['escape', 'marathon_run', 'first_clear'],
      maxVelocity: [{ deedType: 'escape', max: 50, windowHours: 24 }, { deedType: 'marathon_run', max: 2, windowHours: 24 }],
      effects: [
        { deedType: 'escape', trait: 'escapes', op: 'inc', by: 1 },
        { deedType: 'marathon_run', trait: 'level', op: 'inc', by: 1 },
        { deedType: 'first_clear', trait: 'level', op: 'inc', by: 2 },
      ],
    },
    allowedInteropTiers: ['T0', 'T1', 'T2'],
  },
  {
    schemaId: 'sts/vehicle/capital/v1',
    class: 'vehicle',
    subclass: 'capital',
    fields: [
      { name: 'rarity', type: 'enum', values: ['common', 'rare', 'epic', 'legendary'] },
      { name: 'slot', type: 'enum', values: ['vehicle_core'] },
      { name: 'hull_class', type: 'int', min: 1, max: 5 },
      { name: 'engagements', type: 'int', min: 0 },
    ],
    mutation: {
      traits: ['engagements'],
      deedTypes: ['fleet_wiped', 'engagement_won'],
      maxVelocity: [{ deedType: 'fleet_wiped', max: 10, windowHours: 24 }],
      effects: [
        { deedType: 'fleet_wiped', trait: 'engagements', op: 'inc', by: 1 },
        { deedType: 'engagement_won', trait: 'engagements', op: 'inc', by: 1 },
      ],
    },
    allowedInteropTiers: ['T0', 'T1', 'T2'],
  },
  cosmeticSchema('sts/cosmetic/wearable/v1', 'wearable', ['torso', 'head', 'legs', 'back']),
  cosmeticSchema('sts/cosmetic/trail/v1', 'trail', ['trail']),
  cosmeticSchema('sts/cosmetic/banner/v1', 'banner', ['banner']),
  cosmeticSchema('sts/cosmetic/vehicle/v1', 'vehicle_skin', ['vehicle_skin']),
  { schemaId: 'sts/bundle/v1', class: 'bundle', subclass: '', fields: [], mutation: {}, allowedInteropTiers: ['T0', 'T1', 'T2'] },
  { schemaId: 'sts/consumable/charge/v1', class: 'consumable', subclass: 'charge', fields: [], mutation: {}, allowedInteropTiers: ['T0'] },
  {
    schemaId: 'sts/content/chapter/v1',
    class: 'content',
    subclass: 'chapter',
    fields: [{ name: 'chapter', type: 'int', min: 1 }],
    mutation: {},
    allowedInteropTiers: ['T0'],
  },
];

export async function seedDatabase({ reset = false, generateImages = false, forceImages = reset } = {}) {
  if (reset) {
    if (env.NODE_ENV === 'production' && !env.SEED_ALLOW_RESET) {
      throw new Error('Refusing to reset a production database without SEED_ALLOW_RESET=true.');
    }
    await clearDatabase();
  } else if (await GameModel.exists({})) {
    return { skipped: true };
  }

  await withTransaction((session) => ledgerService.ensureSystemAccounts(session));
  await seedTraitSchemas();

  const assetBaseUrl = resolveAssetBaseUrl();
  if (generateImages) await generateSeedImages({ assetBaseUrl, forceImages });
  const passwordHash = await hashPassword(demoPassword);

  const users = new Map();
  const studios = new Map();
  const games = new Map();
  const items = new Map();

  for (const entry of studioBlueprints) {
    const user = await createUser({ ...entry.owner, passwordHash });
    users.set(entry.owner.pid, user);
    await fundWallet(user, toBigInt(entry.owner.balanceUnits), 'seed: demo balance');

    const studio = await createStudio(entry, user, assetBaseUrl);
    studios.set(entry.studio.pid, studio);

    for (const blueprint of getBlueprintGames(entry)) {
      const game = await createGame(entry, blueprint, studio, assetBaseUrl);
      games.set(blueprint.slug, game);
    }
    for (const blueprint of getBlueprintItems(entry)) {
      const game = games.get(blueprint.gameSlug ?? getBlueprintGames(entry)[0].slug);
      const item = await createItem(blueprint, game, studio, assetBaseUrl);
      items.set(blueprint.pid, item);
    }
  }

  await seedEnvelopes(games);
  const fans = await seedFans(passwordHash);
  await seedInventoryAndDeeds({ users, items, games, studios, fans });
  await seedClubPosts({ games, users, studios, fans });
  await seedRewards({ kai: users.get('usr_demo') });
  await seedReviewQueue(games);
  const ops = await seedOpsAdmin();

  return {
    studios: studios.size,
    games: games.size,
    items: items.size,
    users: users.size + fans.size + 1,
    opsAdmin: ops.email,
    demoPassword,
  };
}

/** Drops every Sverse collection. Never reachable in production without an explicit flag. */
export async function clearDatabase() {
  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    if (name.startsWith('system.')) continue;
    await mongoose.connection.db.collection(name).deleteMany({});
  }
}

async function seedTraitSchemas() {
  for (const schema of TRAIT_SCHEMAS) {
    const [namespace, , , version] = schema.schemaId.split('/');
    await TraitSchemaModel.updateOne(
      { schemaId: schema.schemaId },
      {
        $set: { ...schema, namespace, version: Number(String(version ?? 'v1').replace('v', '')), status: 'active' },
        $setOnInsert: { pid: publicId('sch') },
      },
      { upsert: true },
    );
  }
}

async function createUser({ pid, handle, handleRaw, email, roles, reputation, playtimeMinutes, spendUnits, clubScore, accountAgeDays, skill, passwordHash }) {
  return withTransaction(async (session) => {
    const custodyIndex = await nextSequence('custody:user', session);
    const { address } = await chainAdapter().createAccount({ kind: 'user', index: custodyIndex });
    const [user] = await UserModel.create(
      [
        {
          pid: pid ?? publicId('usr'),
          handle,
          handleRaw: handleRaw ?? handle,
          email,
          emailVerified: true,
          passwordHash,
          custodialAddress: address,
          custodyIndex,
          roles: roles ?? ['player'],
          reputation: reputation ?? 10,
          reputationSource: 'seed',
          reputationInputs: { playtimeMinutes: playtimeMinutes ?? 0, spendUnits: toBigInt(spendUnits ?? 0), clubScore: clubScore ?? 0, accountAgeDays: accountAgeDays ?? 0, flags: 0 },
          skill: skill ?? { tier: 'unranked', firstClears: 0 },
          referral: { code: `${handle.slice(0, 8)}${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}` },
          createdAt: new Date(Date.now() - (accountAgeDays ?? 0) * 86_400_000),
        },
      ],
      { session },
    );
    await ledgerService.createAccount({ ownerType: 'user', ownerId: user._id, purpose: 'wallet' }, session);
    return user.toObject();
  });
}

async function fundWallet(user, amount, memo) {
  if (amount <= 0n) return;
  await withTransaction(async (session) => {
    await ledgerService.post(
      {
        legs: [
          { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: amount, reason: 'onramp_credit' },
          { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'credit', amountUnits: amount, reason: 'onramp_credit' },
        ],
        refType: 'user',
        refId: user._id,
        memo,
      },
      session,
    );
  });
}

async function createStudio(entry, user, assetBaseUrl) {
  return withTransaction(async (session) => {
    const custodyIndex = await nextSequence('custody:studio', session);
    const { address } = await chainAdapter().createAccount({ kind: 'studio', index: custodyIndex });
    const studioId = new mongoose.Types.ObjectId();
    const vault = await ledgerService.createAccount({ ownerType: 'studio', ownerId: studioId, purpose: 'vault' }, session);
    const bond = await ledgerService.createAccount({ ownerType: 'studio_bond', ownerId: studioId, purpose: 'bond' }, session);
    const [studio] = await StudioModel.create(
      [
        {
          _id: studioId,
          pid: entry.studio.pid,
          ownerUserId: user._id,
          handle: entry.studio.handle,
          displayName: entry.studio.displayName,
          bio: entry.studio.bio,
          avatarUrl: studioAvatarUrl(entry, assetBaseUrl),
          links: { site: `https://${entry.studio.handle.replace(/\./g, '-')}.example.com`, x: `https://x.com/${entry.owner.handle}`, discord: '' },
          vaultAccountId: vault._id,
          bondAccountId: bond._id,
          stakedUnits: BOND_UNITS,
          feeTier: 'standard',
          feeBps: entry.studio.feeBps ?? 1000,
          oneHumanStudio: entry.studio.oneHumanStudio ?? true,
          genesis: true,
          custodyIndex,
          signerAddress: address,
          counters: { games: getBlueprintGames(entry).length, itemsSold: 0, grossUnits: toBigInt(entry.studio.grossUnits ?? 0) },
        },
      ],
      { session },
    );
    await UserModel.updateOne({ _id: user._id }, { $set: { studioId }, $addToSet: { roles: 'creator' } }, { session });

    // Historical revenue arrives as a balanced posting; the dispute-window part stays locked.
    const net = toBigInt(entry.studio.netUnits ?? 0);
    const locked = toBigInt(entry.studio.lockedUnits ?? 0);
    const onramp = await ledgerService.systemAccountId('onramp', session);
    await ledgerService.post(
      {
        legs: [
          { accountId: onramp, direction: 'debit', amountUnits: net + BOND_UNITS, reason: 'onramp_credit' },
          { accountId: vault._id, direction: 'credit', amountUnits: net, reason: 'onramp_credit' },
          { accountId: bond._id, direction: 'credit', amountUnits: BOND_UNITS, reason: 'bond_stake' },
        ],
        refType: 'studio',
        refId: studioId,
        memo: 'seed: historical revenue and listing bond',
      },
      session,
    );
    if (locked > 0n) await ledgerService.lock(vault._id, locked, session);
    await AssetLicenseModel.create(
      [{ pid: publicId('lic'), studioId, type: 'derivative', royaltyBps: 500, terms: 'Participating games may adapt this asset to their art style.' }],
      { session },
    );
    return studio.toObject();
  });
}

async function createGame(entry, blueprint, studio, assetBaseUrl) {
  const cover = gameCoverUrl(entry, blueprint, assetBaseUrl);
  const game = await GameModel.create({
    pid: blueprint.pid,
    slug: blueprint.slug,
    studioId: studio._id,
    title: blueprint.title,
    blurb: blueprint.blurb,
    description: blueprint.description,
    genre: blueprint.genre,
    coverArt: { url: cover, gradient: blueprint.gradient ?? '#7b2ff7,#e935c1', emoji: '' },
    media: [{ url: cover, kind: 'screenshot', order: 0 }],
    buildType: 'web',
    buildUrl: `https://play.sverse.io/${blueprint.slug}`,
    tokenizationLevel: blueprint.tokenizationLevel,
    interopTier: blueprint.interopTier,
    status: 'live',
    submissionNo: 1,
    priceFromUnits: toBigInt(blueprint.priceFromUnits ?? 0),
    stats: { ...blueprint.stats, grossUnits: 0n },
    statsSource: 'seed',
    publishedAt: blueprint.publishedAt ?? new Date('2026-06-01T00:00:00.000Z'),
  });
  const [club] = await ClubModel.create([
    {
      pid: blueprint.club?.id ?? publicId('clb'),
      gameId: game._id,
      studioId: studio._id,
      name: `${blueprint.title} Club`,
      gates: { postRequiresOwnership: blueprint.club?.postRequiresOwnership ?? true },
      counters: { members: blueprint.club?.memberCount ?? 0, posts: 0 },
    },
  ]);
  await GameModel.updateOne({ _id: game._id }, { $set: { clubId: club._id } });
  return { ...game.toObject(), clubId: club._id };
}

async function createItem(blueprint, game, studio, assetBaseUrl) {
  const limited = blueprint.supply?.type === 'limited';
  const traits = defaultTraits(blueprint);
  const schema = TRAIT_SCHEMAS.find((candidate) => candidate.schemaId === blueprint.schemaId);
  const item = await ItemDefinitionModel.create({
    pid: blueprint.pid,
    gameId: game._id,
    studioId: studio._id,
    sku: blueprint.sku,
    name: blueprint.name,
    description: blueprint.description,
    kind: blueprint.kind,
    priceUnits: toBigInt(blueprint.priceUnits),
    schemaId: schema ? blueprint.schemaId : null,
    interopTier: blueprint.interopTier,
    tokenizationLevel: blueprint.kind === 'living' ? 'L3' : game.tokenizationLevel === 'L0' ? 'L0' : 'L2',
    slot: traits.slot ?? null,
    supply: limited ? { type: 'limited', max: blueprint.supply.max, minted: blueprint.supply.minted } : { type: 'unlimited', max: null, minted: blueprint.supply?.minted ?? 0 },
    traits,
    mutation: { traits: schema?.mutation?.traits ?? [] },
    transferable: true,
    stackable: blueprint.kind === 'consumable',
    royaltyBps: 500,
    art: { url: itemArtUrl(blueprint, assetBaseUrl), emoji: '' },
  });
  return item.toObject();
}

async function seedEnvelopes(games) {
  const cosmeticAccepts = ['sts/cosmetic/wearable/v1', 'sts/cosmetic/trail/v1', 'sts/cosmetic/banner/v1', 'sts/cosmetic/vehicle/v1'].map((schemaId) => ({
    schemaId,
    tierMax: 'T1',
    mapping: { slot: { from: 'slot', passthrough: true }, rarity: { from: 'rarity', passthrough: true } },
    clampPolicy: 'reject',
  }));
  for (const game of games.values()) {
    if (game.interopTier === 'T0') continue;
    const accepts = [...cosmeticAccepts];
    if (game.interopTier === 'T2' || game.interopTier === 'T3') {
      accepts.push({
        schemaId: 'sts/weapon/melee/v1',
        tierMax: 'T2',
        powerTierRange: [1, 5],
        mapping: { damage: { from: 'power_tier', curve: 'linear', inRange: [1, 5], outRange: [10, 80] }, rarity: { from: 'rarity', passthrough: true } },
        clampPolicy: 'reject',
      });
      accepts.push({
        schemaId: 'sts/weapon/relic/v1',
        tierMax: 'T2',
        mapping: { focus: { from: 'level', curve: 'linear', inRange: [0, 100], outRange: [1, 20] }, rarity: { from: 'rarity', passthrough: true } },
        clampPolicy: 'reject',
      });
    }
    await InteropEnvelopeModel.create({
      pid: publicId('env'),
      gameId: game._id,
      acceptsTierMax: game.interopTier === 'T1' ? 'T1' : 'T2',
      accepts,
      licenseRequirement: 'display_only',
      feeUnits: 12_000_000n,
      hostSharePct: 50,
    });
  }
}

async function seedFans(passwordHash) {
  const fans = new Map();
  for (const [handle, reputation] of [
    ['ashfan', 8],
    ['runegrinder', 34],
    ['pixelnomad', 62],
  ]) {
    const user = await createUser({ handle, email: `${handle}@example.com`, reputation, accountAgeDays: reputation * 3, passwordHash });
    await fundWallet(user, 500_000_000n, 'seed: demo balance');
    fans.set(handle, user);
  }
  return fans;
}

async function seedInventoryAndDeeds({ users, items, games, studios, fans }) {
  const kai = users.get('usr_demo');
  const mira = users.get('usr_mira');
  const nadia = users.get('usr_nadia');
  const yuu = users.get('usr_yuu');

  const grant = async (user, itemPid, { name, traits, equipped = false } = {}) => {
    const definition = items.get(itemPid);
    if (!definition) return null;
    const game = [...games.values()].find((candidate) => String(candidate._id) === String(definition.gameId));
    const studio = [...studios.values()].find((candidate) => String(candidate._id) === String(definition.studioId));
    const { item, chainOp } = await withTransaction((session) =>
      inventoryService.mint({ user, itemDefinition: definition, game, studio, acquiredVia: 'airdrop', refPid: publicId('seed') }, session),
    );
    await InventoryItemModel.updateOne(
      { _id: item._id },
      { $set: { ...(name ? { name } : {}), ...(traits ? { traits: { ...item.traits, ...traits } } : {}), equipped } },
    );
    if (chainOp) await chainService.kick(chainOp._id, { waitMs: 0 });
    return InventoryItemModel.findById(item._id).lean();
  };

  const blade4412 = await grant(kai, 'itd_vr_blade', { name: 'Voidblade #4412', traits: { power_tier: 4, rarity: 'epic', element: 'fire', slot: 'main_hand', level: 42, wear: 0.18, kills: 4120 } });
  const relic88 = await grant(kai, 'itd_gl_relic', { name: 'Scarbound Relic #88', traits: { rarity: 'rare', slot: 'off_hand', level: 17, escapes: 212 } });
  const hull221 = await grant(kai, 'itd_hf_hull', { name: 'Dreadnought Hull #221', traits: { rarity: 'epic', slot: 'vehicle_core', hull_class: 4, engagements: 31 } });
  await grant(kai, 'itd_vr_jacket', { equipped: true });
  await grant(kai, 'itd_ll_trail', { equipped: true });
  await grant(kai, 'itd_gl_cloak');
  await grant(kai, 'itd_vr_starter');

  const deeds = [
    [blade4412, 'kills', { count: 4120, summary: '4,120 total' }, true, '2026-05-01'],
    [blade4412, 'tournament_top8', { event: 'Ashfall Invitational', placement: 'quarter-final' }, true, '2026-05-08'],
    [blade4412, 'boss_defeated', { boss: 'Ashmaw', difficulty: 'mythic', partySize: 1 }, true, '2026-06-01'],
    [blade4412, 'first_clear', { route: 'Obsidian Spire', difficulty: 'mythic' }, true, '2026-06-12'],
    [relic88, 'marathon_run', { claimed: '14h continuous', playtimeMinutes: 840 }, false, '2026-06-03', 'claimed 840 min, telemetry shows 41 min'],
    [hull221, 'fleet_wiped', { ships: 12 }, null, '2026-06-05'],
  ];
  for (const row of deeds) await insertSeedDeed(...row);

  // Two otherwise identical swords on the market: provenance is what separates their price.
  const blade091 = await grant(mira, 'itd_vr_blade', { name: 'Voidblade #091', traits: { power_tier: 4, rarity: 'epic', element: 'fire', slot: 'main_hand', level: 12, wear: 0.02, kills: 300 } });
  await insertSeedDeed(blade091, 'kills', { count: 300, summary: '300 total' }, true, '2026-06-10');
  const blade3307 = await grant(nadia, 'itd_vr_blade', { name: 'Voidblade #3307', traits: { power_tier: 4, rarity: 'epic', element: 'fire', slot: 'main_hand', level: 39, wear: 0.21, kills: 3880 } });
  for (const [type, detail, date] of [
    ['kills', { count: 3880 }, '2026-05-02'],
    ['boss_defeated', { boss: 'Ashmaw', difficulty: 'mythic', partySize: 1 }, '2026-05-20'],
    ['tournament_top8', { event: 'Ashfall Invitational', placement: 'semi-final' }, '2026-05-28'],
    ['first_clear', { route: 'Obsidian Spire' }, '2026-06-02'],
  ]) {
    await insertSeedDeed(blade3307, type, detail, true, date);
  }
  const relic12 = await grant(nadia, 'itd_gl_relic', { name: 'Scarbound Relic #12', traits: { rarity: 'rare', slot: 'off_hand', level: 22, escapes: 340 } });
  for (const date of ['2026-05-10', '2026-05-18', '2026-06-01']) await insertSeedDeed(relic12, 'escape', { floor: 30 }, true, date);
  const hull77 = await grant(yuu, 'itd_hf_hull', { name: 'Dreadnought Hull #77', traits: { rarity: 'epic', slot: 'vehicle_core', hull_class: 3, engagements: 8 } });
  await insertSeedDeed(hull77, 'fleet_wiped', { ships: 7 }, false, '2026-06-04', 'no play session covering this deed');

  for (const [owner, item, priceUnits] of [
    [mira, blade091, 210_000_000n],
    [nadia, blade3307, 1_840_000_000n],
    [nadia, relic12, 620_000_000n],
    [yuu, hull77, 510_000_000n],
  ]) {
    if (!item) continue;
    await InventoryItemModel.updateOne({ _id: item._id }, { $set: { status: 'listed' } });
    const fresh = await InventoryItemModel.findById(item._id).lean();
    const verified = await DeedStatusModel.countDocuments({ inventoryItemId: item._id, verified: true });
    await ListingModel.create({
      pid: publicId('lst'),
      inventoryItemId: item._id,
      sellerUserId: owner._id,
      gameId: item.gameId,
      studioId: item.studioId,
      schemaId: item.schemaId,
      name: fresh.name,
      artUrl: fresh.artUrl,
      priceUnits,
      royaltyBps: 500,
      protocolBps: env.MARKET_PROTOCOL_FEE_BPS,
      deedCountAtListing: fresh.deedCount,
      verifiedDeedCount: verified,
    });
    await GameModel.updateOne({ _id: item.gameId }, { $inc: { secondaryCount: 1 } });
  }
  void fans;
}

async function insertSeedDeed(item, deedType, detail, verified, date, note = null) {
  if (!item) return;
  const createdAt = new Date(`${date}T12:00:00.000Z`);
  const [deed] = await DeedModel.create([
    {
      pid: publicId('ded'),
      inventoryItemId: item._id,
      tokenId: item.tokenId,
      userId: item.userId,
      gameId: item.gameId,
      studioId: item.studioId,
      deedType,
      detail,
      traitsBefore: item.traits,
      traitsAfter: item.traits,
      epoch: epochNumberAt(createdAt),
      nonce: publicId('seed'),
      studioSignature: 'sha256=seed',
      payloadHash: `sha256:${'0'.repeat(64)}`,
      createdAt,
    },
  ]);
  await DeedStatusModel.create({
    deedId: deed._id,
    inventoryItemId: item._id,
    verified,
    verificationNote: note ?? (verified ? 'seed: verified against telemetry' : null),
    verifiedAt: verified === null ? null : createdAt,
    chain: { status: 'none' },
  });
  await InventoryItemModel.updateOne({ _id: item._id }, { $inc: { deedCount: 1 } });
}

async function seedClubPosts({ games, users, studios, fans }) {
  // The users map holds the pre-studio snapshot; read owners back so studioId is set.
  const owners = await UserModel.find({ _id: { $in: [...users.values()].map((user) => user._id) } }).lean();
  const ownerByStudio = new Map(owners.map((user) => [String(user.studioId), user]));
  const fan = fans.get('ashfan');
  const regular = fans.get('pixelnomad');
  let index = 0;
  for (const game of games.values()) {
    const owner = ownerByStudio.get(String(game.studioId));
    const posts = [
      { author: owner, body: `Patch ${index + 1}.1 is live. The latest route in ${game.title} now rewards cleaner movement and verified clears.`, badges: ['studio'] },
      { author: regular, body: `Wrote a short guide for the new ${game.title} route — the second checkpoint skip saves about 40 seconds.`, badges: ['curator'] },
      { author: fan, body: `Still testing the new item rolls in ${game.title}. Need one more run to confirm the interaction.`, badges: [] },
    ];
    for (const [offset, post] of posts.entries()) {
      const createdAt = new Date(Date.now() - (index * 3 + offset + 1) * 3_600_000);
      const weight = post.author ? (post.author.reputation >= 20 ? 0.2 + ((post.author.reputation - 20) / 80) * 0.8 : (post.author.reputation / 20) ** 2 * 0.2) : 0.5;
      const reactions = { up: Math.max(0, 30 - offset * 12 - index), insightful: offset === 1 ? 6 : 0 };
      await ClubPostModel.create({
        pid: publicId('pst'),
        clubId: game.clubId,
        gameId: game._id,
        channel: 'general',
        authorUserId: post.author?._id ?? null,
        authorHandle: post.author?.handle ?? null,
        kind: 'post',
        body: post.body,
        badges: post.badges,
        repAtPost: post.author?.reputation ?? 0,
        weight: Math.round(weight * 1000) / 1000,
        reactions,
        score: rankScore({ weight, reactions, createdAt }),
        createdAt,
      });
    }
    await ClubModel.updateOne({ _id: game.clubId }, { $inc: { 'counters.posts': posts.length } });
    index += 1;
  }
  void studios;
}

/** A published past epoch with one unclaimed claim for the demo passport, funded and anchored. */
async function seedRewards({ kai }) {
  if (!kai) return;
  const number = Math.max(1, epochNumberAt(new Date()) - 1);
  const { startAt, endAt } = epochBounds(number);
  const channels = [
    { channel: 'ladders', sharePct: REWARD_CHANNEL_SPLIT.ladders, amountUnits: 412_000_000n, note: 'Diamond II · top 8%' },
    { channel: 'tournaments', sharePct: REWARD_CHANNEL_SPLIT.tournaments, amountUnits: 180_000_000n, note: 'quarter-finals' },
    { channel: 'achievement', sharePct: REWARD_CHANNEL_SPLIT.achievement, amountUnits: 240_000_000n, note: '3 first-clears' },
    { channel: 'curation', sharePct: REWARD_CHANNEL_SPLIT.curation, amountUnits: 96_000_000n, note: '2 guides' },
  ];
  const amount = channels.reduce((sum, channel) => sum + channel.amountUnits, 0n);
  const leaf = rewardLeaf({ epochNumber: number, index: 0, account: kai.custodialAddress, amountUnits: amount });
  const { root, proofs } = buildMerkleTree([leaf]);
  const claimDeadline = new Date(Date.now() + env.REWARD_CLAIM_WINDOW_DAYS * 86_400_000);

  const op = await withTransaction(async (session) => {
    const [epoch] = await RewardEpochModel.create(
      [
        {
          pid: publicId('epo'),
          number,
          startAt,
          endAt,
          feeRevenueUnits: 0n,
          bootstrapEmissionUnits: amount,
          playerPoolUnits: amount,
          creatorPoolUnits: 0n,
          distributedUnits: amount,
          channelSplit: REWARD_CHANNEL_SPLIT,
          participants: { players: 1, studios: 0 },
          merkleRoot: root,
          claimDeadline,
          status: 'published',
          closedAt: endAt,
        },
      ],
      { session },
    );
    await ledgerService.post(
      {
        legs: [
          { accountId: await ledgerService.systemAccountId('treasury', session), direction: 'debit', amountUnits: amount, reason: 'reward_funding', allowNegative: true },
          { accountId: await ledgerService.systemAccountId('player_rewards', session), direction: 'credit', amountUnits: amount, reason: 'reward_funding' },
        ],
        refType: 'reward_epoch',
        refId: epoch._id,
        memo: `seed: bootstrap emission epoch ${number}`,
      },
      session,
    );
    await RewardClaimModel.create(
      [
        {
          pid: publicId('clm'),
          epochId: epoch._id,
          epochNumber: number,
          claimantType: 'user',
          claimantId: kai._id,
          claimantAddress: kai.custodialAddress,
          leafIndex: 0,
          amountUnits: amount,
          channels,
          score: 41.62,
          scoreInputs: { ladders: 20.3, tournaments: 8.9, achievement: 11.8, curation: 4.7 },
          merkleProof: proofs[0],
        },
      ],
      { session },
    );
    const chainOp = await chainService.enqueue(
      {
        kind: 'publish_epoch',
        ref: `epoch:${number}`,
        refType: 'reward_epoch',
        refId: epoch._id,
        payload: { epochNumber: number, root, totalUnits: amount.toString(), claimDeadline: claimDeadline.toISOString() },
      },
      session,
    );
    await RewardEpochModel.updateOne({ _id: epoch._id }, { $set: { chainOpId: chainOp._id } }, { session });
    return chainOp;
  });
  await chainService.kick(op._id, { waitMs: 0 });
}

async function seedReviewQueue(games) {
  const game = games.get('lumen-leap');
  if (!game) return;
  const reviewCase = await ReviewCaseModel.create({
    pid: publicId('rvw'),
    kind: 'game_submission',
    gameId: game._id,
    studioId: game.studioId,
    submissionNo: 2,
    checks: [
      { name: 'malware_scan', status: 'passed', evidence: { host: 'play.sverse.io' } },
      { name: 'ip_fingerprint', status: 'passed', evidence: { checked: ['cover_art', 'title'] } },
      { name: 'content_policy', status: 'flagged', evidence: { reason: 'Motion-flash timing in the challenge route trailer needs manual review.' } },
    ],
    outcome: 'escalated',
    reason: 'Flash-heavy challenge route trailer needs moderation confirmation.',
  });
  const doc = await GameModel.findById(game._id);
  doc.status = 'in_review';
  doc.submissionNo = 2;
  doc.reviewCaseId = reviewCase._id;
  await doc.save();
}

async function seedOpsAdmin() {
  const email = env.SEED_ADMIN_EMAIL;
  const supplied = env.SEED_ADMIN_PASSWORD;
  const password = supplied ?? `${randomToken(12)}-9`;
  const user = await createUser({ handle: 'sverse_ops', handleRaw: 'Sverse Ops', email, roles: ['player', 'moderator', 'admin'], reputation: 50, passwordHash: await hashPassword(password) });
  if (!supplied) logger.warn({ email, password }, 'seed_ops_admin_created_store_this_password_now');
  return user;
}

function cosmeticSchema(schemaId, subclass, slots) {
  return {
    schemaId,
    class: 'cosmetic',
    subclass,
    fields: [
      { name: 'slot', type: 'enum', values: slots },
      { name: 'rarity', type: 'enum', values: ['common', 'rare', 'epic', 'legendary'] },
      { name: 'palette', type: 'string' },
    ],
    mutation: {},
    allowedInteropTiers: ['T0', 'T1'],
  };
}

function defaultTraits(blueprint) {
  const rarity = blueprint.kind === 'living' ? 'epic' : 'rare';
  switch (blueprint.schemaId) {
    case 'sts/weapon/melee/v1':
      return { power_tier: 3, rarity, element: 'void', slot: 'main_hand', level: 1, wear: 0, kills: 0 };
    case 'sts/weapon/relic/v1':
      return { rarity, slot: 'off_hand', level: 1, escapes: 0 };
    case 'sts/vehicle/capital/v1':
      return { rarity, slot: 'vehicle_core', hull_class: 3, engagements: 0 };
    case 'sts/cosmetic/wearable/v1':
      return { slot: 'torso', rarity };
    case 'sts/cosmetic/trail/v1':
      return { slot: 'trail', rarity };
    case 'sts/cosmetic/banner/v1':
      return { slot: 'banner', rarity };
    case 'sts/cosmetic/vehicle/v1':
      return { slot: 'vehicle_skin', rarity };
    default:
      return {};
  }
}
