import { onrampAdapter as defaultOnrampAdapter } from '../../../adapters/onramp/index.js';
import { env, isTest } from '../../../config/env.js';
import { AppError, Conflict, NotFound, PaymentRequired, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { primarySaleBreakdown, toBigInt, usdSnapshot } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { inventoryService } from '../../inventory/services/inventory.service.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { itemsService } from '../../items/services/items.service.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { curationService } from '../../rewards/services/curation.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { OrderModel } from '../models/index.js';
import { FEE_PURPOSES, presentCompleted, presentIntent, presentOrder } from './checkout.mapper.js';
import { refundOrder, releaseDisputeLocks } from './checkout-refund.service.js';

export { presentOrder } from './checkout.mapper.js';

// Test-only fault injection for the atomicity invariant (T09 acceptance).
const failpoints = new Set();

function resolveOnramp(onramp) {
  return typeof onramp === 'function' ? onramp() : onramp;
}

export function createCheckoutService({ onramp = defaultOnrampAdapter } = {}) {
  return {
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

    presentCompleted(order, user) {
      return presentCompleted(order, user);
    },

    refund(actor, orderPid, options) {
      return refundOrder(actor, orderPid, options);
    },

    releaseDisputeLocks(options) {
      return releaseDisputeLocks(options);
    },

    async sweepExpired() {
      const result = await OrderModel.updateMany({ status: 'pending', 'quote.expiresAt': { $lt: new Date() } }, { $set: { status: 'cancelled', failureCode: 'quote_expired' } });
      return { cancelled: result.modifiedCount };
    },

    // ------------------------------------------------------------------ fiat on-ramp (UC-08)

    async createFiatSession(user, { orderId, returnUrl }, { onramp: onrampOverride } = {}) {
      const order = await OrderModel.findOne({ pid: orderId, userId: user._id, status: 'pending' }).lean();
      if (!order) throw Conflict('order_not_pending');
      const adapter = resolveOnramp(onrampOverride ?? onramp);
      const session = await adapter.createSession({
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
}

export const checkoutService = createCheckoutService();

function failpoint(name) {
  if (failpoints.has(name)) throw new AppError(`failpoint_${name}`, 500);
}

eventBus.on('chain.confirmed', async ({ kind, ref, txHash }) => {
  if (kind !== 'mint_item' || !ref.startsWith('mint:ord_')) return;
  await OrderModel.updateOne({ pid: ref.slice('mint:'.length) }, { $set: { txHash } });
});
