import { writeAudit } from '../../../lib/audit.js';
import { Conflict, NotFound } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { toBigInt } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { inventoryService } from '../../inventory/services/inventory.service.js';
import { itemsService } from '../../items/services/items.service.js';
import { AccountModel } from '../../ledger/models/index.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { OrderModel } from '../models/index.js';
import { FEE_PURPOSES, presentOrder } from './checkout.mapper.js';

/** UC-09: mirrored reversal, entitlement revoked, never an unbalanced ledger. */
export async function refundOrder(actor, orderPid, { reason, requestId } = {}) {
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
}

export async function releaseDisputeLocks({ limit = 200 } = {}) {
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
}
