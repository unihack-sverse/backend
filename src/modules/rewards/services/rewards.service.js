import { REWARD_CHANNEL_SPLIT } from '../../../config/constants.js';
import { env } from '../../../config/env.js';
import { JobRunModel } from '../../../db/system-models.js';
import { Conflict, NotFound } from '../../../lib/errors.js';
import { epochBounds, epochNumberAt } from '../../../lib/epoch.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { buildMerkleTree, rewardLeaf } from '../../../lib/merkle.js';
import { applyBps, fromUnits, toBigInt } from '../../../lib/money.js';
import { reputationWeight } from '../../../lib/reputation.js';
import { withTransaction } from '../../../lib/transaction.js';
import { writeAudit } from '../../../lib/audit.js';
import { UserModel } from '../../auth/models/index.js';
import { chainService } from '../../chain/services/chain.service.js';
import { OrderModel } from '../../checkout/models/index.js';
import { ClubPostModel } from '../../clubs/models/index.js';
import { DeedModel, DeedStatusModel } from '../../deeds/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { PlayRollupModel } from '../../telemetry/models/index.js';
import { CuratorAttributionModel, RewardClaimModel, RewardEpochModel } from '../models/index.js';

const PLAYER_POOL_BPS = 2000;
const CREATOR_POOL_BPS = 2500;
const MIN_REPUTATION = 20;
const PER_PASSPORT_CAP_BPS = 500;
const EMISSION_EPOCHS = 52 * 5;

