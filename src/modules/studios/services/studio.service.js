import { chainAdapter } from '../../../adapters/chain/index.js';
import { env } from '../../../config/env.js';
import { nextSequence } from '../../../db/system-models.js';
import { Conflict, Forbidden, NotFound, PaymentRequired, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { randomBase62 } from '../../../lib/hmac.js';
import { publicId } from '../../../lib/ids.js';
import { publicAssetUrl } from '../../../lib/assets.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { hashWithPepper, seal } from '../../../lib/secret-box.js';
import { withTransaction } from '../../../lib/transaction.js';
import { writeAudit } from '../../../lib/audit.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { OrderModel } from '../../checkout/models/index.js';
import { ClubPostModel } from '../../clubs/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { itemsService } from '../../items/services/items.service.js';
import { mapBalance, ledgerService } from '../../ledger/services/ledger.service.js';
import { AccountModel } from '../../ledger/models/index.js';
import { PlayRollupModel } from '../../telemetry/models/index.js';
import { WebhookDeliveryModel } from '../../webhooks/models/index.js';
import { ApiKeyModel, StudioModel, WebhookEndpointModel, WithdrawalModel } from '../models/index.js';

const FEE_TIERS = [
  { tier: 'premium', minStakeUnits: 100_000_000_000n, bps: () => env.PROTOCOL_FEE_BPS_PREMIUM },
  { tier: 'staked', minStakeUnits: 10_000_000_000n, bps: () => env.PROTOCOL_FEE_BPS_STAKED },
  { tier: 'standard', minStakeUnits: 0n, bps: () => env.PROTOCOL_FEE_BPS_STANDARD },
];

export const studioService = {
  /** UC-18: studio + vault + bond accounts + creator role, one transaction. No KYB at this tier. */
  async create(user, { handle, displayName, bio = '' }) {
    if (user.studioId) throw Conflict('studio_exists');
    const normalized = handle.toLowerCase();
    if (await StudioModel.exists({ handle: normalized })) throw Conflict('handle_taken');

    const studio = await withTransaction(async (session) => {
      const custodyIndex = await nextSequence('custody:studio', session);
      const { address } = await chainAdapter().createAccount({ kind: 'studio', index: custodyIndex });
      const studioId = new StudioModel()._id;
      const vault = await ledgerService.createAccount({ ownerType: 'studio', ownerId: studioId, purpose: 'vault' }, session);
      const bond = await ledgerService.createAccount({ ownerType: 'studio_bond', ownerId: studioId, purpose: 'bond' }, session);
      const [created] = await StudioModel.create(
        [
          {
            _id: studioId,
            pid: publicId('std'),
            ownerUserId: user._id,
            handle: normalized,
            displayName,
            bio,
            vaultAccountId: vault._id,
            bondAccountId: bond._id,
            feeTier: 'standard',
            feeBps: env.PROTOCOL_FEE_BPS_STANDARD,
            custodyIndex,
            signerAddress: address,
          },
        ],
        { session },
      );
      const updated = await UserModel.updateOne(
        { _id: user._id, studioId: null },
        { $set: { studioId }, $addToSet: { roles: 'creator' } },
        { session },
      );
      if (updated.modifiedCount !== 1) throw Conflict('studio_exists');
      await itemsService.ensureLicense(created, 'derivative', session);
      return created.toObject();
    });
    return this.present(studio);
  },

  async getMine(user) {
    return this.present(await requireStudio(user));
  },

  async getByHandle(handle) {
    const studio = await StudioModel.findOne({ handle: handle.toLowerCase(), status: { $ne: 'closed' } }).lean();
    if (!studio) throw NotFound('studio_not_found');
    const games = await GameModel.find({ studioId: studio._id, status: 'live' }).sort({ publishedAt: -1 }).lean();
    return {
      ...mapStudioPublic(studio),
      games: games.map((game) => ({ id: game.pid, slug: game.slug, title: game.title, coverArt: game.coverArt, genre: game.genre })),
    };
  },

  async updateMine(user, patch) {
    const studio = await requireStudio(user);
    const set = {};
    for (const field of ['displayName', 'bio', 'avatarUrl', 'payoutAddress']) if (patch[field] !== undefined) set[field] = patch[field];
    if (patch.links) for (const [key, value] of Object.entries(patch.links)) set[`links.${key}`] = value;
    const updated = await StudioModel.findOneAndUpdate({ _id: studio._id }, { $set: set }, { new: true }).lean();
    return this.present(updated);
  },

  async present(studio) {
    const [vault, bond] = await Promise.all([
      AccountModel.findById(studio.vaultAccountId).lean(),
      AccountModel.findById(studio.bondAccountId).lean(),
    ]);
    return {
      ...mapStudioPublic(studio),
      feeTier: studio.feeTier,
      feeBps: studio.feeBps,
      signerAddress: studio.signerAddress,
      payoutAddress: studio.payoutAddress,
      kycVerified: Boolean(studio.kycVerifiedAt),
      strikes: studio.strikes,
      status: studio.status,
      vault: vault ? mapBalance(vault) : null,
      bond: bond ? mapBalance(bond) : null,
      minListingBondUnits: env.MIN_LISTING_BOND_UNITS.toString(),
      feeTiers: FEE_TIERS.map((tier) => ({ tier: tier.tier, minStakeUnits: tier.minStakeUnits.toString(), feeBps: tier.bps() })).reverse(),
      withdrawnUnits: toBigInt(studio.withdrawnUnits).toString(),
      kycThresholdUnits: env.KYC_THRESHOLD_UNITS.toString(),
      counters: {
        games: studio.counters?.games ?? 0,
        itemsSold: studio.counters?.itemsSold ?? 0,
        grossUnits: toBigInt(studio.counters?.grossUnits).toString(),
      },
    };
  },

  /** Moves SRV vault → bond. The bond is slashable and drives the fee tier (concept §13.3). */
  async stake(user, amountUnits) {
    const studio = await requireStudio(user);
    const amount = toBigInt(amountUnits);
    await withTransaction(async (session) => {
      await ledgerService.post(
        {
          legs: [
            { accountId: studio.vaultAccountId, direction: 'debit', amountUnits: amount, reason: 'bond_stake', requireAvailable: true },
            { accountId: studio.bondAccountId, direction: 'credit', amountUnits: amount, reason: 'bond_stake' },
          ],
          refType: 'studio',
          refId: studio._id,
          memo: 'stake listing bond',
        },
        session,
      );
      await recalcFeeTier(studio._id, session);
    });
    const { reviewService } = await import('../../review/services/review.service.js');
    await reviewService.releaseBondBlocks(studio._id);
    return this.present(await StudioModel.findById(studio._id).lean());
  },

  async unstake(user, amountUnits) {
    const studio = await requireStudio(user);
    const amount = toBigInt(amountUnits);
    await withTransaction(async (session) => {
      const bond = await AccountModel.findById(studio.bondAccountId).session(session).lean();
      const liveGames = await GameModel.countDocuments({ studioId: studio._id, status: { $in: ['live', 'in_review'] } }).session(session);
      const remaining = toBigInt(bond.balanceUnits) - amount;
      if (liveGames > 0 && remaining < env.MIN_LISTING_BOND_UNITS) throw Unprocessable('bond_required');
      await ledgerService.post(
        {
          legs: [
            { accountId: studio.bondAccountId, direction: 'debit', amountUnits: amount, reason: 'bond_stake' },
            { accountId: studio.vaultAccountId, direction: 'credit', amountUnits: amount, reason: 'bond_stake' },
          ],
          refType: 'studio',
          refId: studio._id,
          memo: 'unstake listing bond',
        },
        session,
      );
      await recalcFeeTier(studio._id, session);
    });
    return this.present(await StudioModel.findById(studio._id).lean());
  },

  async analytics(user, { days = 30 } = {}) {
    const studio = await requireStudio(user);
    const since = new Date(Date.now() - days * 86_400_000);
    const games = await GameModel.find({ studioId: studio._id }).lean();
    const gameIds = games.map((game) => game._id);

    const [revenueByDay, byItem, totals, rollups, clubPosts] = await Promise.all([
      OrderModel.aggregate([
        { $match: { studioId: studio._id, status: 'completed', settledAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$settledAt' } },
            grossUnits: { $sum: '$quote.priceUnits' },
            netUnits: { $sum: '$feeBreakdown.studioUnits' },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      OrderModel.aggregate([
        { $match: { studioId: studio._id, status: 'completed' } },
        { $group: { _id: '$sku', units: { $sum: '$quantity' }, grossUnits: { $sum: '$quote.priceUnits' } } },
        { $sort: { grossUnits: -1 } },
        { $limit: 20 },
      ]),
      OrderModel.aggregate([
        { $match: { studioId: studio._id, status: { $in: ['completed', 'refunded'] } } },
        {
          $group: {
            _id: '$status',
            grossUnits: { $sum: '$quote.priceUnits' },
            netUnits: { $sum: '$feeBreakdown.studioUnits' },
            buyers: { $addToSet: '$userId' },
            orders: { $sum: 1 },
          },
        },
      ]),
      PlayRollupModel.aggregate([
        { $match: { gameId: { $in: gameIds }, date: { $gte: since.toISOString().slice(0, 10) } } },
        { $group: { _id: '$date', players: { $addToSet: '$userId' }, minutes: { $sum: '$minutes' } } },
        { $sort: { _id: 1 } },
      ]),
      ClubPostModel.countDocuments({ gameId: { $in: gameIds }, createdAt: { $gte: since }, status: 'visible' }),
    ]);

    const completed = totals.find((row) => row._id === 'completed');
    const refunded = totals.find((row) => row._id === 'refunded');
    const players = new Set(rollups.flatMap((row) => row.players.map(String)));
    const buyers = new Set((completed?.buyers ?? []).map(String));
    const playtime = rollups.reduce((sum, row) => sum + row.minutes, 0);
    const average = (field) => (games.length ? games.reduce((sum, game) => sum + (game.stats?.[field] ?? 0), 0) / games.length : 0);

    return {
      studio: { id: studio.pid, handle: studio.handle },
      windowDays: days,
      feeBps: studio.feeBps,
      grossUnits: toBigInt(completed?.grossUnits).toString(),
      grossSrv: fromUnits(completed?.grossUnits ?? 0n),
      netUnits: toBigInt(completed?.netUnits).toString(),
      netSrv: fromUnits(completed?.netUnits ?? 0n),
      refundedUnits: toBigInt(refunded?.grossUnits).toString(),
      unitsSold: byItem.reduce((sum, row) => sum + row.units, 0),
      orders: completed?.orders ?? 0,
      buyers: buyers.size,
      dau: rollups.length ? rollups[rollups.length - 1].players.length : 0,
      activePlayers: players.size,
      playtimeMinutes: playtime,
      conversion: players.size ? Math.round((buyers.size / players.size) * 1000) / 10 : 0,
      retention: { d1: Math.round(average('d1') * 100), d7: Math.round(average('d7') * 100), d30: Math.round(average('d30') * 100) },
      clubPosts,
      revenueSeries: revenueByDay.map((row) => ({
        date: row._id,
        grossUnits: toBigInt(row.grossUnits).toString(),
        netUnits: toBigInt(row.netUnits).toString(),
        orders: row.orders,
      })),
      playSeries: rollups.map((row) => ({ date: row._id, players: row.players.length, minutes: row.minutes })),
      byItem: byItem.map((row) => ({ sku: row._id, units: row.units, grossUnits: toBigInt(row.grossUnits).toString() })),
      games: games.map((game) => ({ id: game.pid, slug: game.slug, title: game.title, status: game.status, stats: presentStats(game.stats) })),
    };
  },

  // ------------------------------------------------------------------ API keys (UC-24)

  async listApiKeys(user) {
    const studio = await requireStudio(user);
    const keys = await ApiKeyModel.find({ studioId: studio._id }).sort({ createdAt: -1 }).lean();
    const games = await GameModel.find({ _id: { $in: keys.map((key) => key.gameId).filter(Boolean) } }).select('pid slug').lean();
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    return keys.map((key) => mapApiKey(key, gameById.get(String(key.gameId))));
  },

  async createApiKey(user, { label = '', scopes = ['game'], gameId = null }) {
    const studio = await requireStudio(user);
    let game = null;
    if (gameId) {
      game = await GameModel.findOne({ pid: gameId, studioId: studio._id }).lean();
      if (!game) throw NotFound('game_not_found');
    }
    const secret = `sk_live_${randomBase62(32)}`;
    const key = await ApiKeyModel.create({
      pid: publicId('key'),
      studioId: studio._id,
      gameId: game?._id ?? null,
      label,
      prefix: secret.slice(0, 12),
      keyHash: hashWithPepper(secret),
      attestationSecretEnc: seal(secret),
      scopes,
    });
    // The plaintext secret is returned exactly once (UC-24).
    return { ...mapApiKey(key.toObject(), game), secret };
  },

  async revokeApiKey(user, keyPid) {
    const studio = await requireStudio(user);
    const key = await ApiKeyModel.findOneAndUpdate(
      { pid: keyPid, studioId: studio._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { new: true },
    ).lean();
    if (!key) throw NotFound('api_key_not_found');
    return mapApiKey(key);
  },

  // ------------------------------------------------------------------ webhooks

  async listWebhooks(user) {
    const studio = await requireStudio(user);
    const [endpoints, deliveries] = await Promise.all([
      WebhookEndpointModel.find({ studioId: studio._id, status: { $ne: 'deleted' } }).sort({ createdAt: -1 }).lean(),
      WebhookDeliveryModel.find({ studioId: studio._id }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    const endpointById = new Map(endpoints.map((endpoint) => [String(endpoint._id), endpoint]));
    return {
      endpoints: endpoints.map(mapWebhookEndpoint),
      deliveries: deliveries.map((delivery) => mapDelivery(delivery, endpointById.get(String(delivery.endpointId)))),
    };
  },

  async createWebhook(user, { url, events }) {
    const studio = await requireStudio(user);
    const secret = `whsec_${randomBase62(32)}`;
    const endpoint = await WebhookEndpointModel.create({
      pid: publicId('whe'),
      studioId: studio._id,
      url,
      events,
      signingSecretEnc: seal(secret),
      signingSecretPrefix: secret.slice(0, 12),
    });
    return { ...mapWebhookEndpoint(endpoint.toObject()), signingSecret: secret };
  },

  async updateWebhook(user, endpointPid, patch) {
    const studio = await requireStudio(user);
    const set = {};
    if (patch.url) set.url = patch.url;
    if (patch.events) set.events = patch.events;
    if (patch.status) {
      set.status = patch.status;
      if (patch.status === 'active') Object.assign(set, { failureStreak: 0, disabledAt: null });
    }
    const endpoint = await WebhookEndpointModel.findOneAndUpdate({ pid: endpointPid, studioId: studio._id }, { $set: set }, { new: true }).lean();
    if (!endpoint) throw NotFound('webhook_not_found');
    return mapWebhookEndpoint(endpoint);
  },

  async deleteWebhook(user, endpointPid) {
    const studio = await requireStudio(user);
    const endpoint = await WebhookEndpointModel.findOneAndUpdate(
      { pid: endpointPid, studioId: studio._id },
      // Soft delete: past deliveries keep their endpoint for the audit trail.
      { $set: { status: 'deleted', disabledAt: new Date() } },
      { new: true },
    ).lean();
    if (!endpoint) throw NotFound('webhook_not_found');
    return mapWebhookEndpoint(endpoint);
  },

  async replayDelivery(user, endpointPid, deliveryPid) {
    const studio = await requireStudio(user);
    const endpoint = await WebhookEndpointModel.findOne({ pid: endpointPid, studioId: studio._id }).lean();
    if (!endpoint) throw NotFound('webhook_not_found');
    const delivery = await WebhookDeliveryModel.findOneAndUpdate(
      { pid: deliveryPid, endpointId: endpoint._id },
      { $set: { status: 'pending', nextRetryAt: new Date(), attempts: 0, lastError: null } },
      { new: true },
    ).lean();
    if (!delivery) throw NotFound('delivery_not_found');
    return mapDelivery(delivery, endpoint);
  },

  // ------------------------------------------------------------------ withdrawals (UC-29)

  async listWithdrawals(user) {
    const studio = await requireStudio(user);
    const rows = await WithdrawalModel.find({ studioId: studio._id }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map(mapWithdrawal);
  },

  async withdraw(user, { amountUnits, destinationAddress }) {
    const studio = await requireStudio(user);
    const amount = toBigInt(amountUnits);
    const destination = destinationAddress ?? studio.payoutAddress;
    if (!destination) throw Unprocessable('payout_address_required');

    const cumulative = toBigInt(studio.withdrawnUnits) + amount;
    if (cumulative > env.KYC_THRESHOLD_UNITS && !studio.kycVerifiedAt) {
      throw Forbidden('kyc_required', {
        message: 'Identity verification is required above the withdrawal threshold.',
        details: [{ field: 'onboardingUrl', issue: `${env.STUDIO_BASE_URL.replace(/\/$/, '')}/studio/settings?kyc=start` }],
      });
    }

    const { withdrawal, chainOp } = await withTransaction(async (session) => {
      const vault = await AccountModel.findById(studio.vaultAccountId).session(session).lean();
      const available = toBigInt(vault.balanceUnits) - toBigInt(vault.lockedUnits);
      if (amount > available) {
        throw PaymentRequired('insufficient_funds', {
          message: `Available ${available} units; ${toBigInt(vault.lockedUnits)} units are held in the dispute window.`,
        });
      }
      const withdrawalId = new WithdrawalModel()._id;
      const { txId } = await ledgerService.post(
        {
          legs: [
            { accountId: studio.vaultAccountId, direction: 'debit', amountUnits: amount, reason: 'withdrawal', requireAvailable: true },
            { accountId: await ledgerService.systemAccountId('payable', session), direction: 'credit', amountUnits: amount, reason: 'withdrawal' },
          ],
          refType: 'withdrawal',
          refId: withdrawalId,
          memo: `withdrawal to ${destination}`,
        },
        session,
      );
      const [created] = await WithdrawalModel.create(
        [{ _id: withdrawalId, pid: publicId('wdr'), studioId: studio._id, amountUnits: amount, destinationAddress: destination, status: 'settling', ledgerTxId: txId }],
        { session },
      );
      await StudioModel.updateOne({ _id: studio._id }, { $inc: { withdrawnUnits: amount } }, { session });
      const op = await chainService.enqueue(
        {
          kind: 'payout',
          ref: `payout:${created.pid}`,
          refType: 'withdrawal',
          refId: created._id,
          payload: { to: destination, amountUnits: amount.toString(), withdrawalId: created.pid },
        },
        session,
      );
      await WithdrawalModel.updateOne({ _id: created._id }, { $set: { chainOpId: op._id } }, { session });
      return { withdrawal: created.toObject(), chainOp: op };
    });

    await chainService.kick(chainOp._id);
    return mapWithdrawal(await WithdrawalModel.findById(withdrawal._id).lean());
  },

  async markKycVerified(actor, studioPid, { reason, requestId }) {
    const studio = await StudioModel.findOneAndUpdate({ pid: studioPid }, { $set: { kycVerifiedAt: new Date() } }, { new: true }).lean();
    if (!studio) throw NotFound('studio_not_found');
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'studio.kyc_verified', targetType: 'studio', targetId: studio.pid, reason, requestId });
    return { id: studio.pid, kycVerified: true, kycVerifiedAt: studio.kycVerifiedAt };
  },
};

export async function requireStudio(user) {
  const studio = user.studio?._id
    ? await StudioModel.findById(user.studio._id).lean()
    : await StudioModel.findOne({ ownerUserId: user._id }).lean();
  if (!studio) throw Forbidden('creator_required');
  return studio;
}

export function mapStudioPublic(studio) {
  return {
    id: studio.pid,
    handle: studio.handle,
    displayName: studio.displayName,
    bio: studio.bio,
    avatarUrl: publicAssetUrl(studio.avatarUrl),
    links: studio.links,
    oneHumanStudio: studio.oneHumanStudio,
    genesis: studio.genesis,
    createdAt: studio.createdAt,
  };
}

export function presentStats(stats = {}) {
  return {
    playersLive: stats.playersLive ?? 0,
    dau: stats.dau ?? 0,
    mau: stats.mau ?? 0,
    playtimeMinutes: stats.playtimeMinutes ?? 0,
    proofOfPlayScore: stats.proofOfPlayScore ?? 0,
    d1: stats.d1 ?? 0,
    d7: stats.d7 ?? 0,
    d30: stats.d30 ?? 0,
  };
}

function mapApiKey(key, game) {
  return {
    id: key.pid,
    label: key.label,
    prefix: key.prefix,
    scopes: key.scopes,
    gameId: game?.pid ?? null,
    gameSlug: game?.slug ?? null,
    lastUsedAt: key.lastUsedAt,
    requestCount: key.requestCount,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}

function mapWebhookEndpoint(endpoint) {
  return {
    id: endpoint.pid,
    url: endpoint.url,
    events: endpoint.events,
    status: endpoint.status,
    failureStreak: endpoint.failureStreak,
    signingSecretPrefix: endpoint.signingSecretPrefix,
    disabledAt: endpoint.disabledAt,
    createdAt: endpoint.createdAt,
  };
}

function mapDelivery(delivery, endpoint) {
  return {
    id: delivery.pid,
    endpointId: endpoint?.pid ?? null,
    event: delivery.event,
    eventId: delivery.eventId,
    status: delivery.status,
    attempts: delivery.attempts,
    lastStatus: delivery.lastStatus,
    lastError: delivery.lastError,
    nextRetryAt: delivery.nextRetryAt,
    deliveredAt: delivery.deliveredAt,
    createdAt: delivery.createdAt,
  };
}

export function mapWithdrawal(row) {
  return {
    id: row.pid,
    amountUnits: toBigInt(row.amountUnits).toString(),
    amountSrv: fromUnits(row.amountUnits),
    destinationAddress: row.destinationAddress,
    status: row.status,
    txHash: row.txHash,
    explorerUrl: chainService.explorerTxUrl(row.txHash),
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    settledAt: row.settledAt,
  };
}

async function recalcFeeTier(studioId, session) {
  const studio = await StudioModel.findById(studioId).session(session).lean();
  const bond = await AccountModel.findById(studio.bondAccountId).session(session).lean();
  const staked = toBigInt(bond.balanceUnits);
  const tier = FEE_TIERS.find((candidate) => staked >= candidate.minStakeUnits);
  await StudioModel.updateOne({ _id: studioId }, { $set: { stakedUnits: staked, feeTier: tier.tier, feeBps: tier.bps() } }, { session });
}

chainService.registerHandler('payout', {
  async onCompleted(op) {
    const withdrawal = await WithdrawalModel.findById(op.refId).lean();
    if (!withdrawal || withdrawal.status === 'settled') return;
    await withTransaction(async (session) => {
      await ledgerService.post(
        {
          legs: [
            { accountId: await ledgerService.systemAccountId('payable', session), direction: 'debit', amountUnits: withdrawal.amountUnits, reason: 'withdrawal' },
            { accountId: await ledgerService.systemAccountId('onramp', session), direction: 'credit', amountUnits: withdrawal.amountUnits, reason: 'withdrawal' },
          ],
          refType: 'withdrawal',
          refId: withdrawal._id,
          memo: `settled on-chain ${op.txHash}`,
        },
        session,
      );
      await WithdrawalModel.updateOne({ _id: withdrawal._id }, { $set: { status: 'settled', settledAt: new Date(), txHash: op.txHash } }, { session });
    });
    const studio = await StudioModel.findById(withdrawal.studioId).select('pid').lean();
    eventBus.emit('payout.settled', { withdrawalId: withdrawal.pid, studioId: withdrawal.studioId, studioPid: studio?.pid, amountUnits: toBigInt(withdrawal.amountUnits).toString(), txHash: op.txHash });
  },
  // UC-29 Alt 4a: transfer failed → reverse the posting, funds return to the vault.
  async onFailed(op, message) {
    const withdrawal = await WithdrawalModel.findById(op.refId).lean();
    if (!withdrawal || withdrawal.status !== 'settling') return;
    await withTransaction(async (session) => {
      const { txId } = await ledgerService.reverse(withdrawal.ledgerTxId, { memo: 'withdrawal failed', reason: 'reversal' }, session);
      await WithdrawalModel.updateOne(
        { _id: withdrawal._id },
        { $set: { status: 'failed', failureCode: String(message).slice(0, 120), reversalTxId: txId } },
        { session },
      );
      await StudioModel.updateOne({ _id: withdrawal.studioId }, { $inc: { withdrawnUnits: -toBigInt(withdrawal.amountUnits) } }, { session });
    });
  },
});
