import { Conflict, NotFound } from '../../../lib/errors.js';
import { epochNumberAt } from '../../../lib/epoch.js';
import { publicId } from '../../../lib/ids.js';
import { computeReputation, reputationWeight } from '../../../lib/reputation.js';
import { toBigInt } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { UserModel } from '../../auth/models/index.js';
import { OrderModel } from '../../checkout/models/index.js';
import { ClubPostModel } from '../../clubs/models/index.js';
import { DeedModel, DeedStatusModel } from '../../deeds/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { PlayRollupModel, PlaySessionModel } from '../models/index.js';

const TIMEOUT_MS = 5 * 60_000;
// A heartbeat credits at most this much play: gaps longer than this were not observed play.
const MAX_CREDIT_MS = 90_000;
const DECAY = 0.9;

/** Proof-of-Play: minutes come from server-observed heartbeats only, never client claims (UC-25). */
export const telemetryService = {
  async open({ apiKey, game }, { passportId, clientVersion = null }, { ipHash = null } = {}) {
    const user = await UserModel.findOne({ pid: passportId, status: 'active' }).select('_id pid').lean();
    if (!user) throw NotFound('passport_not_found');
    const now = new Date();

    // First real telemetry replaces demo numbers for both the game and the passport.
    await GameModel.updateOne({ _id: game._id, statsSource: 'seed' }, { $set: { statsSource: 'telemetry' } });
    await UserModel.updateOne({ _id: user._id, reputationSource: 'seed' }, { $set: { reputationSource: 'computed' } });
    const session = await createOpenSession({ user, game, apiKey, now, clientVersion, ipHash });
    return presentSession(session.toObject(), user);
  },

  async heartbeat({ game }, sessionPid) {
    const session = await findGameSession(game, sessionPid);
    if (session.closedAt) throw Conflict('session_closed');
    const now = Date.now();
    const last = session.lastHeartbeatAt.getTime();
    if (now - last > TIMEOUT_MS) {
      await closeAtLastHeartbeat(session);
      throw Conflict('session_closed');
    }
    const creditMs = Math.min(now - last, MAX_CREDIT_MS);
    const activeMs = (session.activeMs ?? 0) + creditMs;
    const updated = await PlaySessionModel.findOneAndUpdate(
      { _id: session._id, closedAt: null, lastHeartbeatAt: session.lastHeartbeatAt },
      { $set: { lastHeartbeatAt: new Date(now), activeMs, minutes: Math.floor(activeMs / 60_000) }, $inc: { heartbeatCount: 1 } },
      { new: true },
    ).lean();
    return presentSession(updated ?? session);
  },

  /** Client close. Any client-declared duration in the body is ignored by design. */
  async close({ game }, sessionPid) {
    const session = await findGameSession(game, sessionPid);
    if (session.closedAt) return presentSession(session);
    const updated = await PlaySessionModel.findOneAndUpdate(
      { _id: session._id, closedAt: null },
      { $set: { closedAt: session.lastHeartbeatAt, closeReason: 'client' } },
      { new: true },
    ).lean();
    return presentSession(updated ?? session);
  },

  /** Sessions silent for 5 minutes close at their last heartbeat — never at "now". */
  async sweepTimeouts() {
    const stale = await PlaySessionModel.find({ closedAt: null, lastHeartbeatAt: { $lt: new Date(Date.now() - TIMEOUT_MS) } }).limit(1000).lean();
    for (const session of stale) await closeAtLastHeartbeat(session);
    return { closed: stale.length };
  },

  /** Idempotent: each session is rolled up exactly once, inside the same transaction as its $inc. */
  async rollup({ limit = 500 } = {}) {
    const sessions = await PlaySessionModel.find({ closedAt: { $ne: null }, rolledUpAt: null }).limit(limit).lean();
    const weights = new Map(
      (await UserModel.find({ _id: { $in: sessions.map((session) => session.userId) } }).select('reputation').lean()).map((user) => [
        String(user._id),
        reputationWeight(user.reputation),
      ]),
    );
    for (const session of sessions) {
      await withTransaction(async (txn) => {
        const claimed = await PlaySessionModel.findOneAndUpdate({ _id: session._id, rolledUpAt: null }, { $set: { rolledUpAt: new Date() } }, { session: txn });
        if (!claimed) return;
        const date = session.startedAt.toISOString().slice(0, 10);
        const weight = weights.get(String(session.userId)) ?? 0;
        await PlayRollupModel.updateOne(
          { userId: session.userId, gameId: session.gameId, date },
          {
            $inc: { minutes: session.minutes ?? 0, sessions: 1, weightedMinutes: (session.minutes ?? 0) * weight },
            $set: { reputationWeight: weight },
            $setOnInsert: { pid: publicId('rol'), epoch: epochNumberAt(session.startedAt) },
          },
          { upsert: true, session: txn },
        );
      });
    }
    return { rolledUp: sessions.length };
  },

  /** Store ranking input: Σ weighted minutes over 14 days with daily decay (UC-04 §3). */
  async refreshGameStats() {
    const games = await GameModel.find({ status: { $in: ['live', 'in_review'] }, statsSource: { $ne: 'seed' } }).select('_id').lean();
    const today = new Date();
    const dayKey = (offset) => new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    for (const game of games) {
      const [live, rollups] = await Promise.all([
        PlaySessionModel.countDocuments({ gameId: game._id, closedAt: null, lastHeartbeatAt: { $gte: new Date(Date.now() - TIMEOUT_MS) } }),
        PlayRollupModel.find({ gameId: game._id, date: { $gte: dayKey(60) } }).select('userId date minutes weightedMinutes').lean(),
      ]);
      let score = 0;
      let playtime = 0;
      const dau = new Set();
      const mau = new Set();
      const firstSeen = new Map();
      const daysByUser = new Map();
      for (const row of rollups) {
        const age = Math.floor((today - new Date(`${row.date}T00:00:00Z`)) / 86_400_000);
        if (age <= 14) score += row.weightedMinutes * DECAY ** age;
        if (age <= 30) {
          playtime += row.minutes;
          mau.add(String(row.userId));
        }
        if (row.date === dayKey(0)) dau.add(String(row.userId));
        const key = String(row.userId);
        if (!firstSeen.has(key) || row.date < firstSeen.get(key)) firstSeen.set(key, row.date);
        if (!daysByUser.has(key)) daysByUser.set(key, new Set());
        daysByUser.get(key).add(row.date);
      }
      const retention = (offset) => {
        const cohort = [...firstSeen].filter(([, first]) => first <= dayKey(offset));
        if (!cohort.length) return 0;
        const returned = cohort.filter(([user, first]) => {
          const target = new Date(new Date(`${first}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10);
          return daysByUser.get(user).has(target);
        });
        return Math.round((returned.length / cohort.length) * 1000) / 1000;
      };
      await GameModel.updateOne(
        { _id: game._id },
        {
          $set: {
            'stats.playersLive': live,
            'stats.dau': dau.size,
            'stats.mau': mau.size,
            'stats.playtimeMinutes': playtime,
            'stats.proofOfPlayScore': Math.round(score * 10) / 10,
            'stats.d1': retention(1),
            'stats.d7': retention(7),
            'stats.d30': retention(30),
          },
        },
      );
    }
    return { games: games.length };
  },

  /** Hourly reputation recompute for recently active passports. */
  async refreshReputation({ sinceHours = 2, limit = 2000 } = {}) {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const users = await UserModel.find({ status: 'active', reputationSource: { $ne: 'seed' }, $or: [{ lastSeenAt: { $gte: since } }, { updatedAt: { $gte: since } }] })
      .limit(limit)
      .select('_id createdAt')
      .lean();
    for (const user of users) {
      const [minutes, spend, club, unverified] = await Promise.all([
        PlayRollupModel.aggregate([{ $match: { userId: user._id } }, { $group: { _id: null, total: { $sum: '$minutes' } } }]),
        OrderModel.aggregate([{ $match: { userId: user._id, status: 'completed', channel: { $ne: 'sandbox' } } }, { $group: { _id: null, total: { $sum: '$quote.priceUnits' } } }]),
        ClubPostModel.aggregate([{ $match: { authorUserId: user._id, status: 'visible' } }, { $group: { _id: null, reactions: { $sum: '$reactions.up' }, posts: { $sum: 1 } } }]),
        DeedModel.find({ userId: user._id }).select('_id').lean().then((deeds) => DeedStatusModel.countDocuments({ deedId: { $in: deeds.map((deed) => deed._id) }, verified: false })),
      ]);
      const inputs = {
        playtimeMinutes: minutes[0]?.total ?? 0,
        spendUnits: toBigInt(spend[0]?.total ?? 0n),
        clubScore: (club[0]?.reactions ?? 0) + (club[0]?.posts ?? 0) * 2,
        accountAgeDays: Math.floor((Date.now() - user.createdAt.getTime()) / 86_400_000),
        flags: Math.min(3, Math.floor(unverified / 5)),
      };
      await UserModel.updateOne({ _id: user._id }, { $set: { reputation: computeReputation(inputs), reputationInputs: inputs } });
    }
    return { updated: users.length };
  },
};

async function findGameSession(game, sessionPid) {
  const session = await PlaySessionModel.findOne({ pid: sessionPid, gameId: game._id }).lean();
  if (!session) throw NotFound('session_not_found');
  return session;
}

async function createOpenSession({ user, game, apiKey, now, clientVersion, ipHash }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Overlapping sessions for the same passport + game: the newest wins.
    const previous = await PlaySessionModel.find({ userId: user._id, gameId: game._id, closedAt: null }).lean();
    for (const prev of previous) {
      await PlaySessionModel.updateOne(
        { _id: prev._id, closedAt: null },
        { $set: { closedAt: prev.lastHeartbeatAt, closeReason: 'superseded' } },
      );
    }
    try {
      return await PlaySessionModel.create({
        pid: publicId('ses'),
        userId: user._id,
        gameId: game._id,
        apiKeyId: apiKey._id,
        startedAt: now,
        lastHeartbeatAt: now,
        clientVersion,
        ipHash,
      });
    } catch (error) {
      if (error?.code !== 11000 || attempt === 4) throw error;
    }
  }
}

async function closeAtLastHeartbeat(session) {
  await PlaySessionModel.updateOne({ _id: session._id, closedAt: null }, { $set: { closedAt: session.lastHeartbeatAt, closeReason: 'timeout' } });
}

function presentSession(session, user) {
  return {
    id: session.pid,
    passportId: user?.pid,
    startedAt: session.startedAt,
    lastHeartbeatAt: session.lastHeartbeatAt,
    closedAt: session.closedAt,
    closeReason: session.closeReason,
    minutes: session.minutes ?? 0,
    heartbeatCount: session.heartbeatCount ?? 0,
    heartbeatIntervalSeconds: 60,
  };
}
