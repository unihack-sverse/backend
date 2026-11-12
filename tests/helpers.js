import request from 'supertest';

import { createApp } from '../src/app.js';
import { withTransaction } from '../src/lib/transaction.js';
import { ledgerService } from '../src/modules/ledger/services/ledger.service.js';
import { UserModel } from '../src/modules/auth/models/index.js';
import { StudioModel } from '../src/modules/studios/models/index.js';
import { GameModel } from '../src/modules/games/models/index.js';
import { TRAIT_SCHEMAS } from '../src/db/seed.js';
import { TraitSchemaModel } from '../src/modules/items/models/index.js';
import { publicId } from '../src/lib/ids.js';

export const app = createApp();
// One listening server per test file: supertest otherwise opens a server per request, which
// resets connections under the genuinely concurrent invariant tests.
export const server = app.listen(0);
let counter = 0;

export function unique(prefix = 'u') {
  counter += 1;
  return `${prefix}${process.pid % 1000}${counter}${Math.random().toString(36).slice(2, 5)}`.toLowerCase().slice(0, 20);
}

/** A logged-in agent (cookie jar) for a fresh player. */
export async function registerPlayer({ fund = 0n, roles, verified = true } = {}) {
  const handle = unique('p');
  const agent = request.agent(server);
  const res = await agent.post('/api/v1/auth/register').send({ handle, email: `${handle}@test.dev`, password: 'correct-horse-9' });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  if (verified) await UserModel.updateOne({ handle }, { $set: { emailVerified: true } });
  const user = await UserModel.findOne({ handle }).lean();
  if (fund > 0n) await credit(user, fund);
  if (roles) await UserModel.updateOne({ _id: user._id }, { $set: { roles } });
  return { agent, user, handle, id: res.body.data.id };
}

export async function credit(user, amount) {
  await withTransaction(async (session) => {
    await ledgerService.post(
      {
        legs: [
          { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: amount, reason: 'onramp_credit' },
          { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'credit', amountUnits: amount, reason: 'onramp_credit' },
        ],
        refType: 'user',
        refId: user._id,
        memo: 'test credit',
      },
      session,
    );
  });
}

export async function seedSchemas() {
  for (const schema of TRAIT_SCHEMAS) {
    await TraitSchemaModel.updateOne({ schemaId: schema.schemaId }, { $set: { ...schema, status: 'active' }, $setOnInsert: { pid: publicId('sch') } }, { upsert: true });
  }
}

/** Creator with studio, bond staked, and a live game with the given items. */
export async function createLiveGame({ items = [], tokenizationLevel = 'L3', interopTier = 'T2', bond = 250_000_000n } = {}) {
  await seedSchemas();
  const creator = await registerPlayer({ fund: bond + 1_000_000_000n });
  const studioHandle = unique('s');
  const studioRes = await creator.agent.post('/api/v1/studios').send({ handle: studioHandle, displayName: `Studio ${studioHandle}` });
  if (studioRes.status !== 201) throw new Error(`studio failed ${JSON.stringify(studioRes.body)}`);
  const studio = await StudioModel.findOne({ handle: studioHandle }).lean();
  // move funds into vault then stake the bond
  await withTransaction(async (session) => {
    await ledgerService.post(
      {
        legs: [
          { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: bond, reason: 'onramp_credit' },
          { accountId: studio.bondAccountId, direction: 'credit', amountUnits: bond, reason: 'bond_stake' },
        ],
        refType: 'studio',
        refId: studio._id,
      },
      session,
    );
  });
  const gameRes = await creator.agent
    .post('/api/v1/studios/me/games')
    .send({ title: `Game ${unique('g')}`, genre: 'action_rpg', tokenizationLevel, buildUrl: 'https://play.example.com/game' });
  if (gameRes.status !== 201) throw new Error(`game failed ${JSON.stringify(gameRes.body)}`);
  const gamePid = gameRes.body.data.id;
  const created = [];
  for (const item of items) {
    const res = await creator.agent.post(`/api/v1/games/${gamePid}/items`).send(item);
    if (res.status !== 201) throw new Error(`item failed ${JSON.stringify(res.body)}`);
    created.push(res.body.data);
  }
  const doc = await GameModel.findOne({ pid: gamePid });
  doc.status = 'live';
  doc.publishedAt = new Date();
  doc.interopTier = interopTier;
  await doc.save();
  const { clubsService } = await import('../src/modules/clubs/services/clubs.service.js');
  await clubsService.ensureForGame(doc.toObject());
  return { creator, studio: await StudioModel.findById(studio._id).lean(), game: await GameModel.findById(doc._id).lean(), items: created };
}

export async function buy(agent, itemDefinitionId, key = unique('idem') + 'xxxxxxxx') {
  const intent = await agent.post('/api/v1/checkout/intents').set('Idempotency-Key', key).send({ itemDefinitionId });
  if (intent.status !== 201) return intent;
  return agent.post(`/api/v1/checkout/intents/${intent.body.data.id}/confirm`).send({});
}

export const cosmetic = (overrides = {}) => ({
  sku: unique('sku').replace(/[^a-z0-9_]/g, '_'),
  name: 'Ash Jacket',
  kind: 'cosmetic',
  priceUnits: '85000000',
  schemaId: 'sts/cosmetic/wearable/v1',
  interopTier: 'T1',
  traits: { slot: 'torso', rarity: 'rare' },
  ...overrides,
});

export const living = (overrides = {}) => ({
  sku: unique('sku').replace(/[^a-z0-9_]/g, '_'),
  name: 'Voidblade',
  kind: 'living',
  priceUnits: '210000000',
  schemaId: 'sts/weapon/melee/v1',
  interopTier: 'T2',
  traits: { power_tier: 4, rarity: 'epic', element: 'fire', slot: 'main_hand' },
  ...overrides,
});
