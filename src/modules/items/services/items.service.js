import { z } from 'zod';

import { INTEROP_TIERS, ITEM_KINDS, STACKABLE_KINDS, levelIndex, tierIndex } from '../../../config/constants.js';
import { Conflict, NotFound, Unprocessable } from '../../../lib/errors.js';
import { publicId } from '../../../lib/ids.js';
import { publicAssetUrl } from '../../../lib/assets.js';
import { fromUnits, toBigInt, usdSnapshot } from '../../../lib/money.js';
import { GameModel } from '../../games/models/index.js';
import { AssetLicenseModel, ItemDefinitionModel, TraitSchemaModel } from '../models/index.js';

export const itemsService = {
  async listSchemas({ status = 'active' } = {}) {
    const schemas = await TraitSchemaModel.find(status ? { status } : {}).sort({ schemaId: 1 }).lean();
    return schemas.map(mapTraitSchema);
  },

  async getSchema(schemaId) {
    const schema = await TraitSchemaModel.findOne({ schemaId }).lean();
    if (!schema) throw NotFound('schema_not_found');
    return schema;
  },

  /** Validates `traits` against a trait schema, with field-level details (T08). */
  validateTraits(schema, traits = {}) {
    const shape = {};
    for (const field of schema.fields ?? []) {
      let rule;
      if (field.type === 'int') rule = z.number().int();
      else if (field.type === 'number') rule = z.number();
      else if (field.type === 'bool') rule = z.boolean();
      else if (field.type === 'enum') rule = z.enum(field.values?.length ? field.values : ['']);
      else rule = z.string().max(200);
      if (typeof field.min === 'number' && rule.min) rule = rule.min(field.min);
      if (typeof field.max === 'number' && rule.max) rule = rule.max(field.max);
      shape[field.name] = field.required ? rule : rule.optional();
    }
    const result = z.object(shape).passthrough().safeParse(traits ?? {});
    if (!result.success) {
      throw Unprocessable('invalid_traits', {
        message: `Traits do not satisfy ${schema.schemaId}.`,
        details: result.error.issues.map((issue) => ({ field: `traits.${issue.path.join('.')}`, issue: issue.message })),
      });
    }
    return result.data;
  },

  /** Highest tier both the schema and the requested tier allow. */
  resolveInteropTier(schema, requested = 'T0') {
    if (!schema) return 'T0';
    const allowed = schema.allowedInteropTiers?.length ? schema.allowedInteropTiers : ['T0'];
    const maxAllowed = allowed.reduce((best, tier) => (tierIndex(tier) > tierIndex(best) ? tier : best), 'T0');
    return tierIndex(requested) > tierIndex(maxAllowed) ? maxAllowed : requested;
  },

  async createDefinition({ studio, game, input }, session) {
    const prepared = await prepareDefinition({ game, input });
    if (await ItemDefinitionModel.exists({ gameId: game._id, sku: prepared.sku }).session(session ?? null)) throw Conflict('sku_taken');
    const [created] = await ItemDefinitionModel.create(
      [{ pid: publicId('itd'), gameId: game._id, studioId: studio._id, ...prepared, status: input.status ?? 'active' }],
      { session },
    );
    await refreshPriceFrom(game._id, session);
    return created.toObject();
  },

  async updateDefinition({ item, game, patch }) {
    const doc = await ItemDefinitionModel.findById(item._id);
    if (!doc) throw NotFound('item_not_found');

    if (patch.priceUnits !== undefined) {
      if (toBigInt(patch.priceUnits) <= 0n) throw Unprocessable('invalid_price');
      doc.priceUnits = toBigInt(patch.priceUnits);
    }
    if (patch.tokenizationLevel !== undefined) {
      if (levelIndex(patch.tokenizationLevel) < levelIndex(doc.tokenizationLevel)) {
        throw Unprocessable('level_downgrade_forbidden', {
          message: `Item is at ${doc.tokenizationLevel}; cannot move to ${patch.tokenizationLevel}. Ownership is not revocable.`,
        });
      }
      doc.tokenizationLevel = patch.tokenizationLevel;
    }
    if (patch.supplyMax !== undefined) {
      if (patch.supplyMax === null) {
        doc.supply.type = 'unlimited';
        doc.supply.max = null;
      } else {
        if (patch.supplyMax < doc.supply.minted) throw Unprocessable('supply_below_minted');
        if (doc.chain?.status === 'confirmed' && doc.supply.max !== null && patch.supplyMax < doc.supply.max) {
          throw Unprocessable('supply_fixed_on_chain');
        }
        doc.supply.type = 'limited';
        doc.supply.max = patch.supplyMax;
      }
    }
    for (const field of ['name', 'description', 'slot']) if (patch[field] !== undefined) doc[field] = patch[field];
    if (patch.art) doc.art = { ...doc.art, ...patch.art };
    if (patch.traits !== undefined) {
      const schema = doc.schemaId ? await this.getSchema(doc.schemaId) : null;
      doc.traits = schema ? this.validateTraits(schema, patch.traits) : patch.traits;
    }
    if (patch.status === 'active' && doc.status === 'draft') doc.status = 'active';
    await doc.save();
    await refreshPriceFrom(game._id);
    return doc.toObject();
  },

  async archive(item) {
    // Archiving stops new sales; owned instances are never touched (UC-21).
    const updated = await ItemDefinitionModel.findOneAndUpdate(
      { _id: item._id },
      { $set: { status: 'archived' } },
      { new: true },
    ).lean();
    await refreshPriceFrom(item.gameId);
    return updated;
  },

  async findByPid(pid, { activeOnly = false } = {}) {
    const item = await ItemDefinitionModel.findOne({ pid, ...(activeOnly ? { status: 'active' } : {}) }).lean();
    if (!item) throw NotFound('item_not_found');
    return item;
  },

  async listForGame(gameId, { includeInactive = false } = {}) {
    const filter = { gameId };
    if (!includeInactive) filter.status = 'active';
    return ItemDefinitionModel.find(filter).sort({ priceUnits: 1, createdAt: 1 }).lean();
  },

  /** Atomic supply reservation: `$inc` guarded by `minted + qty <= max` prevents oversell. */
  async reserveSupply(item, quantity, session) {
    const filter = { _id: item._id, status: 'active' };
    if (item.supply?.type === 'limited') {
      filter.$expr = { $lte: [{ $add: ['$supply.minted', quantity] }, '$supply.max'] };
    }
    const result = await ItemDefinitionModel.updateOne(filter, { $inc: { 'supply.minted': quantity } }, { session });
    if (result.modifiedCount !== 1) throw Conflict('sold_out');
  },

  async releaseSupply(itemId, quantity, session) {
    await ItemDefinitionModel.updateOne({ _id: itemId, 'supply.minted': { $gte: quantity } }, { $inc: { 'supply.minted': -quantity } }, { session });
  },

  async ensureLicense(studio, type = 'display_only', session) {
    const existing = await AssetLicenseModel.findOne({ studioId: studio._id, type, status: 'active' }).session(session ?? null).lean();
    if (existing) return existing;
    const [license] = await AssetLicenseModel.create(
      [{ pid: publicId('lic'), studioId: studio._id, type, royaltyBps: 500, terms: defaultLicenseTerms(type) }],
      { session },
    );
    return license.toObject();
  },
};

