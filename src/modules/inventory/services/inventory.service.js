import { levelIndex, tierIndex } from '../../../config/constants.js';
import { Conflict, NotFound, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId, toObjectId } from '../../../lib/ids.js';
import { publicAssetUrl } from '../../../lib/assets.js';
import { decodeCursor, pageMeta, parseLimit } from '../../../lib/pagination.js';
import { chainService } from '../../chain/services/chain.service.js';
import { GameModel } from '../../games/models/index.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { StudioModel } from '../../studios/models/index.js';
import { InventoryItemModel } from '../models/index.js';

/** The only writer of `inventoryItems` (01 §2.1). */
export const inventoryService = {
  /**
   * Mints an owned instance inside the caller's transaction and enqueues the on-chain mint for
   * items tokenized at L2 or above. Returns `{ item, chainOp }`.
   */
  async mint({ user, itemDefinition, game, studio, quantity = 1, acquiredVia = 'purchase', orderId = null, refPid }, session) {
    const stackable = Boolean(itemDefinition.stackable);
    if (!stackable) {
      const owned = await InventoryItemModel.exists({
        userId: user._id,
        itemDefinitionId: itemDefinition._id,
        status: { $in: ['owned', 'listed'] },
      }).session(session);
      if (owned) throw Conflict('already_owned');
    }

    const onChain = levelIndex(itemDefinition.tokenizationLevel ?? game.tokenizationLevel) >= levelIndex('L2');
    let item;
    if (stackable) {
      item = await InventoryItemModel.findOneAndUpdate(
        { userId: user._id, itemDefinitionId: itemDefinition._id, status: 'owned' },
        { $inc: { quantity } },
        { new: true, session },
      );
    }
    if (!item) {
      const serial = itemDefinition.kind === 'living' ? ` #${(itemDefinition.supply?.minted ?? 0) + 1}` : '';
      [item] = await InventoryItemModel.create(
        [
          {
            pid: publicId('inv'),
            userId: user._id,
            itemDefinitionId: itemDefinition._id,
            gameId: game._id,
            studioId: studio._id,
            name: `${itemDefinition.name}${serial}`,
            sku: itemDefinition.sku,
            kind: itemDefinition.kind,
            interopTier: itemDefinition.interopTier,
            schemaId: itemDefinition.schemaId,
            slot: itemDefinition.slot,
            artUrl: itemDefinition.art?.url ?? '',
            traits: initialTraits(itemDefinition),
            quantity,
            transferable: itemDefinition.transferable,
            stackable,
            acquiredVia,
            acquiredOrderId: stackable ? null : orderId,
            chain: { status: onChain ? 'pending' : 'none' },
          },
        ],
        { session },
      );
    }

    let chainOp = null;
    if (onChain) {
      chainOp = await chainService.enqueue(
        {
          kind: 'mint_item',
          ref: `mint:${refPid ?? item.pid}`,
          refType: 'inventory_item',
          refId: item._id,
          payload: {
            to: user.custodialAddress,
            amount: quantity,
            definition: {
              ref: itemDefinition.pid,
              gameRef: game.pid,
              studioRef: studio.pid,
              studioWallet: studio.signerAddress,
              maxSupply: itemDefinition.supply?.type === 'limited' ? itemDefinition.supply.max : null,
              royaltyBps: itemDefinition.royaltyBps ?? 0,
              transferable: itemDefinition.transferable,
              living: itemDefinition.kind === 'living',
              uri: `sverse://items/${itemDefinition.pid}`,
            },
          },
        },
        session,
      );
      if (!item.chain?.opId) {
        await InventoryItemModel.updateOne({ _id: item._id }, { $set: { 'chain.opId': chainOp._id } }, { session });
      }
    }
    return { item: item.toObject ? item.toObject() : item, chainOp };
  },

  async findOwned(user, inventoryPid, session) {
    const item = await InventoryItemModel.findOne({ pid: inventoryPid, userId: user._id }).session(session ?? null);
    if (!item) throw NotFound('item_not_found');
    return item;
  },

  async findByPid(inventoryPid) {
    const item = await InventoryItemModel.findOne({ pid: inventoryPid }).lean();
    if (!item) throw NotFound('item_not_found');
    return item;
  },

  async list(user, filters = {}) {
    const limit = parseLimit(filters.limit, { fallback: 50, max: 100 });
    const query = { userId: user._id, status: { $in: ['owned', 'listed'] } };
    if (filters.kind) query.kind = filters.kind;
    if (filters.interopTier) query.interopTier = filters.interopTier;
    if (filters.living === 'true' || filters.living === true) query.kind = 'living';
    if (filters.gameId) {
      const game = await GameModel.findOne({ pid: filters.gameId }).select('_id').lean();
      query.gameId = game?._id ?? null;
    }
    const cursor = decodeCursor(filters.cursor);
    if (cursor?.createdAt) {
      query.$or = [
        { createdAt: { $lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), _id: { $lt: toObjectId(cursor.id) } },
      ];
    }
    const rows = await InventoryItemModel.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
    const { page, meta } = pageMeta(rows, limit, (row) => ({ createdAt: row.createdAt, id: String(row._id) }));
    return { items: await presentInventory(page), meta };
  },

  async countsFor(userId) {
    const [count, games] = await Promise.all([
      InventoryItemModel.countDocuments({ userId, status: { $in: ['owned', 'listed'] } }),
      InventoryItemModel.distinct('gameId', { userId, status: { $in: ['owned', 'listed'] } }),
    ]);
    return { count, gameCount: games.length };
  },

  async wardrobe(user) {
    const items = await InventoryItemModel.find({
      userId: user._id,
      status: { $in: ['owned', 'listed'] },
      interopTier: { $in: ['T1', 'T2', 'T3'] },
      kind: { $in: ['cosmetic', 'living'] },
    })
      .sort({ equipped: -1, createdAt: -1 })
      .lean();
    const presented = await presentInventory(items);
    return {
      equipped: presented.filter((item) => item.equipped),
      candidates: presented,
      renderTargets: new Set(presented.filter((item) => item.equipped).flatMap((item) => item.renderTargets.map((t) => t.gameId))).size,
    };
  },

  /** Equip with one-per-slot displacement, all in one operation (UC-14, T05). */
  async updateWardrobe(user, { equip = [], unequip = [] }) {
    const before = new Set((await InventoryItemModel.find({ userId: user._id, equipped: true }).select('pid').lean()).map((row) => row.pid));
    if (unequip.length) {
      await InventoryItemModel.updateMany({ userId: user._id, pid: { $in: unequip } }, { $set: { equipped: false } });
    }
    for (const pid of equip) {
      const item = await InventoryItemModel.findOne({ userId: user._id, pid }).lean();
      if (!item || !['owned', 'listed'].includes(item.status)) throw NotFound('item_not_found');
      if (item.status === 'listed') throw Conflict('item_listed');
      if (tierIndex(item.interopTier) < tierIndex('T1')) throw Unprocessable('not_interoperable');
      if (item.slot) {
        await InventoryItemModel.updateMany(
          { userId: user._id, slot: item.slot, equipped: true, _id: { $ne: item._id } },
          { $set: { equipped: false } },
        );
      }
      await InventoryItemModel.updateOne({ _id: item._id }, { $set: { equipped: true } });
    }
    const wardrobe = await this.wardrobe(user);
    const after = new Set(wardrobe.equipped.map((item) => item.id));
    return {
      // Items unequipped by slot conflicts (not by the explicit `unequip` list).
      displaced: [...before].filter((pid) => !after.has(pid) && !unequip.includes(pid)),
      equipped: wardrobe.equipped.map((item) => ({
        inventoryItemId: item.id,
        slot: item.slot,
        name: item.name,
        renderTargets: item.renderTargets,
      })),
      candidates: wardrobe.candidates,
    };
  },

  async setListed(item, listed, session) {
    const result = await InventoryItemModel.updateOne(
      { _id: item._id, status: listed ? 'owned' : 'listed' },
      { $set: { status: listed ? 'listed' : 'owned', ...(listed ? { equipped: false } : {}) } },
      { session },
    );
    if (result.modifiedCount !== 1) throw Conflict('listing_stale');
  },

  /** Ownership moves with the row; deeds reference the row, so history follows automatically. */
  async transfer({ item, fromUser, toUser }, session) {
    const result = await InventoryItemModel.updateOne(
      { _id: item._id, userId: fromUser._id, status: 'listed' },
      { $set: { userId: toUser._id, status: 'owned', equipped: false, acquiredVia: 'secondary', acquiredOrderId: null } },
      { session },
    );
    if (result.modifiedCount !== 1) throw Conflict('listing_stale');

    let chainOp = null;
    if (item.tokenId || item.chain?.opId) {
      chainOp = await chainService.enqueue(
        {
          kind: 'transfer_item',
          ref: `transfer:${item.pid}:${toUser.pid}:${Date.now()}`,
          refType: 'inventory_item',
          refId: item._id,
          dependsOn: item.chain?.opId ?? null,
          payload: {
            inventoryItemId: item.pid,
            fromKind: 'user',
            fromCustodyIndex: fromUser.custodyIndex,
            to: toUser.custodialAddress,
            tokenId: item.tokenId,
            amount: item.quantity ?? 1,
          },
        },
        session,
      );
      await InventoryItemModel.updateOne({ _id: item._id }, { $set: { 'chain.status': 'pending' } }, { session });
    }
    return { chainOp };
  },

  async revoke({ item, owner, reason, quantity = item.quantity ?? 1 }, session) {
    const partial = item.stackable && (item.quantity ?? 1) > quantity;
    await InventoryItemModel.updateOne(
      { _id: item._id },
      partial
        ? { $inc: { quantity: -quantity } }
        : { $set: { status: 'revoked', revokedReason: reason, equipped: false } },
      { session },
    );
    if (!item.tokenId && !item.chain?.opId) return { chainOp: null };
    const chainOp = await chainService.enqueue(
      {
        kind: 'burn_item',
        ref: `burn:${item.pid}:${reason}:${Date.now()}`,
        refType: 'inventory_item',
        refId: item._id,
        dependsOn: item.chain?.opId ?? null,
        payload: { inventoryItemId: item.pid, ownerKind: 'user', ownerCustodyIndex: owner.custodyIndex, tokenId: item.tokenId, amount: quantity },
      },
      session,
    );
    return { chainOp };
  },

  /** Entitlements are served by `{ gameId, userId }` alone — no $lookup (T10). */
  async entitlements(userId, gameId) {
    const items = await InventoryItemModel.find({ gameId, userId, status: { $in: ['owned', 'listed'] } })
      .select('pid sku kind quantity createdAt tokenId traits')
      .lean();
    return items.map((item) => ({
      inventoryItemId: item.pid,
      sku: item.sku,
      kind: item.kind,
      quantity: item.quantity ?? 1,
      tokenId: item.tokenId,
      traits: item.traits ?? {},
      grantedAt: item.createdAt,
      expiresAt: null,
    }));
  },
};

