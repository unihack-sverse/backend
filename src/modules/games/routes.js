import { Router } from 'express';
import { z } from 'zod';

import { GENRES, INTEROP_TIERS, ITEM_KINDS, TOKENIZATION_LEVELS } from '../../config/constants.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { NotFound } from '../../lib/errors.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { byUser, rateLimit } from '../../middleware/rate-limit.js';
import { requireCreator, requireSession } from '../../middleware/session-auth.js';
import { assetUrl, httpUrl, positiveUnits, unitsString, validate } from '../../middleware/validate.js';
import { clubsService } from '../clubs/services/clubs.service.js';
import { interopService } from '../interop/services/interop.service.js';
import { ItemDefinitionModel } from '../items/models/index.js';
import { itemsService, mapItemDefinition } from '../items/services/items.service.js';
import { marketService } from '../market/services/market.service.js';
import { reviewService } from '../review/services/review.service.js';
import { requireStudio, studioService } from '../studios/services/studio.service.js';
import { GameModel } from './models/index.js';
import { gamesService, presentGames } from './services/games.service.js';

const listQuery = z.object({
  genre: z.enum(GENRES).optional(),
  interopTier: z.enum(INTEROP_TIERS).optional(),
  tokenizationLevel: z.enum(TOKENIZATION_LEVELS).optional(),
  q: z.string().max(100).optional(),
  sort: z.string().optional(),
  studio: z.string().max(40).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const gameBody = z.object({
  title: z.string().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9-]{2,48}$/).optional(),
  blurb: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  genre: z.enum(GENRES),
  buildType: z.enum(['web', 'native', 'miniapp']).optional(),
  buildUrl: httpUrl.optional().or(z.literal('')),
  tokenizationLevel: z.enum(TOKENIZATION_LEVELS).optional(),
  coverArt: z.object({ url: assetUrl.optional(), gradient: z.string().regex(/^#[0-9a-fA-F]{6}(,#[0-9a-fA-F]{6})*$/).optional(), emoji: z.string().max(8).optional() }).optional(),
  media: z.array(z.object({ url: assetUrl, kind: z.enum(['screenshot', 'video']), order: z.number().int() })).max(20).optional(),
});

const itemBody = z.object({
  sku: z.string().regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  kind: z.enum(ITEM_KINDS),
  priceUnits: positiveUnits,
  schemaId: z.string().max(80).nullable().optional(),
  interopTier: z.enum(INTEROP_TIERS).optional(),
  tokenizationLevel: z.enum(TOKENIZATION_LEVELS).optional(),
  slot: z.string().max(30).nullable().optional(),
  supplyMax: z.number().int().positive().nullable().optional(),
  traits: z.record(z.any()).optional(),
  transferable: z.boolean().optional(),
  stackable: z.boolean().optional(),
  royaltyBps: z.number().int().min(0).max(2000).optional(),
  art: z.object({ url: assetUrl.optional(), emoji: z.string().max(8).optional() }).optional(),
  status: z.enum(['draft', 'active']).optional(),
});

const mappingKey = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const finiteNumber = z.number().finite();
const numericRange = z.tuple([finiteNumber, finiteNumber]).refine(([min, max]) => min <= max, {
  message: 'range min must be <= max',
});

const mappingRuleSchema = z
  .object({
    from: mappingKey.optional(),
    passthrough: z.boolean().optional(),
    values: z.array(z.union([z.string().max(64), finiteNumber, z.boolean()])).max(50).optional(),
    curve: z.enum(['linear']).optional(),
    inRange: numericRange.optional(),
    outRange: numericRange.optional(),
    round: z.boolean().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (!rule.passthrough && !rule.outRange) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outRange'],
        message: 'outRange is required when passthrough is not true',
      });
    }
  });