export const rewardsService = {
  async ensureEpoch(number) {
    const { startAt, endAt } = epochBounds(number);
    return RewardEpochModel.findOneAndUpdate(
      { number },
      { $setOnInsert: { pid: publicId('epo'), number, startAt, endAt, channelSplit: REWARD_CHANNEL_SPLIT, status: 'open' } },
      { upsert: true, new: true },
    ).lean();
  },

  async current() {
    const epoch = await this.ensureEpoch(epochNumberAt(new Date()));
    const feeRevenueUnits = await ledgerService.sumRevenue({ epoch: epoch.number });
    return {
      ...mapEpoch(epoch),
      projected: {
        feeRevenueUnits: feeRevenueUnits.toString(),
        playerPoolUnits: (applyBps(feeRevenueUnits, PLAYER_POOL_BPS) + bootstrapEmission(epoch.number)).toString(),
        creatorPoolUnits: applyBps(feeRevenueUnits, CREATOR_POOL_BPS).toString(),
      },
    };
  },

  async byNumber(number) {
    const epoch = await RewardEpochModel.findOne({ number }).lean();
    if (!epoch) throw NotFound('epoch_not_found');
    return mapEpoch(epoch);
  },

  async list({ limit = 20 } = {}) {
    const epochs = await RewardEpochModel.find().sort({ number: -1 }).limit(limit).lean();
    return epochs.map(mapEpoch);
  },

  /** Closes every ended epoch that is still open. Run by the scheduler; safe to run twice. */
  async closeDueEpochs() {
    const currentNumber = epochNumberAt(new Date());
    const latest = await RewardEpochModel.findOne().sort({ number: -1 }).lean();
    if (!latest) await this.ensureEpoch(currentNumber);
    const due = await RewardEpochModel.find({ status: 'open', endAt: { $lte: new Date() } }).sort({ number: 1 }).limit(4).lean();
    const closed = [];
    for (const epoch of due) closed.push(await this.closeEpoch(epoch.number));
    await this.ensureEpoch(currentNumber);
    return { closed: closed.map((epoch) => epoch.number) };
  },

  /**
   * UC-26. Pools come only from realized fee revenue plus the sunsetting emission; the budget
   * can never exceed what the network earned (concept §8.1).
   */
  async closeEpoch(number, { actor = null, force = false, reason = '' } = {}) {
    const epoch = await this.ensureEpoch(number);
    if (epoch.status === 'published') return mapEpoch(epoch);
    if (!force && epoch.endAt > new Date()) throw Conflict('epoch_not_ended');

    const runKey = `epoch-close:${number}`;
    try {
      await JobRunModel.create({ key: runKey, queue: 'epoch-close' });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const run = await JobRunModel.findOne({ key: runKey }).lean();
      if (run?.status !== 'failed') throw Conflict('epoch_close_in_progress');
      await JobRunModel.updateOne({ key: runKey }, { $set: { status: 'running', startedAt: new Date(), error: null } });
    }

    try {
      await RewardEpochModel.updateOne({ _id: epoch._id }, { $set: { status: 'calculating' } });
      const feeRevenue = await ledgerService.sumRevenue({ epoch: number });
      const emission = bootstrapEmission(number);
      const playerPool = applyBps(feeRevenue, PLAYER_POOL_BPS) + emission;
      const creatorPool = applyBps(feeRevenue, CREATOR_POOL_BPS);

      const playerAwards = await scorePlayers(epoch, playerPool);
      const creatorAwards = await scoreCreators(epoch, creatorPool);
      const awards = [...playerAwards, ...creatorAwards].filter((award) => award.amountUnits > 0n);

      const leaves = awards.map((award, index) =>
        rewardLeaf({ epochNumber: number, index, account: award.address, amountUnits: award.amountUnits }),
      );
      const { root, proofs } = buildMerkleTree(leaves);
      const distributed = awards.reduce((sum, award) => sum + award.amountUnits, 0n);
      const claimDeadline = new Date(Date.now() + env.REWARD_CLAIM_WINDOW_DAYS * 86_400_000);

      const op = await withTransaction(async (session) => {
        if (emission > 0n) {
          await ledgerService.post(
            {
              legs: [
                { accountId: await ledgerService.systemAccountId('treasury', session), direction: 'debit', amountUnits: emission, reason: 'reward_funding', allowNegative: true },
                { accountId: await ledgerService.systemAccountId('player_rewards', session), direction: 'credit', amountUnits: emission, reason: 'reward_funding' },
              ],
              refType: 'reward_epoch',
              refId: epoch._id,
              memo: `bootstrap emission epoch ${number}`,
            },
            session,
          );
        }
        if (awards.length) {
          await RewardClaimModel.insertMany(
            awards.map((award, index) => ({
              pid: publicId('clm'),
              epochId: epoch._id,
              epochNumber: number,
              claimantType: award.claimantType,
              claimantId: award.claimantId,
              claimantAddress: award.address,
              leafIndex: index,
              amountUnits: award.amountUnits,
              channels: award.channels,
              score: award.score,
              scoreInputs: award.scoreInputs,
              merkleProof: proofs[index],
            })),
            { session },
          );
        }
        let chainOp = null;
        if (root) {
          chainOp = await chainService.enqueue(
            {
              kind: 'publish_epoch',
              ref: `epoch:${number}`,
              refType: 'reward_epoch',
              refId: epoch._id,
              payload: { epochNumber: number, root, totalUnits: distributed.toString(), claimDeadline: claimDeadline.toISOString() },
            },
            session,
          );
        }
        await RewardEpochModel.updateOne(
          { _id: epoch._id },
          {
            $set: {
              status: 'published',
              closedAt: new Date(),
              feeRevenueUnits: feeRevenue,
              bootstrapEmissionUnits: emission,
              playerPoolUnits: playerPool,
              creatorPoolUnits: creatorPool,
              distributedUnits: distributed,
              participants: { players: playerAwards.length, studios: creatorAwards.length },
              merkleRoot: root,
              claimDeadline,
              chainOpId: chainOp?._id ?? null,
            },
          },
          { session },
        );
        if (actor) await writeAudit({ actor, action: 'epoch.close', targetType: 'reward_epoch', targetId: epoch.pid, reason: reason || (force ? 'forced' : 'manual') }, session);
        return chainOp;
      });

      await JobRunModel.updateOne({ key: runKey }, { $set: { status: 'done', finishedAt: new Date() } });
      if (op) await chainService.kick(op._id, { waitMs: 200 });
      eventBus.emit('reward.distributed', { epochNumber: number, distributedUnits: distributed.toString(), participants: awards.length });
      return mapEpoch(await RewardEpochModel.findById(epoch._id).lean());
    } catch (error) {
      await JobRunModel.updateOne({ key: runKey }, { $set: { status: 'failed', error: String(error?.message ?? error) } });
      await RewardEpochModel.updateOne({ _id: epoch._id, status: 'calculating' }, { $set: { status: 'open', failureReason: String(error?.message ?? error) } });
      throw error;
    }
  },

  async forUser(user) {
    const current = await this.current();
    const claims = await RewardClaimModel.find({ claimantType: 'user', claimantId: user._id }).sort({ epochNumber: -1 }).limit(20).lean();
    const latestPublished = await RewardEpochModel.findOne({ status: 'published' }).sort({ number: -1 }).lean();
    const myClaim = latestPublished ? claims.find((claim) => claim.epochNumber === latestPublished.number) : null;
    const unclaimed = claims.filter((claim) => claim.status === 'unclaimed');
    return {
      epoch: latestPublished ? mapEpoch(latestPublished) : null,
      current,
      myClaim: myClaim ? mapClaim(myClaim) : null,
      claims: await withEpochIds(claims),
      unclaimedUnits: unclaimed.reduce((sum, claim) => sum + toBigInt(claim.amountUnits), 0n).toString(),
      // Back-compat for the current rewards page.
      id: latestPublished?.pid ?? current.id,
      status: myClaim?.status === 'claimed' ? 'claimed' : latestPublished?.status ?? 'open',
      claimed: myClaim?.status === 'claimed',
      poolUnits: toBigInt(latestPublished?.playerPoolUnits ?? 0n).toString(),
      channels: myClaim ? mapClaim(myClaim).channels : [],
    };
  },

  async forStudio(studio) {
    const claims = await RewardClaimModel.find({ claimantType: 'studio', claimantId: studio._id }).sort({ epochNumber: -1 }).limit(20).lean();
    return withEpochIds(claims);
  },

  /**
   * UC-27. The claim row flips unclaimed → claimed with a guarded update inside the same
   * transaction as the credit, and a unique index backs it: parallel claims credit once.
   */
  async claim({ claimantType, claimantId, epochPid }) {
    const epoch = await RewardEpochModel.findOne({ pid: epochPid }).lean();
    if (!epoch) throw NotFound('epoch_not_found');
    const claim = await RewardClaimModel.findOne({ epochId: epoch._id, claimantType, claimantId }).lean();
    if (!claim) throw NotFound('claim_not_found');
    if (claim.status === 'claimed') throw Conflict('already_claimed');
    if (epoch.claimDeadline && epoch.claimDeadline < new Date()) throw Conflict('claim_window_closed');

    return withTransaction(async (session) => {
      const flipped = await RewardClaimModel.findOneAndUpdate(
        { _id: claim._id, status: 'unclaimed' },
        { $set: { status: 'claimed', claimedAt: new Date() } },
        { new: true, session },
      ).lean();
      if (!flipped) throw Conflict('already_claimed');

      const destination =
        claimantType === 'user'
          ? (await ledgerService.walletFor(claimantId, session))._id
          : (await StudioModel.findById(claimantId).session(session).lean()).vaultAccountId;
      const { txId } = await ledgerService.post(
        {
          legs: [
            {
              accountId: await ledgerService.systemAccountId(claimantType === 'user' ? 'player_rewards' : 'creator_rewards', session),
              direction: 'debit',
              amountUnits: claim.amountUnits,
              reason: 'reward_claim',
            },
            { accountId: destination, direction: 'credit', amountUnits: claim.amountUnits, reason: 'reward_claim' },
          ],
          refType: 'reward_claim',
          refId: claim._id,
          memo: `epoch ${epoch.number} claim`,
        },
        session,
      );
      await RewardClaimModel.updateOne({ _id: claim._id }, { $set: { ledgerTxId: txId } }, { session });
      const balance = await ledgerService.balance(destination, session);
      return {
        epochId: epoch.pid,
        claimId: claim.pid,
        claimed: true,
        amountUnits: toBigInt(claim.amountUnits).toString(),
        amountSrv: fromUnits(claim.amountUnits),
        balanceUnits: balance.balanceUnits,
        balanceSrv: balance.balanceSrv,
        merkleRoot: epoch.merkleRoot,
        merkleProof: claim.merkleProof,
      };
    });
  },
};

