import { createHash } from 'node:crypto';

import { env } from '../../../config/env.js';
import { levelIndex } from '../../../config/constants.js';
import { canonicalJson } from '../../../lib/canonical-json.js';
import { epochNumberAt } from '../../../lib/epoch.js';
import { Forbidden, NotFound, RateLimited, Unauthorized, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { hmacHex, safeEqual } from '../../../lib/hmac.js';
import { publicId } from '../../../lib/ids.js';
import { open } from '../../../lib/secret-box.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { TraitSchemaModel } from '../../items/models/index.js';
import { ApiKeyModel, StudioModel } from '../../studios/models/index.js';
import { PlaySessionModel } from '../../telemetry/models/index.js';
import { DeedModel, DeedStatusModel } from '../models/index.js';

const SESSION_GRACE_MS = 5 * 60_000;

/** Deeds are insert-only: this service exposes append() and reads, and nothing else (invariant 4). */
export const deedsService = {
  /** The signature base string games must HMAC with their API secret (03 §8). */
  signatureBase({ inventoryItemId, deedType, detail, nonce }) {
    return `${inventoryItemId}.${deedType}.${canonicalJson(detail ?? {})}.${nonce}`;
  },

  /** UC-11 — the gameplay hot path. Returns immediately; verification is asynchronous. */
  async append({ apiKey, studio, game }, { inventoryItemId, deedType, detail = {}, nonce, studioSignature }) {
    const item = await InventoryItemModel.findOne({ pid: inventoryItemId }).lean();
    if (!item || !['owned', 'listed'].includes(item.status)) throw NotFound('item_not_found');

    const secret = open((await ApiKeyModel.findById(apiKey._id).select('+attestationSecretEnc').lean()).attestationSecretEnc);
    const expected = `sha256=${hmacHex(secret, this.signatureBase({ inventoryItemId, deedType, detail, nonce }))}`;
    if (!safeEqual(expected, studioSignature)) throw Unauthorized('bad_attestation');

    if (String(item.studioId) !== String(studio._id) || (game && String(item.gameId) !== String(game._id))) {
      throw Forbidden('not_your_item');
    }

    // Replay of a nonce returns the original deed and never mutates traits twice.
    const replay = await DeedModel.findOne({ inventoryItemId: item._id, nonce }).lean();
    if (replay) return presentDeed(replay, await DeedStatusModel.findOne({ deedId: replay._id }).lean(), item);

    const schema = item.schemaId ? await TraitSchemaModel.findOne({ schemaId: item.schemaId }).lean() : null;
    const declared = new Set([...(schema?.mutation?.deedTypes ?? []), ...(schema?.mutation?.maxVelocity ?? []).map((rule) => rule.deedType)]);
    if (item.kind !== 'living' || !schema || !declared.has(deedType)) throw Unprocessable('undeclared_deed');

    const velocity = schema.mutation.maxVelocity?.find((rule) => rule.deedType === deedType);
    if (velocity) {
      const since = new Date(Date.now() - velocity.windowHours * 3_600_000);
      const recent = await DeedModel.countDocuments({ inventoryItemId: item._id, deedType, createdAt: { $gte: since } });
      if (recent >= velocity.max) throw RateLimited('mutation_rate_exceeded', { retryAfter: 60 });
    }

    const traitsBefore = { ...(item.traits ?? {}) };
    const traitsAfter = applyEffects(traitsBefore, schema.mutation.effects ?? [], deedType, detail);
    const owner = await UserModel.findById(item.userId).select('reputation').lean();
    const payloadHash = `sha256:${createHash('sha256').update(canonicalJson({ inventoryItemId, deedType, detail, nonce })).digest('hex')}`;

    let deed;
    let status;
    try {
      ({ deed, status } = await withTransaction(async (session) => {
        const [created] = await DeedModel.create(
          [
            {
              pid: publicId('ded'),
              inventoryItemId: item._id,
              tokenId: item.tokenId,
              userId: item.userId,
              gameId: item.gameId,
              studioId: item.studioId,
              deedType,
              detail,
              traitsBefore,
              traitsAfter,
              epoch: epochNumberAt(new Date()),
              nonce,
              studioSignature,
              payloadHash,
              repAtDeed: owner?.reputation ?? 0,
            },
          ],
          { session },
        );
        const [createdStatus] = await DeedStatusModel.create(
          [{ deedId: created._id, inventoryItemId: item._id, chain: { status: 'pending' } }],
          { session },
        );
        await InventoryItemModel.updateOne({ _id: item._id }, { $set: { traits: traitsAfter }, $inc: { deedCount: 1 } }, { session });
        await UserModel.updateOne({ _id: item.userId }, { $inc: { 'counters.deeds': 1 } }, { session });
        return { deed: created.toObject(), status: createdStatus.toObject() };
      }));
    } catch (error) {
      // A concurrent request with the same nonce won the insert; return its deed.
      if (error?.code === 11000) {
        const original = await DeedModel.findOne({ inventoryItemId: item._id, nonce }).lean();
        if (original) return presentDeed(original, await DeedStatusModel.findOne({ deedId: original._id }).lean(), item);
      }
      throw error;
    }

    const [gameDoc, studioDoc] = await Promise.all([GameModel.findById(item.gameId).select('pid slug').lean(), StudioModel.findById(item.studioId).select('pid').lean()]);
    eventBus.emit('item.evolved', {
      deedId: deed.pid,
      deedObjectId: deed._id,
      inventoryItemId: item.pid,
      itemName: item.name,
      gameObjectId: item.gameId,
      gameId: gameDoc?.pid,
      studioId: item.studioId,
      studioPid: studioDoc?.pid,
      deedType,
      detail,
      traitsAfter,
    });
    return presentDeed(deed, status, item);
  },

  async listForItem(inventoryPid, viewer) {
    const item = await InventoryItemModel.findOne({ pid: inventoryPid }).lean();
    if (!item) throw NotFound('item_not_found');
    const isOwner = viewer && String(viewer._id) === String(item.userId);
    const isStaff = viewer?.roles?.some((role) => role === 'moderator' || role === 'admin');
    // Public for listed items so a buyer can audit history before paying (UC-12).
    if (item.status !== 'listed' && !isOwner && !isStaff) throw NotFound('item_not_found');
    const deeds = await DeedModel.find({ inventoryItemId: item._id }).sort({ createdAt: 1, _id: 1 }).lean();
    return presentDeeds(deeds, new Map([[String(item._id), item]]));
  },

  async listForUser(user) {
    const items = await InventoryItemModel.find({ userId: user._id, status: { $in: ['owned', 'listed'] } }).select('_id pid name schemaId tokenId').lean();
    const deeds = await DeedModel.find({ inventoryItemId: { $in: items.map((item) => item._id) } }).sort({ createdAt: 1, _id: 1 }).lean();
    return presentDeeds(deeds, new Map(items.map((item) => [String(item._id), item])));
  },

  /** deed-verify worker: cross-check claimed play against server telemetry (UC-11 §7). */
  async verifyPending({ limit = 100 } = {}) {
    const pending = await DeedStatusModel.find({ verified: null }).sort({ createdAt: 1 }).limit(limit).lean();
    let checked = 0;
    for (const status of pending) {
      const deed = await DeedModel.findById(status.deedId).lean();
      if (!deed) continue;
      const { verified, note } = await crossCheck(deed);
      const updated = await DeedStatusModel.findOneAndUpdate(
        { _id: status._id, verified: null },
        { $set: { verified, verificationNote: note, verifiedAt: new Date() } },
        { new: true },
      ).lean();
      if (!updated) continue;
      checked += 1;
      if (!verified) await openMismatchCase(deed, note);
      await anchorDeed(deed, updated, verified);
    }
    return { checked };
  },
};

/**
 * Applies the schema's declared effects. Unknown deeds never reach here; effects are data, so a
 * studio cannot ship code that rewrites traits arbitrarily.
 */
export function applyEffects(traits, effects, deedType, detail) {
  const next = { ...traits };
  for (const effect of effects.filter((candidate) => candidate.deedType === deedType)) {
    const amount = effect.from ? Number(detail?.[effect.from] ?? 0) : Number(effect.by ?? 1);
    if (!Number.isFinite(amount)) continue;
    if (effect.op === 'set') next[effect.trait] = amount;
    else next[effect.trait] = Math.round(((Number(next[effect.trait]) || 0) + amount) * 1000) / 1000;
  }
  return next;
}

async function crossCheck(deed) {
  const created = deed.createdAt.getTime();
  const session = await PlaySessionModel.findOne({
    userId: deed.userId,
    gameId: deed.gameId,
    startedAt: { $lte: new Date(created + 60_000) },
    lastHeartbeatAt: { $gte: new Date(created - SESSION_GRACE_MS) },
  })
    .sort({ startedAt: -1 })
    .lean();
  if (!session) return { verified: false, note: 'no play session covering this deed' };

  const claimedMinutes = Number(deed.detail?.playtimeMinutes ?? deed.detail?.durationMinutes ?? 0);
  if (claimedMinutes > 0) {
    const since = new Date(created - 24 * 3_600_000);
    const sessions = await PlaySessionModel.find({ userId: deed.userId, gameId: deed.gameId, lastHeartbeatAt: { $gte: since } }).lean();
    const observed = sessions.reduce((sum, row) => sum + (row.minutes ?? 0), 0) + Math.max(0, Math.floor((session.lastHeartbeatAt - session.startedAt) / 60_000) - (session.minutes ?? 0));
    if (claimedMinutes > observed + 5) {
      return { verified: false, note: `claimed ${claimedMinutes} min, telemetry shows ${observed} min` };
    }
  }
  return { verified: true, note: `session ${session.pid}` };
}

async function openMismatchCase(deed, note) {
  const { reviewService } = await import('../../review/services/review.service.js');
  await reviewService.openDeedMismatch({ deed, note });
}

async function anchorDeed(deed, status, verified) {
  const item = await InventoryItemModel.findById(deed.inventoryItemId).lean();
  const game = await GameModel.findById(deed.gameId).select('tokenizationLevel').lean();
  const studio = await StudioModel.findById(deed.studioId).select('custodyIndex').lean();
  if (!item || !studio || levelIndex(game?.tokenizationLevel ?? 'L0') < levelIndex('L3') || (!item.tokenId && !item.chain?.opId)) {
    await DeedStatusModel.updateOne({ _id: status._id }, { $set: { 'chain.status': 'none' } });
    return;
  }
  const op = await chainService.enqueue({
    kind: 'record_deed',
    ref: `deed:${deed.pid}`,
    refType: 'deed',
    refId: deed._id,
    dependsOn: item.tokenId ? null : item.chain.opId,
    payload: {
      deedId: deed.pid,
      tokenId: item.tokenId,
      deedType: deed.deedType,
      payloadHash: deed.payloadHash,
      payloadUri: `${env.APP_BASE_URL.replace(/\/$/, '')}/deeds/${deed.pid}`,
      studioCustodyIndex: studio.custodyIndex,
      witness: verified,
    },
  });
  await DeedStatusModel.updateOne({ _id: status._id }, { $set: { 'chain.opId': op._id } });
  await chainService.kick(op._id, { waitMs: 100 });
}

async function presentDeeds(deeds, itemsById) {
  const statuses = await DeedStatusModel.find({ deedId: { $in: deeds.map((deed) => deed._id) } }).lean();
  const statusById = new Map(statuses.map((status) => [String(status.deedId), status]));
  return deeds.map((deed) => presentDeed(deed, statusById.get(String(deed._id)), itemsById.get(String(deed.inventoryItemId))));
}

export function presentDeed(deed, status, item) {
  return {
    id: deed.pid,
    inventoryItemId: item?.pid ?? null,
    itemName: item?.name ?? null,
    schemaId: item?.schemaId ?? null,
    deedType: deed.deedType,
    detail: deed.detail,
    traitsBefore: deed.traitsBefore,
    traitsAfter: deed.traitsAfter,
    epoch: deed.epoch,
    verified: status?.verified ?? null,
    verificationNote: status?.verificationNote ?? null,
    studioAttested: Boolean(deed.studioSignature),
    sverseWitness: status?.verified === true && status?.chain?.status === 'confirmed',
    repAtDeed: deed.repAtDeed,
    chain: {
      status: status?.chain?.status ?? 'pending',
      txHash: status?.chain?.txHash ?? null,
      explorerUrl: chainService.explorerTxUrl(status?.chain?.txHash),
      chainDeedId: status?.chain?.chainDeedId ?? null,
    },
    txHash: status?.chain?.txHash ?? null,
    createdAt: deed.createdAt,
  };
}

chainService.registerHandler('record_deed', {
  async onCompleted(op, result) {
    await DeedStatusModel.updateOne(
      { deedId: op.refId },
      { $set: { 'chain.status': 'confirmed', 'chain.txHash': op.txHash, 'chain.chainDeedId': result.chainDeedId ?? null } },
    );
  },
  async onFailed(op) {
    await DeedStatusModel.updateOne({ deedId: op.refId }, { $set: { 'chain.status': 'failed' } });
  },
});