const envelopeBody = z.object({
  acceptsTierMax: z.enum(INTEROP_TIERS),
  accepts: z
    .array(
      z.object({
        schemaId: z.string().max(80),
        tierMax: z.enum(INTEROP_TIERS),
        powerTierRange: z.tuple([finiteNumber, finiteNumber]).optional(),
        mapping: z
          .record(mappingKey, mappingRuleSchema)
          .refine((rules) => Object.keys(rules).length <= 32, { message: 'mapping cannot exceed 32 rules' })
          .default({}),
        clampPolicy: z.enum(['reject', 'clamp']).default('reject'),
      }),
    )
    .max(20),
  licenseRequirement: z.enum(['display_only', 'derivative', 'commercial']).default('display_only'),
  feeUnits: unitsString.default('0'),
  hostSharePct: z.number().int().min(0).max(100).default(50),
});

export function gameRoutes() {
  const router = Router();

  // ---------------------------------------------------------------- public store (UC-04…06)
  router.get(
    '/games',
    validate({ query: listQuery }),
    asyncHandler(async (req, res) => {
      const { data, meta } = await gamesService.listPublic(req.query, req.user);
      sendCollection(res, data, meta);
    }),
  );
  router.get('/games/:slug', asyncHandler(async (req, res) => sendData(res, await gamesService.detail(req.params.slug, req.user))));
  router.get('/games/:slug/items', asyncHandler(async (req, res) => sendCollection(res, await gamesService.items(req.params.slug, req.user))));
  router.get(
    '/games/:slug/listings',
    asyncHandler(async (req, res) => {
      await gamesService.getVisibleBySlug(req.params.slug, req.user);
      const { data, meta } = await marketService.list({ gameSlug: req.params.slug, sort: req.query.sort ?? 'price_asc', cursor: req.query.cursor });
      sendCollection(res, data, meta);
    }),
  );
  router.get(
    '/games/:slug/envelope',
    asyncHandler(async (req, res) => {
      const game = await gamesService.getVisibleBySlug(req.params.slug, req.user);
      sendData(res, await interopService.getEnvelopeForGame(game));
    }),
  );
  router.get(
    '/games/:slug/club/posts',
    asyncHandler(async (req, res) => {
      const game = await gamesService.getVisibleBySlug(req.params.slug, req.user);
      const { data, meta, club } = await clubsService.listPosts(game, req.user, req.query);
      sendCollection(res, data, { ...meta, club });
    }),
  );
  router.post(
    '/games/:slug/club/posts',
    requireSession,
    rateLimit({ name: 'club-post', limit: 10, windowMs: 10 * 60 * 1000, key: byUser }),
    validate({ body: z.object({ body: z.string().min(1).max(4000), channel: z.string().max(30).optional() }) }),
    asyncHandler(async (req, res) => {
      const game = await gamesService.getVisibleBySlug(req.params.slug, req.user);
      sendData(res, await clubsService.createPost(req.user, game, req.body), 201);
    }),
  );
  router.get(
    '/studios/:handle',
    // `/studios/me` belongs to the authenticated studio routes.
    (req, _res, next) => next(req.params.handle === 'me' ? 'route' : undefined),
    asyncHandler(async (req, res) => sendData(res, await studioService.getByHandle(req.params.handle))),
  );
  router.get('/schemas', asyncHandler(async (_req, res) => sendCollection(res, await itemsService.listSchemas())));

  // ---------------------------------------------------------------- studio-owned writes (UC-20…21)
  router.get('/studios/me/games', requireCreator, asyncHandler(async (req, res) => sendCollection(res, await gamesService.listStudioGames(await requireStudio(req.user)))));
  router.post(
    '/studios/me/games',
    requireCreator,
    validate({ body: gameBody }),
    asyncHandler(async (req, res) => sendData(res, await gamesService.create(await requireStudio(req.user), req.body), 201)),
  );
  router.get(
    '/games/:id/manage',
    requireCreator,
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const game = (await gamesService.findOwned(studio, req.params.id)).toObject();
      const [presented] = await presentGames([game], req.user);
      const items = await ItemDefinitionModel.find({ gameId: game._id }).sort({ createdAt: 1 }).lean();
      sendData(res, {
        ...presented,
        description: game.description,
        buildType: game.buildType,
        buildUrl: game.buildUrl,
        media: game.media,
        submissionNo: game.submissionNo,
        blockedReason: game.blockedReason,
        rejectionReason: game.rejectionReason,
        items: items.map((item) => mapItemDefinition(item)),
        envelope: await interopService.getEnvelopeForGame(game),
      });
    }),
  );
  router.patch(
    '/games/:id',
    requireCreator,
    validate({ body: gameBody.partial() }),
    asyncHandler(async (req, res) => sendData(res, await gamesService.update(await requireStudio(req.user), req.params.id, req.body))),
  );
  router.post(
    '/games/:id/submit',
    requireCreator,
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const { reviewCase } = await reviewService.submit(studio, req.params.id, { actor: { type: 'user', id: req.user._id } });
      await reviewService.runChecks(reviewCase._id);
      const game = await GameModel.findOne({ pid: req.params.id }).lean();
      sendData(res, { id: game.pid, status: game.status, blockedReason: game.blockedReason, submissionNo: game.submissionNo, reviewCaseId: reviewCase.pid });
    }),
  );
  router.post(
    '/games/:id/items',
    requireCreator,
    validate({ body: itemBody }),
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const game = await gamesService.findOwned(studio, req.params.id);
      sendData(res, mapItemDefinition(await itemsService.createDefinition({ studio, game, input: req.body })), 201);
    }),
  );
  router.post(
    '/games/:id/items/bulk',
    requireCreator,
    validate({ body: z.object({ items: z.array(z.any()).min(1).max(200) }) }),
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const game = await gamesService.findOwned(studio, req.params.id);
      const results = [];
      for (const [index, raw] of req.body.items.entries()) {
        // Rows are validated one by one so a single bad row never rejects the whole batch.
        const parsed = itemBody.safeParse(raw);
        if (!parsed.success) {
          results.push({ index, ok: false, error: { code: 'validation_failed', details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), issue: issue.message })) } });
          continue;
        }
        const input = parsed.data;
        try {
          results.push({ index, ok: true, item: mapItemDefinition(await itemsService.createDefinition({ studio, game, input })) });
        } catch (error) {
          results.push({ index, ok: false, error: { code: error.code === 11000 || error.code === 'sku_taken' ? 'sku_taken' : error.code ?? 'invalid_item', details: error.details ?? [] } });
        }
      }
      sendData(res, { created: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results }, 201);
    }),
  );
  router.patch(
    '/items/:id',
    requireCreator,
    validate({
      body: itemBody
        .pick({ name: true, description: true, priceUnits: true, tokenizationLevel: true, slot: true, supplyMax: true, traits: true, art: true })
        .partial()
        .extend({ status: z.enum(['active']).optional() }),
    }),
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const item = await itemsService.findByPid(req.params.id);
      if (String(item.studioId) !== String(studio._id)) throw NotFound('item_not_found');
      const game = await GameModel.findById(item.gameId).lean();
      sendData(res, mapItemDefinition(await itemsService.updateDefinition({ item, game, patch: req.body })));
    }),
  );
  router.post(
    '/items/:id/archive',
    requireCreator,
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const item = await itemsService.findByPid(req.params.id);
      if (String(item.studioId) !== String(studio._id)) throw NotFound('item_not_found');
      sendData(res, mapItemDefinition(await itemsService.archive(item)));
    }),
  );
  router.put(
    '/games/:id/envelope',
    requireCreator,
    validate({ body: envelopeBody }),
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      const game = await gamesService.findOwned(studio, req.params.id);
      sendData(res, await interopService.upsertEnvelope(game.toObject(), req.body));
    }),
  );

  return router;
}