export function bootstrapEmission(epochNumber) {
  const base = env.BOOTSTRAP_EMISSION_UNITS;
  if (base <= 0n || epochNumber > EMISSION_EPOCHS) return 0n;
  // Halves annually, reaching zero after five years (concept §8.1).
  const halvings = BigInt(Math.floor((epochNumber - 1) / 52));
  return base >> halvings;
}

async function scorePlayers(epoch, poolUnits) {
  if (poolUnits <= 0n) return [];
  const window = { $gte: epoch.startAt, $lt: epoch.endAt };
  const [rollups, deeds, posts, attributions] = await Promise.all([
    PlayRollupModel.aggregate([{ $match: { epoch: epoch.number } }, { $group: { _id: '$userId', weighted: { $sum: '$weightedMinutes' }, minutes: { $sum: '$minutes' } } }]),
    DeedModel.aggregate([{ $match: { createdAt: window } }, { $group: { _id: { userId: '$userId', deedType: '$deedType' }, n: { $sum: 1 }, ids: { $push: '$_id' } } }]),
    ClubPostModel.aggregate([
      { $match: { createdAt: window, status: 'visible', authorUserId: { $ne: null } } },
      { $group: { _id: '$authorUserId', reactions: { $sum: { $add: ['$reactions.up', { $multiply: ['$reactions.insightful', 2] }] } }, posts: { $sum: 1 } } },
    ]),
    CuratorAttributionModel.find({ flagged: false }).lean(),
  ]);

  const unverified = new Set(
    (await DeedStatusModel.find({ deedId: { $in: deeds.flatMap((row) => row.ids) }, verified: false }).select('deedId').lean()).map((row) => String(row.deedId)),
  );
  const referredSpend = await spendByCurator(attributions, epoch);

  const scores = new Map();
  const bump = (userId, channel, value, note) => {
    if (!value) return;
    const key = String(userId);
    const entry = scores.get(key) ?? { userId, channels: {}, notes: {} };
    entry.channels[channel] = (entry.channels[channel] ?? 0) + value;
    entry.notes[channel] = note;
    scores.set(key, entry);
  };

  // Sublinear curves so 100 farmed accounts earn far less than they cost to run (concept §8.2).
  for (const row of rollups) bump(row._id, 'ladders', Math.sqrt(row.weighted), `${Math.round(row.minutes)} verified min`);
  for (const row of deeds) {
    const verifiedCount = row.ids.filter((id) => !unverified.has(String(id))).length;
    const channel = /^(tournament|bracket)/.test(row._id.deedType) ? 'tournaments' : 'achievement';
    bump(row._id.userId, channel, Math.sqrt(verifiedCount) * 10, `${verifiedCount} verified ${row._id.deedType}`);
  }
  for (const row of posts) bump(row._id, 'curation', Math.sqrt(row.reactions + row.posts), `${row.posts} posts`);
  for (const [curatorId, units] of referredSpend) bump(curatorId, 'curation', Math.sqrt(Number(units / 1_000_000n)), 'attributed spend');
  for (const attribution of attributions) {
    if (attribution.firstSpendAt && attribution.firstSpendAt < epoch.endAt && attribution.boundAt < new Date(epoch.endAt.getTime() - 30 * 86_400_000)) {
      bump(attribution.curatorUserId, 'referral', 1, 'retained referral');
    }
  }

  const users = await UserModel.find({ _id: { $in: [...scores.values()].map((entry) => entry.userId) }, status: 'active' })
    .select('_id pid reputation custodialAddress')
    .lean();
  const userById = new Map(users.filter((user) => user.reputation >= MIN_REPUTATION).map((user) => [String(user._id), user]));

  const cap = applyBps(poolUnits, PER_PASSPORT_CAP_BPS);
  const awards = new Map();
  for (const [channel, sharePct] of Object.entries(REWARD_CHANNEL_SPLIT)) {
    const channelPool = applyBps(poolUnits, sharePct * 100);
    const participants = [...scores.values()]
      .filter((entry) => entry.channels[channel] && userById.has(String(entry.userId)))
      .map((entry) => ({ entry, weighted: entry.channels[channel] * reputationWeight(userById.get(String(entry.userId)).reputation) }))
      .filter((row) => row.weighted > 0);
    const total = participants.reduce((sum, row) => sum + row.weighted, 0);
    if (!total) continue;
    for (const { entry, weighted } of participants) {
      const amount = (channelPool * BigInt(Math.floor((weighted / total) * 1e9))) / 1_000_000_000n;
      if (amount <= 0n) continue;
      const key = String(entry.userId);
      const award = awards.get(key) ?? { claimantType: 'user', claimantId: entry.userId, address: userById.get(key).custodialAddress, amountUnits: 0n, channels: [], score: 0, scoreInputs: {} };
      award.channels.push({ channel, sharePct, amountUnits: amount, note: entry.notes[channel] });
      award.amountUnits += amount;
      award.score += weighted;
      award.scoreInputs[channel] = Math.round(entry.channels[channel] * 1000) / 1000;
      awards.set(key, award);
    }
  }
  for (const award of awards.values()) {
    if (award.amountUnits > cap) {
      const scale = (cap * 1_000_000n) / award.amountUnits;
      award.channels = award.channels.map((channel) => ({ ...channel, amountUnits: (channel.amountUnits * scale) / 1_000_000n }));
      award.amountUnits = award.channels.reduce((sum, channel) => sum + channel.amountUnits, 0n);
      award.scoreInputs.capped = true;
    }
    award.score = Math.round(award.score * 1000) / 1000;
  }
  return [...awards.values()];
}

