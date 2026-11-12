import { onrampAdapter } from '../../../adapters/onramp/mock-onramp-adapter.js';
import { env, isTest } from '../../../config/env.js';
import { AppError, Conflict, NotFound, PaymentRequired, Unprocessable } from '../../../lib/errors.js';
import { issueEntitlementToken } from '../../../lib/entitlement.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { publicAsset } from '../../../lib/assets.js';
import { fromUnits, primarySaleBreakdown, serializeBreakdown, toBigInt, usdSnapshot } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { writeAudit } from '../../../lib/audit.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { inventoryService } from '../../inventory/services/inventory.service.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { itemsService } from '../../items/services/items.service.js';
import { AccountModel } from '../../ledger/models/index.js';
import { ledgerService, mapBalance } from '../../ledger/services/ledger.service.js';
import { curationService } from '../../rewards/services/curation.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { OrderModel } from '../models/index.js';

// Test-only fault injection for the atomicity invariant (T09 acceptance).
const failpoints = new Set();
const FEE_PURPOSES = {
  burnUnits: 'burn',
  creatorRewardsUnits: 'creator_rewards',
  playerRewardsUnits: 'player_rewards',
  treasuryUnits: 'treasury',
  curatorUnits: 'curator',
};

export const checkoutService = {
  setFailpoint(name, enabled = true) {
    if (!isTest) return;
    if (enabled) failpoints.add(name);
    else failpoints.delete(name);
  },

  /** UC-07 steps 1–3: quote with a rate snapshot, reject impossible orders immediately. */
  async createIntent(user, { itemDefinitionId, quantity = 1, paymentMethod = 'srv_balance' }, { idempotencyKey = null, channel = 'web', gameScope = null } = {}) {
    const item = await ItemDefinitionModel.findOne({ pid: itemDefinitionId }).lean();
    if (!item || item.status !== 'active') throw NotFound('item_not_found');
    if (gameScope && String(gameScope) !== String(item.gameId)) throw NotFound('item_not_found');
    const [game, studio] = await Promise.all([GameModel.findById(item.gameId).lean(), StudioModel.findById(item.studioId).lean()]);
    if (!game || (game.status !== 'live' && channel !== 'sandbox')) throw Unprocessable('game_not_live');
    if (!studio || studio.status !== 'active') throw Unprocessable('game_not_live');
    if (!item.stackable && quantity !== 1) throw Unprocessable('quantity_not_allowed');

    if (!item.stackable) {
      const owned = await InventoryItemModel.exists({ userId: user._id, itemDefinitionId: item._id, status: { $in: ['owned', 'listed'] } });
      if (owned) throw Conflict('already_owned');
    }
    if (item.supply?.type === 'limited' && item.supply.minted + quantity > item.supply.max) throw Conflict('sold_out');

    const priceUnits = toBigInt(item.priceUnits) * BigInt(quantity);
    if (paymentMethod === 'srv_balance') {
      const wallet = await ledgerService.walletFor(user._id);
      if (toBigInt(wallet.balanceUnits) < priceUnits) {
        throw PaymentRequired('insufficient_funds', {
          message: `Balance is ${toBigInt(wallet.balanceUnits)} units, order requires ${priceUnits}.`,
          details: [{ field: 'amountUnits', issue: 'exceeds_balance' }],
        });
      }
    }

    const breakdown = primarySaleBreakdown(priceUnits, studio.feeBps);
    const order = await OrderModel.create({
      pid: publicId('ord'),
      userId: user._id,
      gameId: game._id,
      studioId: studio._id,
      itemDefinitionId: item._id,
      sku: item.sku,
      quantity,
      channel,
      paymentMethod,
      quote: {
        priceUnits,
        usdAmount: usdSnapshot(priceUnits),
        rateSnapshot: String(env.SRV_USD_RATE),
        expiresAt: new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1000),
      },
      feeBreakdown: breakdown,
      idempotencyKey,
    });
    return presentIntent(order.toObject(), { item, game, studio });
  },

  /** UC-07 step 4: one Mongo transaction — ledger postings, mint, supply, order — or nothing. */
  async confirm(user, orderPid, { scopeGameId = null } = {}) {
    const order = await OrderModel.findOne({ pid: orderPid, userId: user._id }).lean();
    if (!order || (scopeGameId && String(order.gameId) !== String(scopeGameId))) throw NotFound('order_not_found');
    if (order.status === 'completed') return this.presentCompleted(order, user);
    if (order.status !== 'pending') throw Conflict('order_not_pending');
    if (order.quote.expiresAt < new Date()) {
      await OrderModel.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'failed', failureCode: 'quote_expired' } });
      throw Conflict('quote_expired');
    }

    let chainOp = null;
    try {
      chainOp = await withTransaction(async (session) => {
        // Claim the order: a concurrent confirm of the same order loses here.
        const claimed = await OrderModel.findOneAndUpdate(
          { _id: order._id, status: 'pending', 'quote.expiresAt': { $gt: new Date() } },
          { $set: { status: 'settling' } },
          { new: true, session },
        ).lean();
        if (!claimed) throw Conflict('order_not_pending');

        const [item, game, studio, buyer] = await Promise.all([
          ItemDefinitionModel.findById(order.itemDefinitionId).session(session).lean(),
          GameModel.findById(order.gameId).session(session).lean(),
          StudioModel.findById(order.studioId).session(session).lean(),
          UserModel.findById(user._id).session(session).lean(),
        ]);
        if (!item || item.status !== 'active') throw NotFound('item_not_found');
        if (game.status !== 'live' && order.channel !== 'sandbox') throw Unprocessable('game_not_live');

        failpoint('supply');
        await itemsService.reserveSupply(item, order.quantity, session);

        failpoint('ledger');
        const wallet = await ledgerService.walletFor(user._id, session);
        const breakdown = order.feeBreakdown;
        const legs = [
          { accountId: wallet._id, direction: 'debit', amountUnits: order.quote.priceUnits, reason: 'purchase' },
          { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: breakdown.studioUnits, reason: 'purchase' },
        ];
        for (const [field, purpose] of Object.entries(FEE_PURPOSES)) {
          legs.push({ accountId: await ledgerService.systemAccountId(purpose, session), direction: 'credit', amountUnits: breakdown[field], reason: 'fee' });
        }
        const { txId } = await ledgerService.post({ legs, refType: 'order', refId: order._id, memo: `${order.sku} · ${game.pid}` }, session);

        failpoint('mint');
        const { item: minted, chainOp: op } = await inventoryService.mint(
          { user: buyer, itemDefinition: item, game, studio, quantity: order.quantity, orderId: order._id, refPid: order.pid, acquiredVia: order.channel === 'sandbox' ? 'test' : 'purchase' },
          session,
        );

        failpoint('lock');
        // Studio revenue is held for the dispute window before it can be withdrawn (UC-29 §2).
        await ledgerService.lock(studio.vaultAccountId, breakdown.studioUnits, session);

        failpoint('order');
        const settledAt = new Date();
        await OrderModel.updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'completed',
              ledgerTxId: txId,
              inventoryItemId: minted._id,
              chainOpId: op?._id ?? null,
              settledAt,
              disputeWindowEndsAt: new Date(settledAt.getTime() + env.DISPUTE_WINDOW_DAYS * 86_400_000),
            },
          },
          { session },
        );
        if (order.channel !== 'sandbox') {
          await StudioModel.updateOne(
            { _id: studio._id },
            { $inc: { 'counters.itemsSold': order.quantity, 'counters.grossUnits': toBigInt(order.quote.priceUnits) } },
            { session },
          );
          await GameModel.updateOne({ _id: game._id }, { $inc: { 'stats.grossUnits': toBigInt(order.quote.priceUnits) } }, { session });
          await curationService.recordSpend({ userId: user._id, amountUnits: order.quote.priceUnits, gameId: game._id }, session);
        }
        failpoint('commit');
        return op;
      });
    } catch (error) {
      // UC-07 Alt 4b: the transaction aborted, nothing was written; record why.
      if (!(error instanceof AppError && error.code === 'order_not_pending')) {
        await OrderModel.updateOne(
          { _id: order._id, status: { $in: ['pending', 'settling'] } },
          { $set: { status: 'failed', failureCode: error instanceof AppError ? error.code : 'internal_error' } },
        );
      }
      throw error;
    }

    if (chainOp) await chainService.kick(chainOp._id);
    const completed = await OrderModel.findById(order._id).lean();
    const studio = await StudioModel.findById(completed.studioId).select('pid').lean();
    const game = await GameModel.findById(completed.gameId).select('pid').lean();
    const buyer = await UserModel.findById(user._id).select('pid').lean();
    eventBus.emit('purchase.completed', {
      orderId: completed.pid,
      studioId: completed.studioId,
      studioPid: studio?.pid,
      gameId: game?.pid,
      passportId: buyer?.pid,
      sku: completed.sku,
      channel: completed.channel,
      grossUnits: toBigInt(completed.quote.priceUnits).toString(),
      studioUnits: toBigInt(completed.feeBreakdown.studioUnits).toString(),
      protocolUnits: toBigInt(completed.feeBreakdown.protocolUnits).toString(),
    });
    return this.presentCompleted(completed, user);
  },

  async cancel(user, orderPid) {
    const order = await OrderModel.findOneAndUpdate(
      { pid: orderPid, userId: user._id, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true },
    ).lean();
    if (!order) throw Conflict('order_not_pending');
    return { id: order.pid, status: order.status };
  },

  async getOrder(user, orderPid) {
    const order = await OrderModel.findOne({ pid: orderPid, userId: user._id }).lean();
    if (!order) throw NotFound('order_not_found');
    return presentOrder(order);
  },

  async adminGetOrder(orderPid) {
    const order = await OrderModel.findOne({ pid: orderPid }).lean();
    if (!order) throw NotFound('order_not_found');
    const [item, game, buyer] = await Promise.all([
      ItemDefinitionModel.findById(order.itemDefinitionId).select('pid name art').lean(),
      GameModel.findById(order.gameId).select('pid slug title').lean(),
      UserModel.findById(order.userId).select('pid handle').lean(),
    ]);
    return { ...presentOrder(order, { item, game }), buyer: buyer ? { id: buyer.pid, handle: buyer.handle } : null, refundable: order.status === 'completed' && (!order.disputeWindowEndsAt || order.disputeWindowEndsAt > new Date()) };
  },

  async listOrders(user, { limit = 50 } = {}) {
    const orders = await OrderModel.find({ userId: user._id, channel: { $ne: 'sandbox' } }).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).lean();
    const items = await ItemDefinitionModel.find({ _id: { $in: orders.map((order) => order.itemDefinitionId) } }).select('pid name art').lean();
    const games = await GameModel.find({ _id: { $in: orders.map((order) => order.gameId) } }).select('pid slug title').lean();
    const itemById = new Map(items.map((item) => [String(item._id), item]));
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    return orders.map((order) => presentOrder(order, { item: itemById.get(String(order.itemDefinitionId)), game: gameById.get(String(order.gameId)) }));
  },

  async presentCompleted(order, user) {
    const [inventory, wallet, game, op] = await Promise.all([
      order.inventoryItemId ? InventoryItemModel.findById(order.inventoryItemId).lean() : null,
      ledgerService.walletFor(user._id),
      GameModel.findById(order.gameId).select('pid').lean(),
      order.chainOpId ? chainService.getOpById(order.chainOpId) : null,
    ]);
    const entitlements = inventory ? [{ sku: order.sku, inventoryItemId: inventory.pid, quantity: inventory.quantity ?? 1 }] : [];
    const { token } = issueEntitlementToken({ passportId: user.pid, gameId: game?.pid, entitlements });
    const balance = mapBalance(wallet);
    return {
      id: order.pid,
      status: order.status,
      settledAt: order.settledAt,
      txHash: op?.txHash ?? inventory?.chain?.txHash ?? null,
      chain: {
        status: inventory?.chain?.status ?? 'none',
        txHash: op?.txHash ?? null,
        explorerUrl: chainService.explorerTxUrl(op?.txHash),
        opStatus: op?.status ?? null,
      },
      inventoryItem: inventory ? { id: inventory.pid, tokenId: inventory.tokenId, name: inventory.name } : null,
      itemDefinitionId: (await ItemDefinitionModel.findById(order.itemDefinitionId).select('pid').lean())?.pid,
      entitlementToken: token,
      balanceUnits: balance.balanceUnits,
      balanceSrv: balance.balanceSrv,
    };
  },

  /** UC-09: mirrored reversal, entitlement revoked, never an unbalanced ledger. */
  async refund(actor, orderPid, { reason, requestId } = {}) {
    const order = await OrderModel.findOne({ pid: orderPid }).lean();
    if (!order) throw NotFound('order_not_found');
    if (order.status !== 'completed') throw Conflict('order_not_refundable');
    if (order.disputeWindowEndsAt && order.disputeWindowEndsAt < new Date() && order.channel !== 'sandbox') {
      throw Conflict('dispute_window_closed');
    }

    const chainOp = await withTransaction(async (session) => {
      const claimed = await OrderModel.findOneAndUpdate({ _id: order._id, status: 'completed' }, { $set: { status: 'refunded', refundedAt: new Date() } }, { new: true, session }).lean();
      if (!claimed) throw Conflict('order_not_refundable');
      const studio = await StudioModel.findById(order.studioId).session(session).lean();
      const buyer = await UserModel.findById(order.userId).session(session).lean();
      const vault = await AccountModel.findById(studio.vaultAccountId).session(session).lean();
      const breakdown = order.feeBreakdown;
      const studioUnits = toBigInt(breakdown.studioUnits);
      const fromVault = toBigInt(vault.balanceUnits) >= studioUnits ? studioUnits : toBigInt(vault.balanceUnits) > 0n ? toBigInt(vault.balanceUnits) : 0n;
      const deficit = studioUnits - fromVault;

      const legs = [
        { accountId: (await ledgerService.walletFor(order.userId, session))._id, direction: 'credit', amountUnits: order.quote.priceUnits, reason: 'refund' },
        { accountId: studio.vaultAccountId, direction: 'debit', amountUnits: fromVault, reason: 'refund' },
      ];
      // UC-09 Alt 1a: a studio that already withdrew leaves a deficit — treasury absorbs it.
      if (deficit > 0n) legs.push({ accountId: await ledgerService.systemAccountId('treasury', session), direction: 'debit', amountUnits: deficit, reason: 'studio_debt', allowNegative: true });
      for (const [field, purpose] of Object.entries(FEE_PURPOSES)) {
        legs.push({ accountId: await ledgerService.systemAccountId(purpose, session), direction: 'debit', amountUnits: breakdown[field], reason: 'refund', allowNegative: true });
      }
      const { txId } = await ledgerService.post({ legs, refType: 'order', refId: order._id, memo: `refund ${order.pid}: ${reason ?? ''}`, reversalOf: order.ledgerTxId }, session);

      if (!order.lockReleasedAt) await ledgerService.unlock(studio.vaultAccountId, fromVault, session);
      if (deficit > 0n) await StudioModel.updateOne({ _id: studio._id }, { $inc: { debtUnits: deficit } }, { session });

      let op = null;
      if (order.inventoryItemId) {
        const item = await InventoryItemModel.findById(order.inventoryItemId).session(session).lean();
        if (item && ['owned', 'listed'].includes(item.status) && String(item.userId) === String(order.userId)) {
          ({ chainOp: op } = await inventoryService.revoke({ item, owner: buyer, reason: 'refund', quantity: order.quantity }, session));
        }
      }
      await itemsService.releaseSupply(order.itemDefinitionId, order.quantity, session);
      await OrderModel.updateOne({ _id: order._id }, { $set: { refundTxId: txId, lockReleasedAt: order.lockReleasedAt ?? new Date() } }, { session });
      if (order.channel !== 'sandbox') {
        await StudioModel.updateOne({ _id: studio._id }, { $inc: { 'counters.itemsSold': -order.quantity, 'counters.grossUnits': -toBigInt(order.quote.priceUnits) } }, { session });
      }
      if (actor) {
        await writeAudit({ actor, action: 'order.refund', targetType: 'order', targetId: order.pid, reason: reason ?? '', requestId }, session);
      }
      return op;
    });

    if (chainOp) await chainService.kick(chainOp._id, { waitMs: 200 });
    const studio = await StudioModel.findById(order.studioId).select('pid').lean();
    eventBus.emit('purchase.refunded', { orderId: order.pid, studioId: order.studioId, studioPid: studio?.pid, sku: order.sku, grossUnits: toBigInt(order.quote.priceUnits).toString() });
    return presentOrder(await OrderModel.findById(order._id).lean());
  },

  async releaseDisputeLocks({ limit = 200 } = {}) {
    const due = await OrderModel.find({ status: 'completed', disputeWindowEndsAt: { $lte: new Date() }, lockReleasedAt: null }).limit(limit).lean();
    for (const order of due) {
      await withTransaction(async (session) => {
        const claimed = await OrderModel.findOneAndUpdate({ _id: order._id, lockReleasedAt: null }, { $set: { lockReleasedAt: new Date() } }, { session });
        if (!claimed) return;
        const studio = await StudioModel.findById(order.studioId).session(session).lean();
        await ledgerService.unlock(studio.vaultAccountId, order.feeBreakdown.studioUnits, session);
      });
    }
    return { released: due.length };
  },

  async sweepExpired() {
    const result = await OrderModel.updateMany({ status: 'pending', 'quote.expiresAt': { $lt: new Date() } }, { $set: { status: 'cancelled', failureCode: 'quote_expired' } });
    return { cancelled: result.modifiedCount };
  },

  // ------------------------------------------------------------------ fiat on-ramp (UC-08)

  async createFiatSession(user, { orderId, returnUrl }) {
    const order = await OrderModel.findOne({ pid: orderId, userId: user._id, status: 'pending' }).lean();
    if (!order) throw Conflict('order_not_pending');
    const session = await onrampAdapter().createSession({
      userId: user.pid,
      usdAmount: order.quote.usdAmount,
      srvUnits: toBigInt(order.quote.priceUnits).toString(),
      returnUrl: returnUrl ?? `${env.APP_BASE_URL}/passport/orders`,
    });
    // Extend the quote so the card flow has time to complete.
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { onrampSessionId: session.sessionId, paymentMethod: 'fiat_onramp', 'quote.expiresAt': new Date(Date.now() + 15 * 60_000) } },
    );
    return session;
  },

  /** Partner webhook: a market purchase of SRV credited to the buyer, then the order settles. */
  async completeFiatSession({ sessionId, status }) {
    const order = await OrderModel.findOne({ onrampSessionId: sessionId }).lean();
    if (!order) throw NotFound('session_not_found');
    if (status !== 'succeeded') {
      await OrderModel.updateOne({ _id: order._id, status: 'pending' }, { $set: { status: 'failed', failureCode: 'onramp_failed' } });
      return { orderId: order.pid, status: 'failed' };
    }
    await withTransaction(async (session) => {
      // Partner webhooks are at-least-once: the credit flag flips in the same transaction as
      // the credit, so a re-delivery finds nothing to claim and credits nothing.
      const claimed = await OrderModel.updateOne({ _id: order._id, onrampCreditedAt: null }, { $set: { onrampCreditedAt: new Date() } }, { session });
      if (claimed.modifiedCount !== 1) return;
      await ledgerService.post(
        {
          legs: [
            { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'debit', amountUnits: order.quote.priceUnits, reason: 'onramp_credit' },
            { accountId: (await ledgerService.walletFor(order.userId, session))._id, direction: 'credit', amountUnits: order.quote.priceUnits, reason: 'onramp_credit' },
          ],
          refType: 'onramp_session',
          refId: order._id,
          memo: `onramp ${sessionId}`,
        },
        session,
      );
    });
    const user = await UserModel.findById(order.userId).lean();
    if (order.status === 'pending') {
      try {
        await this.confirm({ ...user, id: user.pid }, order.pid);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    return { orderId: order.pid, status: (await OrderModel.findById(order._id).lean()).status };
  },
};

function failpoint(name) {
  if (failpoints.has(name)) throw new AppError(`failpoint_${name}`, 500);
}

function presentIntent(order, { item, game, studio }) {
  return {
    id: order.pid,
    status: order.status,
    item: { id: item.pid, name: item.name, kind: item.kind, art: publicAsset(item.art) },
    game: { id: game.pid, slug: game.slug, title: game.title, studioHandle: studio.handle },
    quantity: order.quantity,
    paymentMethod: order.paymentMethod,
    quote: {
      priceUnits: toBigInt(order.quote.priceUnits).toString(),
      priceSrv: fromUnits(order.quote.priceUnits),
      usdAmount: order.quote.usdAmount,
      rateSnapshot: order.quote.rateSnapshot,
      expiresAt: order.quote.expiresAt,
    },
    feeBreakdown: serializeBreakdown(order.feeBreakdown),
    // Back-compat fields consumed by the current Store UI.
    priceUnits: toBigInt(order.quote.priceUnits).toString(),
    priceSrv: fromUnits(order.quote.priceUnits),
    priceUsdSnapshot: order.quote.usdAmount,
    expiresAt: order.quote.expiresAt,
    feeSplit: [
      { label: 'Studio', amountUnits: toBigInt(order.feeBreakdown.studioUnits).toString(), pct: 100 - order.feeBreakdown.feeBps / 100 },
      { label: 'Protocol', amountUnits: toBigInt(order.feeBreakdown.protocolUnits).toString(), pct: order.feeBreakdown.feeBps / 100 },
    ],
  };
}

export function presentOrder(order, { item, game } = {}) {
  return {
    id: order.pid,
    status: order.status,
    sku: order.sku,
    quantity: order.quantity,
    channel: order.channel,
    paymentMethod: order.paymentMethod,
    item: item ? { id: item.pid, name: item.name, art: publicAsset(item.art) } : undefined,
    game: game ? { id: game.pid, slug: game.slug, title: game.title } : undefined,
    quote: {
      priceUnits: toBigInt(order.quote.priceUnits).toString(),
      priceSrv: fromUnits(order.quote.priceUnits),
      usdAmount: order.quote.usdAmount,
      expiresAt: order.quote.expiresAt,
    },
    feeBreakdown: serializeBreakdown(order.feeBreakdown ?? {}),
    failureCode: order.failureCode,
    txHash: order.txHash,
    explorerUrl: chainService.explorerTxUrl(order.txHash),
    settledAt: order.settledAt,
    refundedAt: order.refundedAt,
    disputeWindowEndsAt: order.disputeWindowEndsAt,
    createdAt: order.createdAt,
  };
}

eventBus.on('chain.confirmed', async ({ kind, ref, txHash }) => {
  if (kind !== 'mint_item' || !ref.startsWith('mint:ord_')) return;
  await OrderModel.updateOne({ pid: ref.slice('mint:'.length) }, { $set: { txHash } });
});