export function mapItemDefinition(item, { owned = false, game = null } = {}) {
  const supply = item.supply ?? { type: 'unlimited', minted: 0 };
  return {
    id: item.pid,
    sku: item.sku,
    name: item.name,
    description: item.description,
    kind: item.kind,
    priceUnits: toBigInt(item.priceUnits).toString(),
    priceSrv: fromUnits(item.priceUnits),
    priceUsdSnapshot: usdSnapshot(item.priceUnits),
    interopTier: item.interopTier,
    tokenizationLevel: item.tokenizationLevel,
    schemaId: item.schemaId,
    slot: item.slot,
    traits: item.traits ?? {},
    transferable: item.transferable,
    stackable: item.stackable,
    royaltyBps: item.royaltyBps,
    supply: {
      type: supply.type,
      max: supply.max ?? null,
      minted: supply.minted ?? 0,
      remaining: supply.type === 'limited' ? Math.max(0, (supply.max ?? 0) - (supply.minted ?? 0)) : null,
    },
    art: { url: publicAssetUrl(item.art?.url ?? ''), emoji: item.art?.emoji ?? '📦' },
    chain: { definitionId: item.chain?.definitionId ?? null, status: item.chain?.status ?? 'none' },
    status: item.status,
    owned,
    ...(game ? { game: { id: game.pid, slug: game.slug, title: game.title } } : {}),
  };
}

