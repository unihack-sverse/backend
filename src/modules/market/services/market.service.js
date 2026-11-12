import { env } from '../../../config/env.js';
import { BadRequest, Conflict, NotFound, PaymentRequired, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { publicAssetUrl } from '../../../lib/assets.js';
import { decodeCursor, encodeCursor, parseLimit } from '../../../lib/pagination.js';
import { applyBps, fromUnits, splitFee, toBigInt, usdSnapshot } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { DeedModel, DeedStatusModel } from '../../deeds/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { inventoryService } from '../../inventory/services/inventory.service.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { ListingModel } from '../models/index.js';

const SORTS = {
  price_asc: { priceUnits: 1, _id: 1 },
  price_desc: { priceUnits: -1, _id: -1 },
  newest: { createdAt: -1, _id: -1 },
  most_deeds: { deedCountAtListing: -1, _id: -1 },
};

export const marketService = {
  async list({ gameId, gameSlug, schemaId, sort = 'price_asc', q, cursor, limit } = {}) {
    if (!SORTS[sort]) throw BadRequest('invalid_sort');
    const size = parseLimit(limit, { fallback: 48, max: 100 });
    const filter = { status: 'open' };
    if (gameId || gameSlug) {
      const game = await GameModel.findOne(gameId ? { pid: gameId } : { slug: gameSlug }).select('_id').lean();
      filter.gameId = game?._id ?? null;
    }
    if (schemaId) filter.schemaId = schemaId;
    if (q) filter.name = { $regex: escapeRegex(String(q).slice(0, 60)), $options: 'i' };
    const offset = decodeCursor(cursor)?.offset ?? 0;
    const rows = await ListingModel.find(filter).sort(SORTS[sort]).skip(offset).limit(size + 1).lean();
    const page = rows.slice(0, size);
    return {
      data: await presentListings(page),
      meta: { nextCursor: rows.length > size ? encodeCursor({ offset: offset + size }) : null, hasMore: rows.length > size, count: page.length },
    };
  },

  async get(listingPid) {
    const listing = await ListingModel.findOne({ pid: listingPid }).lean();
    if (!listing) throw NotFound('listing_not_found');
    const [presented] = await presentListings([listing]);
    return presented;
  },

  /** UC-10 §1: only owned, transferable, non-revoked items; listed items cannot equip or import. */
  async create(user, { inventoryItemId, priceUnits }) {
    const price = toBigInt(priceUnits);
    if (price <= 0n) throw Unprocessable('invalid_price');
    const item = await InventoryItemModel.findOne({ pid: inventoryItemId, userId: user._id }).lean();
    if (!item) throw NotFound('item_not_found');
    if (item.status !== 'owned') throw Conflict(item.status === 'listed' ? 'already_listed' : 'item_not_owned');
    if (!item.transferable) throw Unprocessable('not_transferable');
    if (item.stackable && (item.quantity ?? 1) > 1) throw Unprocessable('split_stack_first');
    const definition = await ItemDefinitionModel.findById(item.itemDefinitionId).select('royaltyBps').lean();
    const verifiedDeeds = await countVerifiedDeeds(item._id);

    const listing = await withTransaction(async (session) => {
      await inventoryService.setListed(item, true, session);
      const [created] = await ListingModel.create(
        [
          {
            pid: publicId('lst'),
            inventoryItemId: item._id,
            sellerUserId: user._id,
            gameId: item.gameId,
            studioId: item.studioId,
            schemaId: item.schemaId,
            name: item.name,
            artUrl: item.artUrl,
            priceUnits: price,
            royaltyBps: definition?.royaltyBps ?? 500,
            protocolBps: env.MARKET_PROTOCOL_FEE_BPS,
            deedCountAtListing: item.deedCount ?? 0,
            verifiedDeedCount: verifiedDeeds,
          },
        ],
        { session },
      );
      await GameModel.updateOne({ _id: item.gameId }, { $inc: { secondaryCount: 1 } }, { session });
      return created.toObject();
    });
    eventBus.emit('item.listed', { listingId: listing.pid, studioId: listing.studioId, inventoryItemId: item.pid, priceUnits: price.toString() });
    return this.get(listing.pid);
  },

  async cancel(user, listingPid) {
    const listing = await ListingModel.findOne({ pid: listingPid, sellerUserId: user._id }).lean();
    if (!listing) throw NotFound('listing_not_found');
    if (listing.status !== 'open') throw Conflict('listing_not_open');
    await withTransaction(async (session) => {
      const updated = await ListingModel.updateOne({ _id: listing._id, status: 'open' }, { $set: { status: 'cancelled' } }, { session });
      if (updated.modifiedCount !== 1) throw Conflict('listing_not_open');
      const item = await InventoryItemModel.findById(listing.inventoryItemId).session(session).lean();
      if (item?.status === 'listed') await inventoryService.setListed(item, false, session);
      await GameModel.updateOne({ _id: listing.gameId, secondaryCount: { $gt: 0 } }, { $inc: { secondaryCount: -1 } }, { session });
    });
    return this.get(listing.pid);
  },

  /**
   * UC-10 §2: buyer pays; seller gets price − protocol fee − studio royalty; ownership moves and
   * the full deed history moves with it, because deeds reference the item, not the account.
   */
  async buy(buyer, listingPid) {
    const listing = await ListingModel.findOne({ pid: listingPid }).lean();
    if (!listing) throw NotFound('listing_not_found');
    if (listing.status !== 'open') throw Conflict('listing_not_open');
    if (String(listing.sellerUserId) === String(buyer._id)) throw Conflict('self_purchase');

    const wallet = await ledgerService.walletFor(buyer._id);
    if (toBigInt(wallet.balanceUnits) < toBigInt(listing.priceUnits)) {
      throw PaymentRequired('insufficient_funds', {
        message: `Balance is ${toBigInt(wallet.balanceUnits)} units, listing costs ${toBigInt(listing.priceUnits)}.`,
        details: [{ field: 'amountUnits', issue: 'exceeds_balance' }],
      });
    }

    let chainOp = null;
    try {
      chainOp = await withTransaction(async (session) => {
        const claimed = await ListingModel.findOneAndUpdate(
          { _id: listing._id, status: 'open' },
          { $set: { status: 'sold', buyerUserId: buyer._id, soldAt: new Date() } },
          { new: true, session },
        ).lean();
        if (!claimed) throw Conflict('listing_not_open');

        const item = await InventoryItemModel.findById(listing.inventoryItemId).session(session).lean();
        if (!item || String(item.userId) !== String(listing.sellerUserId) || item.status !== 'listed') {
          throw Conflict('listing_stale');
        }
        const [seller, buyerDoc, studio] = await Promise.all([
          UserModel.findById(listing.sellerUserId).session(session).lean(),
          UserModel.findById(buyer._id).session(session).lean(),
          StudioModel.findById(listing.studioId).session(session).lean(),
        ]);

        const price = toBigInt(listing.priceUnits);
        const protocolUnits = applyBps(price, listing.protocolBps);
        const royaltyUnits = applyBps(price, listing.royaltyBps);
        const sellerUnits = price - protocolUnits - royaltyUnits;
        const legs = [
          { accountId: (await ledgerService.walletFor(buyer._id, session))._id, direction: 'debit', amountUnits: price, reason: 'secondary_sale' },
          { accountId: (await ledgerService.walletFor(seller._id, session))._id, direction: 'credit', amountUnits: sellerUnits, reason: 'secondary_sale' },
          { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: royaltyUnits, reason: 'royalty' },
        ];
        for (const [purpose, amount] of Object.entries(splitFee(protocolUnits))) {
          legs.push({ accountId: await ledgerService.systemAccountId(purpose, session), direction: 'credit', amountUnits: amount, reason: 'fee' });
        }
        const { txId } = await ledgerService.post({ legs, refType: 'listing', refId: listing._id, memo: `secondary ${listing.pid}` }, session);
        const { chainOp: op } = await inventoryService.transfer({ item, fromUser: seller, toUser: buyerDoc }, session);
        await ListingModel.updateOne({ _id: listing._id }, { $set: { ledgerTxId: txId, chainOpId: op?._id ?? null } }, { session });
        await GameModel.updateOne({ _id: listing.gameId, secondaryCount: { $gt: 0 } }, { $inc: { secondaryCount: -1 } }, { session });
        return op;
      });
    } catch (error) {
      if (error?.code === 'listing_stale') {
        // UC-10 Alt 2a: the seller no longer owns the item — the listing is auto-cancelled.
        await ListingModel.updateOne({ _id: listing._id, status: 'open' }, { $set: { status: 'stale' } });
      }
      throw error;
    }

    if (chainOp) await chainService.kick(chainOp._id, { waitMs: 300 });
    const item = await InventoryItemModel.findById(listing.inventoryItemId).select('pid').lean();
    eventBus.emit('item.sold', { listingId: listing.pid, studioId: listing.studioId, inventoryItemId: item?.pid, priceUnits: toBigInt(listing.priceUnits).toString() });
    const balance = await ledgerService.balance((await ledgerService.walletFor(buyer._id))._id);
    return { listing: await this.get(listing.pid), inventoryItemId: item?.pid, balanceUnits: balance.balanceUnits, balanceSrv: balance.balanceSrv };
  },

  async mine(user) {
    const rows = await ListingModel.find({ sellerUserId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
    return presentListings(rows);
  },
};

async function countVerifiedDeeds(inventoryItemId) {
  const deeds = await DeedModel.find({ inventoryItemId }).select('_id').lean();
  if (!deeds.length) return 0;
  return DeedStatusModel.countDocuments({ deedId: { $in: deeds.map((deed) => deed._id) }, verified: true });
}

export async function presentListings(listings) {
  if (!listings.length) return [];
  const [games, sellers, items] = await Promise.all([
    GameModel.find({ _id: { $in: listings.map((row) => row.gameId) } }).select('pid slug title').lean(),
    UserModel.find({ _id: { $in: listings.map((row) => row.sellerUserId) } }).select('pid handle reputation').lean(),
    InventoryItemModel.find({ _id: { $in: listings.map((row) => row.inventoryItemId) } }).select('pid tokenId traits deedCount kind interopTier chain').lean(),
  ]);
  const gameById = new Map(games.map((game) => [String(game._id), game]));
  const sellerById = new Map(sellers.map((seller) => [String(seller._id), seller]));
  const itemById = new Map(items.map((item) => [String(item._id), item]));
  return listings.map((listing) => {
    const game = gameById.get(String(listing.gameId));
    const seller = sellerById.get(String(listing.sellerUserId));
    const item = itemById.get(String(listing.inventoryItemId));
    const price = toBigInt(listing.priceUnits);
    return {
      id: listing.pid,
      status: listing.status,
      inventoryItemId: item?.pid ?? null,
      name: listing.name,
      imageUrl: publicAssetUrl(listing.artUrl),
      game: game ? { id: game.pid, slug: game.slug, title: game.title } : null,
      gameSlug: game?.slug ?? null,
      schemaId: listing.schemaId,
      kind: item?.kind,
      interopTier: item?.interopTier,
      tokenId: item?.tokenId ?? null,
      traits: item?.traits ?? {},
      priceUnits: price.toString(),
      priceSrv: fromUnits(price),
      priceUsdSnapshot: usdSnapshot(price),
      royaltyBps: listing.royaltyBps,
      protocolBps: listing.protocolBps,
      deedCount: item?.deedCount ?? listing.deedCountAtListing,
      verifiedDeedCount: listing.verifiedDeedCount,
      seller: seller ? { id: seller.pid, handle: seller.handle, reputation: seller.reputation } : null,
      chain: { status: item?.chain?.status ?? 'none', txHash: item?.chain?.txHash ?? null, explorerUrl: chainService.explorerTxUrl(item?.chain?.txHash) },
      soldAt: listing.soldAt,
      createdAt: listing.createdAt,
    };
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