/** Creators: revenue^0.7 × playtime × retention × club × interop multipliers (concept §13.4). */
async function scoreCreators(epoch, poolUnits) {
  if (poolUnits <= 0n) return [];
  const revenue = await OrderModel.aggregate([
    { $match: { status: 'completed', channel: { $ne: 'sandbox' }, settledAt: { $gte: epoch.startAt, $lt: epoch.endAt } } },
    { $group: { _id: '$studioId', revenue: { $sum: '$feeBreakdown.studioUnits' } } },
  ]);
  if (!revenue.length) return [];
  const studios = await StudioModel.find({ _id: { $in: revenue.map((row) => row._id) }, status: 'active' }).lean();
  const studioById = new Map(studios.map((studio) => [String(studio._id), studio]));

  const scored = [];
  for (const row of revenue) {
    const studio = studioById.get(String(row._id));
    if (!studio) continue;
    const games = await GameModel.find({ studioId: studio._id }).select('_id stats').lean();
    const gameIds = games.map((game) => game._id);
    const [minutes, posts, interopItems] = await Promise.all([
      PlayRollupModel.aggregate([{ $match: { gameId: { $in: gameIds }, epoch: epoch.number } }, { $group: { _id: null, weighted: { $sum: '$weightedMinutes' } } }]),
      ClubPostModel.aggregate([{ $match: { gameId: { $in: gameIds }, createdAt: { $gte: epoch.startAt, $lt: epoch.endAt }, status: 'visible' } }, { $group: { _id: null, weight: { $sum: '$weight' } } }]),
      ItemDefinitionModel.countDocuments({ studioId: studio._id, interopTier: { $in: ['T1', 'T2', 'T3'] }, status: 'active' }),
    ]);
    const revenueSrv = Number(toBigInt(row.revenue) / 1_000_000n);
    const weightedMinutes = minutes[0]?.weighted ?? 0;
    const d7 = games.length ? games.reduce((sum, game) => sum + (game.stats?.d7 ?? 0), 0) / games.length : 0;
    const inputs = {
      revenueUnits: toBigInt(row.revenue).toString(),
      playtimeMult: round(1 + Math.min(0.5, Math.log10(1 + weightedMinutes) / 10)),
      retentionMult: round(1 + Math.min(0.5, d7)),
      clubMult: round(1 + Math.min(0.25, (posts[0]?.weight ?? 0) / 400)),
      interopMult: interopItems > 0 ? 1.15 : 1,
    };
    const score = revenueSrv ** 0.7 * inputs.playtimeMult * inputs.retentionMult * inputs.clubMult * inputs.interopMult;
    scored.push({ studio, score: round(score), inputs });
  }
  const total = scored.reduce((sum, row) => sum + row.score, 0);
  if (!total) return [];
  return scored.map(({ studio, score, inputs }) => {
    const amount = (poolUnits * BigInt(Math.floor((score / total) * 1e9))) / 1_000_000_000n;
    return {
      claimantType: 'studio',
      claimantId: studio._id,
      address: studio.signerAddress,
      amountUnits: amount,
      channels: [{ channel: 'creator', sharePct: 100, amountUnits: amount, note: `score ${score}` }],
      score,
      scoreInputs: inputs,
    };
  });
}

