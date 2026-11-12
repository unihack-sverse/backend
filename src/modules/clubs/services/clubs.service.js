import { Forbidden, NotFound, Conflict } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { decodeCursor, encodeCursor, parseLimit } from '../../../lib/pagination.js';
import { reputationWeight } from '../../../lib/reputation.js';
import { writeAudit } from '../../../lib/audit.js';
import { UserModel } from '../../auth/models/index.js';
import { GameModel } from '../../games/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { ClubModel, ClubPostModel, ClubReactionModel } from '../models/index.js';

export const clubsService = {
  async ensureForGame(game, session) {
    const existing = await ClubModel.findOne({ gameId: game._id }).session(session ?? null).lean();
    if (existing) return existing;
    const [club] = await ClubModel.create(
      [{ pid: publicId('clb'), gameId: game._id, studioId: game.studioId, name: `${game.title} Club` }],
      { session },
    );
    await GameModel.updateOne({ _id: game._id }, { $set: { clubId: club._id } }, { session });
    return club.toObject();
  },

  async listPosts(game, viewer, { channel, sort = 'ranked', cursor, limit } = {}) {
    const club = await ClubModel.findOne({ gameId: game._id }).lean();
    if (!club) return { data: [], meta: { nextCursor: null, hasMore: false, count: 0 }, club: null };
    const size = parseLimit(limit, { fallback: 30, max: 100 });
    // Low-weight posts are returned like any other; only moderation changes visibility.
    const filter = { clubId: club._id, parentId: null, status: 'visible' };
    if (channel) filter.channel = channel;
    const offset = decodeCursor(cursor)?.offset ?? 0;
    const order = sort === 'new' ? { createdAt: -1, _id: -1 } : { score: -1, _id: -1 };
    const rows = await ClubPostModel.find(filter).sort(order).skip(offset).limit(size + 1).lean();
    const page = rows.slice(0, size);
    return {
      data: await presentPosts(page, viewer),
      meta: { nextCursor: rows.length > size ? encodeCursor({ offset: offset + size }) : null, hasMore: rows.length > size, count: page.length },
      club: await presentClub(club, game, viewer),
    };
  },

  async replies(postPid, viewer) {
    const parent = await ClubPostModel.findOne({ pid: postPid, status: { $ne: 'removed' } }).lean();
    if (!parent) throw NotFound('post_not_found');
    const rows = await ClubPostModel.find({ parentId: parent._id, status: 'visible' }).sort({ createdAt: 1 }).limit(200).lean();
    return presentPosts(rows, viewer);
  },

  /** UC-15: the ownership gate, a reputation snapshot, and reputation-weighted ranking. */
  async createPost(user, game, { body, channel = 'general' }) {
    const club = await this.ensureForGame(game);
    await assertCanPost(user, club, game);
    const post = await insertPost({ club, game, user, body, channel, kind: 'post' });
    await ClubModel.updateOne({ _id: club._id }, { $inc: { 'counters.posts': 1 } });
    const [presented] = await presentPosts([post], user);
    return presented;
  },

  async reply(user, postPid, { body }) {
    const parent = await ClubPostModel.findOne({ pid: postPid, status: 'visible' }).lean();
    if (!parent) throw NotFound('post_not_found');
    const club = await ClubModel.findById(parent.clubId).lean();
    const game = await GameModel.findById(parent.gameId).lean();
    await assertCanPost(user, club, game);
    const post = await insertPost({ club, game, user, body, channel: parent.channel, kind: 'reply', parentId: parent._id });
    await ClubPostModel.updateOne({ _id: parent._id }, { $inc: { replyCount: 1 } });
    const [presented] = await presentPosts([post], user);
    return presented;
  },

  async react(user, postPid, kind) {
    const post = await ClubPostModel.findOne({ pid: postPid, status: 'visible' }).lean();
    if (!post) throw NotFound('post_not_found');
    try {
      await ClubReactionModel.create({ postId: post._id, userId: user._id, kind });
    } catch (error) {
      if (error?.code === 11000) throw Conflict('already_reacted');
      throw error;
    }
    const updated = await ClubPostModel.findOneAndUpdate({ _id: post._id }, { $inc: { [`reactions.${kind}`]: 1 } }, { new: true }).lean();
    await ClubPostModel.updateOne({ _id: post._id }, { $set: { score: rankScore(updated) } });
    const [presented] = await presentPosts([{ ...updated, score: rankScore(updated) }], user);
    return presented;
  },

  async report(user, postPid, reason) {
    const post = await ClubPostModel.findOne({ pid: postPid, status: { $ne: 'removed' } }).lean();
    if (!post) throw NotFound('post_not_found');
    try {
      await ClubReactionModel.create({ postId: post._id, userId: user._id, kind: 'report', reason });
    } catch (error) {
      if (error?.code === 11000) return { reported: true };
      throw error;
    }
    await ClubPostModel.updateOne({ _id: post._id }, { $inc: { reportCount: 1 } });
    return { reported: true };
  },

  async edit(user, postPid, { body }) {
    const post = await ClubPostModel.findOne({ pid: postPid, status: { $ne: 'removed' } }).lean();
    if (!post) throw NotFound('post_not_found');
    if (String(post.authorUserId) !== String(user._id) && !isStaff(user)) throw Forbidden('not_post_author');
    const updated = await ClubPostModel.findOneAndUpdate({ _id: post._id }, { $set: { body: sanitize(body) } }, { new: true }).lean();
    const [presented] = await presentPosts([updated], user);
    return presented;
  },

  /** UC-17: soft delete with an audit row; the post persists for appeal. */
  async moderate(actor, postPid, { status, reason, requestId }) {
    const post = await ClubPostModel.findOne({ pid: postPid }).lean();
    if (!post) throw NotFound('post_not_found');
    const isAuthor = String(post.authorUserId) === String(actor._id);
    const ownsGame = actor.studio && (await GameModel.exists({ _id: post.gameId, studioId: actor.studio._id }));
    if (!isStaff(actor) && !ownsGame && !(isAuthor && status === 'removed')) throw Forbidden('not_moderator');
    const updated = await ClubPostModel.findOneAndUpdate(
      { _id: post._id },
      { $set: { status, moderatedBy: actor._id, moderationReason: reason ?? null } },
      { new: true },
    ).lean();
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: `club_post.${status}`, targetType: 'club_post', targetId: post.pid, reason: reason ?? '', before: { status: post.status }, after: { status }, requestId });
    return { id: updated.pid, status: updated.status, moderationReason: updated.moderationReason };
  },

  async moderationQueue({ limit = 100 } = {}) {
    const rows = await ClubPostModel.find({ status: { $ne: 'removed' }, reportCount: { $gt: 0 } }).sort({ reportCount: -1 }).limit(limit).lean();
    const presented = await presentPosts(rows, { roles: ['moderator'] });
    const reports = await ClubReactionModel.find({ postId: { $in: rows.map((row) => row._id) }, kind: 'report' }).sort({ createdAt: -1 }).lean();
    const games = await GameModel.find({ _id: { $in: rows.map((row) => row.gameId) } }).select('pid slug title').lean();
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    return presented.map((post, index) => {
      const game = gameById.get(String(rows[index].gameId));
      return {
        ...post,
        game: game ? { id: game.pid, slug: game.slug, title: game.title } : null,
        reports: reports.filter((row) => String(row.postId) === String(rows[index]._id)).slice(0, 20).map((row) => ({ reason: row.reason, createdAt: row.createdAt })),
      };
    });
  },

  /** UC-16: player achievement becomes community content; deduplicated per deed. */
  async autoPostDeed({ deedObjectId, gameObjectId, itemName, deedType, detail }) {
    const game = await GameModel.findById(gameObjectId).lean();
    if (!game) return null;
    const club = await this.ensureForGame(game);
    const summary = Object.entries(detail ?? {})
      .slice(0, 4)
      .map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`)
      .join(' · ');
    try {
      const post = await insertPost({
        club,
        game,
        user: null,
        body: `${itemName} — ${deedType.replaceAll('_', ' ')}${summary ? ` (${summary})` : ''}`,
        channel: 'general',
        kind: 'deed_auto',
        deedId: deedObjectId,
      });
      await ClubModel.updateOne({ _id: club._id }, { $inc: { 'counters.posts': 1 } });
      return post;
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  },
};

async function assertCanPost(user, club, game) {
  if (user.status === 'suspended') throw Forbidden('account_suspended');
  if (isStaff(user) || (user.studio && String(user.studio._id) === String(game.studioId))) return;
  if ((club.gates?.minReputation ?? 0) > (user.reputation ?? 0)) throw Forbidden('gate_not_met');
  if (!club.gates?.postRequiresOwnership) return;
  const qualifying = club.gates.qualifyingItemDefinitionIds ?? [];
  const owns = await InventoryItemModel.exists({
    userId: user._id,
    gameId: game._id,
    status: { $in: ['owned', 'listed'] },
    ...(qualifying.length ? { itemDefinitionId: { $in: qualifying } } : {}),
  });
  if (!owns) throw Forbidden('gate_not_met', { message: 'Own this game or one of its items to post.' });
}

async function insertPost({ club, game, user, body, channel, kind, parentId = null, deedId = null }) {
  const rep = user?.reputation ?? 0;
  const weight = kind === 'deed_auto' ? 0.6 : reputationWeight(rep);
  const badges = [];
  if (user?.studio && String(user.studio._id) === String(game.studioId)) badges.push('studio');
  if (kind === 'deed_auto') badges.push('auto');
  if (user && (user.reputation ?? 0) >= 70) badges.push('curator');
  const now = new Date();
  const [post] = await ClubPostModel.create([
    {
      pid: publicId('pst'),
      clubId: club._id,
      gameId: game._id,
      channel,
      authorUserId: user?._id ?? null,
      authorHandle: user?.handle ?? null,
      kind,
      parentId,
      body: sanitize(body),
      badges,
      repAtPost: rep,
      weight,
      score: rankScore({ weight, reactions: { up: 0, insightful: 0 }, createdAt: now }),
      deedId,
      createdAt: now,
    },
  ]);
  return post.toObject();
}

/** Time-invariant hot score: reputation weight + reactions, with recency built in (no refresh job). */
export function rankScore(post) {
  const reactions = (post.reactions?.up ?? 0) + 2 * (post.reactions?.insightful ?? 0);
  const seconds = new Date(post.createdAt ?? Date.now()).getTime() / 1000;
  return Math.round((post.weight * 2 + Math.log10(1 + reactions * Math.max(post.weight, 0.05)) + seconds / 45000) * 1e4) / 1e4;
}

async function presentPosts(posts, viewer) {
  if (!posts.length) return [];
  const authorIds = posts.map((post) => post.authorUserId).filter(Boolean);
  const [authors, reacted] = await Promise.all([
    UserModel.find({ _id: { $in: authorIds } }).select('pid handle handleRaw reputation').lean(),
    viewer?._id ? ClubReactionModel.find({ userId: viewer._id, postId: { $in: posts.map((post) => post._id) } }).lean() : [],
  ]);
  const authorById = new Map(authors.map((author) => [String(author._id), author]));
  const reactedByPost = new Map();
  for (const row of reacted) {
    const key = String(row.postId);
    reactedByPost.set(key, [...(reactedByPost.get(key) ?? []), row.kind]);
  }
  return posts.map((post) => {
    const author = authorById.get(String(post.authorUserId));
    return {
      id: post.pid,
      kind: post.kind,
      channel: post.channel,
      parentId: null,
      body: post.body,
      badges: post.badges,
      repAtPost: post.repAtPost,
      weight: post.weight,
      lowSignal: post.weight < 0.2,
      score: post.score,
      reactions: post.reactions,
      replyCount: post.replyCount,
      reportCount: viewer && isStaff(viewer) ? post.reportCount : undefined,
      status: post.status,
      author: author
        ? { id: author.pid, handle: author.handle, reputation: author.reputation }
        : { id: null, handle: post.kind === 'deed_auto' ? 'sverse' : post.authorHandle ?? 'unknown', reputation: post.repAtPost },
      viewerReactions: reactedByPost.get(String(post._id)) ?? [],
      createdAt: post.createdAt,
    };
  });
}

async function presentClub(club, game, viewer) {
  let canPost = false;
  if (viewer) {
    try {
      await assertCanPost(viewer, club, game);
      canPost = true;
    } catch {
      canPost = false;
    }
  }
  return {
    id: club.pid,
    name: club.name,
    memberCount: club.counters?.members ?? 0,
    postCount: club.counters?.posts ?? 0,
    postRequiresOwnership: club.gates?.postRequiresOwnership ?? true,
    channels: club.channels,
    canPost,
  };
}

function isStaff(user) {
  return user?.roles?.some((role) => role === 'moderator' || role === 'admin');
}

function sanitize(body) {
  return String(body ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, 4000);
}

eventBus.on('item.evolved', (payload) => clubsService.autoPostDeed(payload));
