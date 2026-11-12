import { tierIndex } from '../../../config/constants.js';
import { Conflict, NotFound, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { applyBps, fromUnits, splitFee, toBigInt } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { AssetLicenseModel, ItemDefinitionModel } from '../../items/models/index.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { InteropEnvelopeModel, InteropImportModel } from '../models/index.js';

const LICENSE_RANK = { display_only: 0, derivative: 1, commercial: 2 };

export const interopService = {
  async getEnvelopeForGame(game) {
    const envelope = await InteropEnvelopeModel.findOne({ gameId: game._id }).lean();
    return envelope ? mapEnvelope(envelope, game) : null;
  },

  async upsertEnvelope(game, input) {
    for (const accept of input.accepts ?? []) validateMapping(accept);
    const envelope = await InteropEnvelopeModel.findOneAndUpdate(
      { gameId: game._id },
      {
        $set: {
          acceptsTierMax: input.acceptsTierMax,
          accepts: input.accepts,
          licenseRequirement: input.licenseRequirement ?? 'display_only',
          feeUnits: toBigInt(input.feeUnits ?? 0),
          hostSharePct: input.hostSharePct ?? 50,
          status: input.status ?? 'active',
        },
        $setOnInsert: { pid: publicId('env') },
      },
      { upsert: true, new: true },
    ).lean();
    const highest = (input.accepts ?? []).reduce((best, accept) => (tierIndex(accept.tierMax) > tierIndex(best) ? accept.tierMax : best), 'T0');
    const doc = await GameModel.findById(game._id);
    if (doc && tierIndex(highest) > tierIndex(doc.interopTier)) {
      doc.interopTier = highest;
      await doc.save();
    }
    return mapEnvelope(envelope, game);
  },

  /** Games whose live envelope accepts each item's schema at T1+ (UC-06, UC-14). */
  async renderTargetsFor(items) {
    const schemaIds = [...new Set(items.filter((item) => item.schemaId && tierIndex(item.interopTier) >= 1).map((item) => item.schemaId))];
    const result = new Map();
    if (!schemaIds.length) return result;
    const envelopes = await InteropEnvelopeModel.find({ status: 'active', 'accepts.schemaId': { $in: schemaIds } }).lean();
    const games = await GameModel.find({ _id: { $in: envelopes.map((envelope) => envelope.gameId) }, status: 'live' })
      .select('pid slug title')
      .lean();
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    for (const item of items) {
      if (!item.schemaId || tierIndex(item.interopTier) < 1) continue;
      const targets = [];
      for (const envelope of envelopes) {
        const game = gameById.get(String(envelope.gameId));
        if (!game || String(envelope.gameId) === String(item.gameId)) continue;
        const accept = envelope.accepts.find((candidate) => candidate.schemaId === item.schemaId);
        if (accept && tierIndex(accept.tierMax) >= 1) targets.push({ gameId: game.pid, slug: game.slug, title: game.title, tier: minTier(item.interopTier, accept.tierMax) });
      }
      result.set(String(item._id), targets);
    }
    return result;
  },

  /** UC-13: four ordered checks; dry runs charge nothing; out-of-band mappings fail (invariant 6). */
  async importItem(user, { inventoryItemId, hostGameId, dryRun = true }) {
    const item = await InventoryItemModel.findOne({ pid: inventoryItemId, userId: user._id }).lean();
    if (!item || !['owned', 'listed'].includes(item.status)) throw NotFound('item_not_found');
    if (item.status === 'listed') throw Conflict('item_listed');
    const host = await GameModel.findOne({ pid: hostGameId, status: 'live' }).lean();
    if (!host) throw NotFound('game_not_found');
    if (String(host._id) === String(item.gameId)) throw Unprocessable('same_game_import');
    const envelope = await InteropEnvelopeModel.findOne({ gameId: host._id, status: 'active' }).lean();
    if (!envelope) throw Unprocessable('schema_not_accepted', { message: 'Host game publishes no envelope.' });
    const definition = await ItemDefinitionModel.findById(item.itemDefinitionId).lean();
    const license = definition?.licenseId
      ? await AssetLicenseModel.findById(definition.licenseId).lean()
      : await AssetLicenseModel.findOne({ studioId: item.studioId, status: 'active' }).sort({ createdAt: 1 }).lean();

    const evaluation = evaluateImport({ item, envelope, license });
    const feeUnits = toBigInt(envelope.feeUnits);
    const preview = {
      dryRun,
      feeUnits: feeUnits.toString(),
      feeSrv: fromUnits(feeUnits),
      checks: evaluation.checks,
      source: item.traits ?? {},
      envelope: summarizeAccept(envelope, evaluation.accept),
      mapped: evaluation.mapped,
      deedsCarried: item.deedCount ?? 0,
      host: { id: host.pid, slug: host.slug, title: host.title },
    };
    if (evaluation.failure) {
      throw Unprocessable(evaluation.failure, { message: `Interop check failed: ${evaluation.failure}`, details: evaluation.checks.filter((check) => !check.passed).map((check) => ({ field: check.name, issue: check.detail })) });
    }
    if (dryRun) return preview;

    if (await InteropImportModel.exists({ inventoryItemId: item._id, hostGameId: host._id })) throw Conflict('already_imported');

    const record = await withTransaction(async (session) => {
      let ledgerTxId = null;
      if (feeUnits > 0n) {
        const hostStudio = await StudioModel.findById(host.studioId).session(session).lean();
        const hostShare = applyBps(feeUnits, (envelope.hostSharePct ?? 50) * 100);
        const protocol = splitFee(feeUnits - hostShare);
        const legs = [
          { accountId: (await ledgerService.walletFor(user._id, session))._id, direction: 'debit', amountUnits: feeUnits, reason: 'interop_fee' },
          { accountId: hostStudio.vaultAccountId, direction: 'credit', amountUnits: hostShare, reason: 'interop_fee' },
        ];
        for (const [purpose, amount] of Object.entries(protocol)) {
          legs.push({ accountId: await ledgerService.systemAccountId(purpose, session), direction: 'credit', amountUnits: amount, reason: 'fee' });
        }
        ({ txId: ledgerTxId } = await ledgerService.post({ legs, refType: 'interop_import', refId: item._id, memo: `import ${item.pid} → ${host.slug}` }, session));
      }
      const [created] = await InteropImportModel.create(
        [
          {
            pid: publicId('imp'),
            inventoryItemId: item._id,
            userId: user._id,
            sourceGameId: item.gameId,
            hostGameId: host._id,
            tier: evaluation.tier,
            schemaId: item.schemaId,
            sourceTraits: item.traits ?? {},
            mappedTraits: evaluation.mapped,
            // Snapshot: a later envelope edit never rewrites what was agreed at import time.
            envelopeSnapshot: JSON.parse(JSON.stringify(envelope, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
            checks: evaluation.checks,
            licenseId: license?._id ?? null,
            feeUnits,
            ledgerTxId,
            deedsCarried: item.deedCount ?? 0,
          },
        ],
        { session },
      );
      return created.toObject();
    });

    eventBus.emit('item.imported', { importId: record.pid, inventoryItemId: item.pid, hostGameId: host.pid, studioId: host.studioId, feeUnits: feeUnits.toString() });
    const balance = await ledgerService.balance((await ledgerService.walletFor(user._id))._id);
    return { ...preview, dryRun: false, id: record.pid, ledgerTxId: record.ledgerTxId, balanceUnits: balance.balanceUnits, balanceSrv: balance.balanceSrv };
  },

  async listImports(user) {
    const imports = await InteropImportModel.find({ userId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
    const games = await GameModel.find({ _id: { $in: imports.flatMap((row) => [row.hostGameId, row.sourceGameId]) } }).select('pid slug title').lean();
    const items = await InventoryItemModel.find({ _id: { $in: imports.map((row) => row.inventoryItemId) } }).select('pid name').lean();
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    const itemById = new Map(items.map((row) => [String(row._id), row]));
    return imports.map((row) => ({
      id: row.pid,
      inventoryItem: { id: itemById.get(String(row.inventoryItemId))?.pid, name: itemById.get(String(row.inventoryItemId))?.name },
      sourceGame: pickGame(gameById.get(String(row.sourceGameId))),
      hostGame: pickGame(gameById.get(String(row.hostGameId))),
      tier: row.tier,
      mappedTraits: row.mappedTraits,
      feeUnits: toBigInt(row.feeUnits).toString(),
      deedsCarried: row.deedsCarried,
      createdAt: row.createdAt,
    }));
  },

  /** Hosts read mapped traits only — never raw source stats (UC-13 Post). */
  async importsForHost(hostGameId, userId) {
    const imports = await InteropImportModel.find({ hostGameId, userId, status: 'active' }).lean();
    const items = await InventoryItemModel.find({ _id: { $in: imports.map((row) => row.inventoryItemId) }, userId, status: 'owned' }).select('pid name').lean();
    const itemById = new Map(items.map((row) => [String(row._id), row]));
    return imports
      .filter((row) => itemById.has(String(row.inventoryItemId)))
      .map((row) => ({ inventoryItemId: itemById.get(String(row.inventoryItemId)).pid, name: itemById.get(String(row.inventoryItemId)).name, schemaId: row.schemaId, tier: row.tier, traits: row.mappedTraits }));
  },
};

/** Pure evaluation of the four ordered checks. Exported for property tests. */
export function evaluateImport({ item, envelope, license }) {
  const checks = [];
  const accept = envelope.accepts.find((candidate) => candidate.schemaId === item.schemaId);

  const schemaPassed = Boolean(item.schemaId && accept);
  checks.push({ name: 'schema_match', passed: schemaPassed, detail: item.schemaId ?? 'item has no trait schema' });
  if (!schemaPassed) return { checks, failure: 'schema_not_accepted', mapped: {}, accept: null };

  const tier = minTier(minTier(item.interopTier, accept.tierMax), envelope.acceptsTierMax);
  const tierPassed = tierIndex(tier) >= tierIndex('T2');
  checks.push({ name: 'tier', passed: tierPassed, detail: `${item.interopTier} item, host accepts ≤ ${accept.tierMax}` });
  if (!tierPassed) return { checks, failure: 'tier_too_low', mapped: {}, accept };

  const required = LICENSE_RANK[envelope.licenseRequirement ?? 'display_only'];
  const licensePassed = Boolean(license && license.status === 'active' && LICENSE_RANK[license.type] >= required);
  checks.push({ name: 'license', passed: licensePassed, detail: license ? `${license.type} (host needs ${envelope.licenseRequirement})` : 'no license attached' });
  if (!licensePassed) return { checks, failure: 'license_denied', mapped: {}, accept };

  const { mapped, violations } = mapTraits(item.traits ?? {}, accept);
  const normalizationPassed = violations.length === 0;
  checks.push({
    name: 'normalization',
    passed: normalizationPassed,
    detail: normalizationPassed ? 'all mapped traits inside host bands' : violations.join('; '),
  });
  if (!normalizationPassed) return { checks, failure: 'normalization_out_of_band', mapped, accept };
  return { checks, failure: null, mapped, accept, tier };
}

/**
 * Declarative mapping only — no code execution. Linear curves map `inRange` onto `outRange`.
 * With `clampPolicy: reject` (the spec default) any value outside its band fails the import.
 */
export function mapTraits(source, accept) {
  const mapped = {};
  const violations = [];
  for (const [target, rule] of Object.entries(accept.mapping ?? {})) {
    const value = source[rule.from ?? target];
    if (value === undefined) continue;
    if (rule.passthrough) {
      mapped[target] = value;
      if (Array.isArray(rule.values) && !rule.values.includes(value)) violations.push(`${target}=${value} not in host values`);
      continue;
    }
    if (typeof value !== 'number') {
      violations.push(`${target} source is not numeric`);
      continue;
    }
    const [outMin, outMax] = rule.outRange;
    let result;
    if (rule.inRange) {
      const [inMin, inMax] = rule.inRange;
      result = inMax === inMin ? outMin : outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
    } else {
      result = value;
    }
    result = rule.round === false ? result : Math.round(result);
    if (result < outMin || result > outMax) {
      if (accept.clampPolicy === 'clamp') result = Math.min(outMax, Math.max(outMin, result));
      else {
        violations.push(`${target}=${result} outside [${outMin}, ${outMax}]`);
        continue;
      }
    }
    mapped[target] = result;
  }
  if (accept.powerTierRange && source.power_tier !== undefined) {
    const [min, max] = accept.powerTierRange;
    if (source.power_tier < min || source.power_tier > max) violations.push(`power_tier=${source.power_tier} outside [${min}, ${max}]`);
    else mapped.power_tier ??= source.power_tier;
  }
  return { mapped, violations };
}

export function mapEnvelope(envelope, game) {
  return {
    id: envelope.pid,
    game: game ? { id: game.pid, slug: game.slug, title: game.title } : null,
    acceptsTierMax: envelope.acceptsTierMax,
    accepts: envelope.accepts,
    licenseRequirement: envelope.licenseRequirement,
    feeUnits: toBigInt(envelope.feeUnits).toString(),
    hostSharePct: envelope.hostSharePct,
    clampPolicy: envelope.accepts?.[0]?.clampPolicy ?? 'reject',
    status: envelope.status,
    updatedAt: envelope.updatedAt,
  };
}

function validateMapping(accept) {
  for (const [target, rule] of Object.entries(accept.mapping ?? {})) {
    if (rule.passthrough) continue;
    if (!Array.isArray(rule.outRange) || rule.outRange.length !== 2 || rule.outRange[0] > rule.outRange[1]) {
      throw Unprocessable('invalid_envelope', { details: [{ field: `mapping.${target}.outRange`, issue: 'must be [min, max]' }] });
    }
    if (rule.inRange && (rule.inRange.length !== 2 || rule.inRange[0] > rule.inRange[1])) {
      throw Unprocessable('invalid_envelope', { details: [{ field: `mapping.${target}.inRange`, issue: 'must be [min, max]' }] });
    }
  }
}

function summarizeAccept(envelope, accept) {
  return {
    acceptsTierMax: envelope.acceptsTierMax,
    schemaId: accept?.schemaId ?? null,
    tierMax: accept?.tierMax ?? null,
    powerTierRange: accept?.powerTierRange ?? null,
    bands: Object.fromEntries(Object.entries(accept?.mapping ?? {}).filter(([, rule]) => rule.outRange).map(([key, rule]) => [key, rule.outRange])),
    clampPolicy: accept?.clampPolicy ?? 'reject',
  };
}

function minTier(a, b) {
  return tierIndex(a) <= tierIndex(b) ? a : b;
}

function pickGame(game) {
  return game ? { id: game.pid, slug: game.slug, title: game.title } : null;
}
