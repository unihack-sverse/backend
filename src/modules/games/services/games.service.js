import { GENRES, INTEROP_TIERS, TOKENIZATION_LEVELS, levelIndex } from '../../../config/constants.js';
import { BadRequest, Conflict, NotFound, Unprocessable } from '../../../lib/errors.js';
import { publicId, toObjectId } from '../../../lib/ids.js';
import { publicAsset } from '../../../lib/assets.js';
import { decodeCursor, encodeCursor, parseLimit } from '../../../lib/pagination.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { ClubModel } from '../../clubs/models/index.js';
import { InventoryItemModel } from '../../inventory/models/index.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { mapItemDefinition } from '../../items/services/items.service.js';
import { ListingModel } from '../../market/models/index.js';
import { StudioModel } from '../../studios/models/index.js';
import { presentStats } from '../../studios/services/studio.service.js';
import { GameModel } from '../models/index.js';

const SORTS = {
  proof_of_play: { field: 'stats.proofOfPlayScore', dir: -1 },
  newest: { field: 'publishedAt', dir: -1 },
  price_asc: { field: 'priceFromUnits', dir: 1 },
  price_desc: { field: 'priceFromUnits', dir: -1 },
};

export const gamesService = {
  /** UC-04. Ranking never uses downloads or views — only weighted verified playtime. */
  async listPublic(filters = {}, viewer = null) {
    const sortKey = filters.sort ?? 'proof_of_play';
    const sort = SORTS[sortKey];
    if (!sort) throw BadRequest('invalid_sort');
    const limit = parseLimit(filters.limit, { fallback: 24, max: 100 });

    const query = { status: 'live' };
    if (filters.genre) query.genre = filters.genre;
    if (filters.interopTier) query.interopTier = filters.interopTier;
    if (filters.tokenizationLevel) query.tokenizationLevel = filters.tokenizationLevel;
    if (filters.studio) {
      const studio = await StudioModel.findOne({ handle: String(filters.studio).toLowerCase() }).select('_id').lean();
      query.studioId = studio?._id ?? null;
    }

    const cursor = decodeCursor(filters.cursor);
    let rows;
    let nextCursor;
    if (filters.q) {
      query.$text = { $search: String(filters.q).slice(0, 100) };
      const offset = cursor?.offset ?? 0;
      rows = await GameModel.find(query, { score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' }, _id: -1 })
        .skip(offset)
        .limit(limit + 1)
        .lean();
      nextCursor = rows.length > limit ? encodeCursor({ offset: offset + limit }) : null;
    } else {
      if (cursor) {
        const value = sort.field === 'priceFromUnits' ? BigInt(cursor.v) : sort.field === 'publishedAt' ? new Date(cursor.v) : cursor.v;
        const op = sort.dir === -1 ? '$lt' : '$gt';
        query.$or = [{ [sort.field]: { [op]: value } }, { [sort.field]: value, _id: { $lt: toObjectId(cursor.id) } }];
      }
      rows = await GameModel.find(query).sort({ [sort.field]: sort.dir, _id: -1 }).limit(limit + 1).lean();
      const last = rows.length > limit ? rows[limit - 1] : null;
      nextCursor = last ? encodeCursor({ v: cursorValue(last, sort.field), id: String(last._id) }) : null;
    }
    const page = rows.slice(0, limit);

    // UC-04 §4: the owner's unpublished games are prepended on the first page.
    let mine = [];
    if (!cursor && viewer?.studio?._id) {
      mine = await GameModel.find({ studioId: viewer.studio._id, status: { $ne: 'live' } }).sort({ updatedAt: -1 }).lean();
    }
    const data = await presentGames([...mine, ...page], viewer);
    return { data, meta: { nextCursor, hasMore: Boolean(nextCursor), count: data.length } };
  },

  /** UC-05. Unpublished games 404 for strangers — never 403, never leak existence. */
  async getVisibleBySlug(slug, viewer) {
    const game = await GameModel.findOne({ slug }).lean();
    if (!game || !canSee(game, viewer)) throw NotFound('game_not_found');
    return game;
  },

  async detail(slug, viewer) {
    const game = await this.getVisibleBySlug(slug, viewer);
    const [summary] = await presentGames([game], viewer);
    const [club, secondaryCount, studio] = await Promise.all([
      game.clubId ? ClubModel.findById(game.clubId).lean() : null,
      ListingModel.countDocuments({ gameId: game._id, status: 'open' }),
      StudioModel.findById(game.studioId).lean(),
    ]);
    return {
      ...summary,
      description: game.description,
      media: (game.media ?? []).map(publicAsset),
      buildType: game.buildType,
      buildUrl: game.buildUrl,
      club: club
        ? { id: club.pid, memberCount: club.counters?.members ?? 0, postCount: club.counters?.posts ?? 0, postRequiresOwnership: club.gates?.postRequiresOwnership ?? true }
        : null,
      secondaryCount,
      publishedAt: game.publishedAt,
      submissionNo: game.submissionNo,
      blockedReason: game.blockedReason,
      rejectionReason: viewer && isOwner(game, viewer) ? game.rejectionReason : undefined,
      studio: { ...summary.studio, displayName: studio?.displayName, bio: studio?.bio },
    };
  },

  async items(slug, viewer) {
    const game = await this.getVisibleBySlug(slug, viewer);
    const items = await ItemDefinitionModel.find({ gameId: game._id, status: 'active' }).sort({ priceUnits: 1, createdAt: 1 }).lean();
    const owned = viewer
      ? new Set(
          (
            await InventoryItemModel.find({ userId: viewer._id, gameId: game._id, status: { $in: ['owned', 'listed'] } })
              .select('itemDefinitionId')
              .lean()
          ).map((row) => String(row.itemDefinitionId)),
        )
      : new Set();
    return items.map((item) => mapItemDefinition(item, { owned: owned.has(String(item._id)) }));
  },

  async listStudioGames(studio) {
    const games = await GameModel.find({ studioId: studio._id }).sort({ updatedAt: -1 }).lean();
    return presentGames(games, { studio });
  },

  async findOwned(studio, gamePid) {
    const game = await GameModel.findOne({ pid: gamePid, studioId: studio._id });
    if (!game) throw NotFound('game_not_found');
    return game;
  },

  async create(studio, input) {
    const slug = await uniqueSlug(input.slug ?? input.title);
    const game = await GameModel.create({
      pid: publicId('gam'),
      slug,
      studioId: studio._id,
      title: input.title,
      blurb: input.blurb ?? '',
      description: input.description ?? '',
      genre: input.genre,
      coverArt: { url: input.coverArt?.url ?? '', gradient: input.coverArt?.gradient ?? '#7b2ff7,#e935c1', emoji: input.coverArt?.emoji ?? '🎮' },
      buildType: input.buildType ?? 'web',
      buildUrl: input.buildUrl ?? '',
      tokenizationLevel: input.tokenizationLevel ?? 'L2',
      interopTier: input.interopTier ?? 'T0',
    });
    await StudioModel.updateOne({ _id: studio._id }, { $inc: { 'counters.games': 1 } });
    const [presented] = await presentGames([game.toObject()], { studio });
    return presented;
  },

  /** UC-21: tokenization only rises; slug is immutable once published. */
  async update(studio, gamePid, patch) {
    const game = await this.findOwned(studio, gamePid);
    if (patch.tokenizationLevel !== undefined && levelIndex(patch.tokenizationLevel) < levelIndex(game.tokenizationLevel)) {
      throw Unprocessable('level_downgrade_forbidden', {
        message: `Game is at ${game.tokenizationLevel}; cannot move to ${patch.tokenizationLevel}. Ownership is not revocable.`,
      });
    }
    if (patch.slug !== undefined && patch.slug !== game.slug) {
      if (game.publishedAt) throw Unprocessable('slug_immutable');
      game.slug = await uniqueSlug(patch.slug);
    }
    for (const field of ['title', 'blurb', 'description', 'genre', 'buildType', 'buildUrl', 'tokenizationLevel']) {
      if (patch[field] !== undefined) game[field] = patch[field];
    }
    if (patch.coverArt) game.coverArt = { ...(game.coverArt?.toObject?.() ?? game.coverArt), ...patch.coverArt };
    if (patch.media) game.media = patch.media;
    await game.save();
    const [presented] = await presentGames([game.toObject()], { studio });
    return presented;
  },

  validateEnums(input) {
    if (input.genre && !GENRES.includes(input.genre)) throw BadRequest('invalid_genre');
    if (input.tokenizationLevel && !TOKENIZATION_LEVELS.includes(input.tokenizationLevel)) throw BadRequest('invalid_level');
    if (input.interopTier && !INTEROP_TIERS.includes(input.interopTier)) throw BadRequest('invalid_tier');
  },

  async ensureSlugAvailable(slug) {
    if (await GameModel.exists({ slug })) throw Conflict('slug_taken');
  },
};

export async function presentGames(games, viewer = null) {
  if (!games.length) return [];
  const studios = await StudioModel.find({ _id: { $in: [...new Set(games.map((game) => String(game.studioId)))] } })
    .select('pid handle displayName oneHumanStudio avatarUrl genesis')
    .lean();
  const studioById = new Map(studios.map((studio) => [String(studio._id), studio]));
  const viewerStudioId = viewer?.studio?._id ? String(viewer.studio._id) : null;
  return games.map((game) => mapGameSummary(game, studioById.get(String(game.studioId)), viewerStudioId));
}

export function mapGameSummary(game, studio, viewerStudioId = null) {
  return {
    id: game.pid,
    slug: game.slug,
    title: game.title,
    blurb: game.blurb,
    genre: game.genre,
    studio: studio
      ? {
          id: studio.pid,
          handle: studio.handle,
          displayName: studio.displayName,
          oneHumanStudio: studio.oneHumanStudio,
          genesis: studio.genesis,
          avatarUrl: publicAsset({ url: studio.avatarUrl })?.url ?? '',
        }
      : null,
    coverArt: publicAsset(game.coverArt),
    interopTier: game.interopTier,
    tokenizationLevel: game.tokenizationLevel,
    stats: presentStats(game.stats),
    statsSource: game.statsSource ?? 'telemetry',
    priceFromUnits: toBigInt(game.priceFromUnits).toString(),
    priceFromSrv: fromUnits(game.priceFromUnits ?? 0n),
    status: game.status,
    mine: Boolean(viewerStudioId && String(game.studioId) === viewerStudioId),
    publishedAt: game.publishedAt,
  };
}

export function canSee(game, viewer) {
  if (game.status === 'live') return true;
  if (!viewer) return false;
  return isOwner(game, viewer) || viewer.roles?.some((role) => role === 'moderator' || role === 'admin');
}

function isOwner(game, viewer) {
  return Boolean(viewer?.studio?._id && String(viewer.studio._id) === String(game.studioId));
}

function cursorValue(game, field) {
  if (field === 'priceFromUnits') return toBigInt(game.priceFromUnits).toString();
  if (field === 'publishedAt') return game.publishedAt?.toISOString() ?? null;
  return game.stats?.proofOfPlayScore ?? 0;
}

async function uniqueSlug(value) {
  const base =
    String(value ?? 'game')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'game';
  let slug = base;
  for (let i = 2; await GameModel.exists({ slug }); i += 1) slug = `${base}-${i}`;
  return slug;
}