/** Presents inventory rows with game summaries, render targets and chain links. */
export async function presentInventory(items) {
  if (!items.length) return [];
  const { interopService } = await import('../../interop/services/interop.service.js');
  const gameIds = [...new Set(items.map((item) => String(item.gameId)))];
  const definitionIds = [...new Set(items.map((item) => String(item.itemDefinitionId)))];
  const { ListingModel } = await import('../../market/models/index.js');
  const [games, definitions, renderTargets, listings] = await Promise.all([
    GameModel.find({ _id: { $in: gameIds } }).select('pid slug title coverArt').lean(),
    ItemDefinitionModel.find({ _id: { $in: definitionIds } }).select('pid royaltyBps').lean(),
    interopService.renderTargetsFor(items),
    ListingModel.find({ inventoryItemId: { $in: items.filter((item) => item.status === 'listed').map((item) => item._id) }, status: 'open' }).select('pid inventoryItemId').lean(),
  ]);
  const listingByItem = new Map(listings.map((listing) => [String(listing.inventoryItemId), listing.pid]));
  const gameById = new Map(games.map((game) => [String(game._id), game]));
  const definitionById = new Map(definitions.map((definition) => [String(definition._id), definition]));
  return items.map((item) =>
    mapInventoryItem(item, {
      game: gameById.get(String(item.gameId)),
      definition: definitionById.get(String(item.itemDefinitionId)),
      renderTargets: renderTargets.get(String(item._id)) ?? [],
      listingId: listingByItem.get(String(item._id)) ?? null,
    }),
  );
}