async function spendByCurator(attributions, epoch) {
  const result = new Map();
  if (!attributions.length) return result;
  const curators = await UserModel.find({ _id: { $in: attributions.map((row) => row.curatorUserId) }, reputation: { $gte: 70 } }).select('_id').lean();
  const eligible = new Set(curators.map((row) => String(row._id)));
  const byReferred = new Map(attributions.filter((row) => eligible.has(String(row.curatorUserId))).map((row) => [String(row.referredUserId), row]));
  if (!byReferred.size) return result;
  const spend = await OrderModel.aggregate([
    { $match: { status: 'completed', channel: { $ne: 'sandbox' }, userId: { $in: [...byReferred.values()].map((row) => row.referredUserId) }, settledAt: { $gte: epoch.startAt, $lt: epoch.endAt } } },
    { $group: { _id: '$userId', units: { $sum: '$quote.priceUnits' } } },
  ]);
  for (const row of spend) {
    const attribution = byReferred.get(String(row._id));
    const key = String(attribution.curatorUserId);
    result.set(key, (result.get(key) ?? 0n) + toBigInt(row.units));
  }
  return new Map([...result].map(([key, units]) => [attributions.find((row) => String(row.curatorUserId) === key).curatorUserId, units]));
}

export function mapEpoch(epoch) {
  return {
    id: epoch.pid,
    number: epoch.number,
    status: epoch.status,
    startAt: epoch.startAt,
    endAt: epoch.endAt,
    feeRevenueUnits: toBigInt(epoch.feeRevenueUnits).toString(),
    feeRevenueSrv: fromUnits(epoch.feeRevenueUnits ?? 0n),
    bootstrapEmissionUnits: toBigInt(epoch.bootstrapEmissionUnits).toString(),
    playerPoolUnits: toBigInt(epoch.playerPoolUnits).toString(),
    playerPoolSrv: fromUnits(epoch.playerPoolUnits ?? 0n),
    creatorPoolUnits: toBigInt(epoch.creatorPoolUnits).toString(),
    creatorPoolSrv: fromUnits(epoch.creatorPoolUnits ?? 0n),
    distributedUnits: toBigInt(epoch.distributedUnits).toString(),
    distributedSrv: fromUnits(epoch.distributedUnits ?? 0n),
    channelSplit: epoch.channelSplit,
    participants: epoch.participants,
    merkleRoot: epoch.merkleRoot,
    publishMerkleTxHash: epoch.publishMerkleTxHash,
    explorerUrl: chainService.explorerTxUrl(epoch.publishMerkleTxHash),
    claimDeadline: epoch.claimDeadline,
    closedAt: epoch.closedAt,
    fundedBy: '20% of realized protocol fees + bootstrap emission',
  };
}