export function mapTraitSchema(schema) {
  return {
    id: schema.pid,
    schemaId: schema.schemaId,
    class: schema.class,
    subclass: schema.subclass,
    version: schema.version,
    fields: schema.fields,
    mutation: schema.mutation,
    allowedInteropTiers: schema.allowedInteropTiers,
    status: schema.status,
  };
}

async function prepareDefinition({ game, input }) {
  if (!ITEM_KINDS.includes(input.kind)) throw Unprocessable('invalid_kind');
  if (toBigInt(input.priceUnits) <= 0n) throw Unprocessable('invalid_price');

  let schema = null;
  let traits = input.traits ?? {};
  if (input.schemaId) {
    schema = await TraitSchemaModel.findOne({ schemaId: input.schemaId }).lean();
    if (!schema || schema.status !== 'active') throw Unprocessable('schema_not_active');
    traits = itemsService.validateTraits(schema, traits);
  }
  const requestedTier = INTEROP_TIERS.includes(input.interopTier) ? input.interopTier : schema ? 'T1' : 'T0';
  const level = input.tokenizationLevel ?? (input.kind === 'living' ? 'L3' : game.tokenizationLevel === 'L0' ? 'L0' : 'L2');
  if (levelIndex(level) < levelIndex(game.tokenizationLevel) && game.status === 'live') {
    throw Unprocessable('level_below_game');
  }
  const max = input.supplyMax ?? input.supply?.max ?? null;
  return {
    sku: input.sku,
    name: input.name,
    description: input.description ?? '',
    kind: input.kind,
    priceUnits: toBigInt(input.priceUnits),
    schemaId: schema?.schemaId ?? null,
    interopTier: itemsService.resolveInteropTier(schema, requestedTier),
    tokenizationLevel: level,
    slot: input.slot ?? (typeof traits.slot === 'string' ? traits.slot : null),
    supply: max ? { type: 'limited', max, minted: 0 } : { type: 'unlimited', max: null, minted: 0 },
    traits,
    mutation: { traits: schema?.mutation?.traits ?? [] },
    transferable: input.transferable ?? input.kind !== 'pass',
    stackable: input.stackable ?? STACKABLE_KINDS.includes(input.kind),
    royaltyBps: Math.min(2000, Math.max(0, input.royaltyBps ?? 500)),
    art: { url: input.art?.url ?? '', emoji: input.art?.emoji ?? '📦' },
  };
}

async function refreshPriceFrom(gameId, session) {
  const cheapest = await ItemDefinitionModel.findOne({ gameId, status: 'active' })
    .sort({ priceUnits: 1 })
    .session(session ?? null)
    .select('priceUnits')
    .lean();
  await GameModel.updateOne({ _id: gameId }, { $set: { priceFromUnits: cheapest ? toBigInt(cheapest.priceUnits) : 0n } }, { session });
}

function defaultLicenseTerms(type) {
  return {
    display_only: 'Participating games may render this asset as published. No modification, no resale of the art.',
    derivative: 'Participating games may adapt this asset to their art style. Royalty applies on resale.',
    commercial: 'Participating games may use this asset commercially. Royalty applies on resale.',
  }[type];
}