export function mapInventoryItem(item, { game, definition, renderTargets = [], listingId = null } = {}) {
  return {
    id: item.pid,
    itemDefinitionId: definition?.pid ?? null,
    name: item.name,
    sku: item.sku,
    kind: item.kind,
    game: game ? { id: game.pid, slug: game.slug, title: game.title } : null,
    tokenId: item.tokenId,
    interopTier: item.interopTier,
    schemaId: item.schemaId,
    slot: item.slot,
    imageUrl: publicAssetUrl(item.artUrl),
    traits: item.traits ?? {},
    deedCount: item.deedCount ?? 0,
    quantity: item.quantity ?? 1,
    equipped: Boolean(item.equipped),
    listed: item.status === 'listed',
    listingId,
    royaltyBps: definition?.royaltyBps ?? null,
    transferable: item.transferable,
    status: item.status,
    acquiredVia: item.acquiredVia,
    acquiredAt: item.createdAt,
    renderTargets,
    chain: {
      status: item.chain?.status ?? 'none',
      txHash: item.chain?.txHash ?? null,
      explorerUrl: chainService.explorerTxUrl(item.chain?.txHash),
      ownerAddress: item.chain?.ownerAddress ?? null,
    },
  };
}

function initialTraits(definition) {
  if (definition.kind !== 'living') return { ...(definition.traits ?? {}) };
  const traits = { ...(definition.traits ?? {}) };
  for (const trait of definition.mutation?.traits ?? []) if (traits[trait] === undefined) traits[trait] = 0;
  if (traits.level === 0) traits.level = 1;
  return traits;
}

