import { issueEntitlementToken } from '../../../lib/entitlement.js';
import { publicAsset } from '../../../lib/assets.js';
import { fromUnits, serializeBreakdown, toBigInt } from '../../../lib/money.js';
import { chainService } from '../../chain/services/chain.service.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { ledgerService, mapBalance } from '../../ledger/services/ledger.service.js';

export const FEE_PURPOSES = {
  burnUnits: 'burn',
  creatorRewardsUnits: 'creator_rewards',
  playerRewardsUnits: 'player_rewards',
  treasuryUnits: 'treasury',
  curatorUnits: 'curator',
};

export function presentIntent(order, { item, game, studio }) {
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

export async function presentCompleted(order, user) {
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
}