function mapClaim(claim) {
  return {
    id: claim.pid,
    epochNumber: claim.epochNumber,
    amountUnits: toBigInt(claim.amountUnits).toString(),
    amountSrv: fromUnits(claim.amountUnits),
    status: claim.status,
    channels: (claim.channels ?? []).map((channel) => ({
      channel: channel.channel,
      sharePct: channel.sharePct,
      amountUnits: toBigInt(channel.amountUnits).toString(),
      amountSrv: fromUnits(channel.amountUnits),
      note: channel.note,
    })),
    score: claim.score,
    scoreInputs: claim.scoreInputs,
    claimedAt: claim.claimedAt,
  };
}

async function withEpochIds(claims) {
  const epochs = await RewardEpochModel.find({ _id: { $in: claims.map((claim) => claim.epochId) } }).select('pid').lean();
  const pidById = new Map(epochs.map((epoch) => [String(epoch._id), epoch.pid]));
  return claims.map((claim) => ({ ...mapClaim(claim), epochId: pidById.get(String(claim.epochId)) ?? null }));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

chainService.registerHandler('publish_epoch', {
  async onCompleted(op) {
    await RewardEpochModel.updateOne({ _id: op.refId }, { $set: { publishMerkleTxHash: op.txHash } });
  },
  async onFailed() {},
});