chainService.registerHandler('mint_item', {
  async onCompleted(op, result) {
    const item = await InventoryItemModel.findById(op.refId).lean();
    if (!item) return;
    const studio = await StudioModel.findById(item.studioId).select('pid').lean();
    await InventoryItemModel.updateOne(
      { _id: op.refId },
      {
        $set: {
          tokenId: result.tokenId ?? item.tokenId,
          'chain.status': 'confirmed',
          'chain.txHash': op.txHash,
          'chain.ownerAddress': op.payload.to,
        },
      },
    );
    if (result.chainDefinitionId) {
      await ItemDefinitionModel.updateOne(
        { pid: op.payload.definition.ref },
        { $set: { 'chain.definitionId': result.chainDefinitionId, 'chain.status': 'confirmed' } },
      );
    }
    eventBus.emit('item.minted', {
      inventoryItemId: item.pid,
      studioId: item.studioId,
      studioPid: studio?.pid,
      tokenId: result.tokenId ?? null,
      txHash: op.txHash,
    });
  },
  async onFailed(op) {
    await InventoryItemModel.updateOne({ _id: op.refId }, { $set: { 'chain.status': 'failed' } });
  },
});

chainService.registerHandler('transfer_item', {
  async onCompleted(op) {
    await InventoryItemModel.updateOne(
      { _id: op.refId },
      { $set: { 'chain.status': 'confirmed', 'chain.txHash': op.txHash, 'chain.ownerAddress': op.payload.to } },
    );
  },
  async onFailed(op) {
    await InventoryItemModel.updateOne({ _id: op.refId }, { $set: { 'chain.status': 'failed' } });
  },
});

chainService.registerHandler('burn_item', {
  async onCompleted(op) {
    await InventoryItemModel.updateOne({ _id: op.refId }, { $set: { 'chain.status': 'confirmed', 'chain.txHash': op.txHash, 'chain.ownerAddress': null } });
  },
  async onFailed() {},
});
