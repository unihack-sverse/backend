import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { issueEntitlementToken } from '../../lib/entitlement.js';
import { Forbidden, NotFound, Unauthorized, Unprocessable } from '../../lib/errors.js';
import { verifyJwt } from '../../lib/jwt.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { apiKeyAuth, requireScope } from '../../middleware/api-key-auth.js';
import { idempotency } from '../../middleware/idempotency.js';
import { byApiKey, rateLimit } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import { UserModel } from '../auth/models/index.js';
import { intentBody } from '../checkout/routes.js';
import { checkoutService } from '../checkout/services/checkout.service.js';
import { deedsService } from '../deeds/services/deeds.service.js';
import { GameModel } from '../games/models/index.js';
import { InventoryItemModel } from '../inventory/models/index.js';
import { inventoryService, presentInventory } from '../inventory/services/inventory.service.js';
import { interopService } from '../interop/services/interop.service.js';
import { InteropEnvelopeModel } from '../interop/models/index.js';
import { ItemDefinitionModel } from '../items/models/index.js';
import { itemsService, mapItemDefinition } from '../items/services/items.service.js';
import { publishRoutes } from '../publish/routes.js';
import { telemetryService } from '../telemetry/services/telemetry.service.js';
import { ipHash } from '../auth/controllers/auth.controller.js';

export function sdkRoutes() {
  const router = Router();
  router.use(apiKeyAuth);
  router.use(rateLimit({ name: 'sdk', limit: 1200, windowMs: 60_000, key: byApiKey }));

  router.get(
    '/me',
    asyncHandler(async (req, res) =>
      sendData(res, {
        keyId: req.apiKey.pid,
        scopes: req.apiKey.scopes,
        studio: { id: req.studio.pid, handle: req.studio.handle },
        game: req.game ? { id: req.game.pid, slug: req.game.slug, title: req.game.title, status: req.game.status } : null,
        deedSignature: 'HMAC-SHA256(apiSecret, `${inventoryItemId}.${deedType}.${canonicalJson(detail)}.${nonce}`) as "sha256=<hex>"',
      }),
    ),
  );

  // ---------------------------------------------------------------- purchases (UC-07 via SDK)
  router.post(
    '/checkout/intents',
    requireScope('game'),
    requireGame,
    requirePassportGrant('purchase'),
    validate({ body: intentBody.extend({ passportId: z.string().max(40).optional() }) }),
    idempotency({ required: true }),
    asyncHandler(async (req, res) => {
      const intent = await checkoutService.createIntent(req.passport, req.body, { idempotencyKey: req.idempotencyKey, channel: 'sdk', gameScope: req.scopedGame._id });
      sendData(res, intent, 201);
    }),
  );
  router.post(
    '/checkout/intents/:id/confirm',
    requireScope('game'),
    requireGame,
    requirePassportGrant('purchase'),
    asyncHandler(async (req, res) => sendData(res, await checkoutService.confirm(req.passport, req.params.id, { scopeGameId: req.scopedGame._id }))),
  );

  // ---------------------------------------------------------------- passport reads, game-scoped
  router.get(
    '/passports/:passportId/entitlements',
    requireScope('game'),
    requireGame,
    asyncHandler(async (req, res) => {
      const user = await passportByPid(req.params.passportId);
      const entitlements = await inventoryService.entitlements(user._id, req.scopedGame._id);
      const { token, expiresAt } = issueEntitlementToken({
        passportId: user.pid,
        gameId: req.scopedGame.pid,
        entitlements: entitlements.map((row) => ({ sku: row.sku, qty: row.quantity })),
      });
      sendData(res, { passportId: user.pid, gameId: req.scopedGame.pid, entitlements, token, tokenExpiresAt: expiresAt });
    }),
  );
  router.get(
    '/passports/:passportId/inventory',
    requireScope('game'),
    requireGame,
    asyncHandler(async (req, res) => {
      const user = await passportByPid(req.params.passportId);
      // A key only ever sees its own game's items plus imports it hosts — never the full passport.
      const own = await InventoryItemModel.find({ userId: user._id, gameId: req.scopedGame._id, status: { $in: ['owned', 'listed'] } }).lean();
      const imported = await interopService.importsForHost(req.scopedGame._id, user._id);
      sendData(res, { passportId: user.pid, items: await presentInventory(own), imported });
    }),
  );
  router.get(
    '/passports/:passportId/wardrobe',
    requireScope('game'),
    requireGame,
    asyncHandler(async (req, res) => {
      const user = await passportByPid(req.params.passportId);
      const envelope = await InteropEnvelopeModel.findOne({ gameId: req.scopedGame._id, status: 'active' }).lean();
      const accepted = new Set((envelope?.accepts ?? []).filter((accept) => ['T1', 'T2', 'T3'].includes(accept.tierMax)).map((accept) => accept.schemaId));
      const equipped = await InventoryItemModel.find({ userId: user._id, equipped: true, status: 'owned', interopTier: { $in: ['T1', 'T2', 'T3'] } }).lean();
      const renderable = equipped.filter((item) => String(item.gameId) === String(req.scopedGame._id) || accepted.has(item.schemaId));
      sendData(res, {
        passportId: user.pid,
        loadout: renderable.map((item) => ({ inventoryItemId: item.pid, name: item.name, slot: item.slot, schemaId: item.schemaId, tier: 'T1', artUrl: item.artUrl, traits: pickCosmetic(item.traits) })),
      });
    }),
  );

  // ---------------------------------------------------------------- deeds (UC-11)
  router.post(
    '/items/:inventoryItemId/deeds',
    requireScope('game'),
    rateLimit({ name: 'sdk-deeds', limit: 600, windowMs: 60_000, key: byApiKey }),
    validate({
      body: z.object({
        deedType: z.string().regex(/^[a-z0-9_]{2,40}$/),
        detail: z.record(z.any()).default({}),
        nonce: z.string().min(8).max(64),
        studioSignature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
      }),
    }),
    asyncHandler(async (req, res) => {
      const before = await countDeeds(req.params.inventoryItemId);
      const deed = await deedsService.append({ apiKey: req.apiKey, studio: req.studio, game: req.game }, { inventoryItemId: req.params.inventoryItemId, ...req.body });
      const after = await countDeeds(req.params.inventoryItemId);
      sendData(res, deed, after > before ? 201 : 200);
    }),
  );

  // ---------------------------------------------------------------- telemetry (UC-25)
  router.post(
    '/sessions',
    requireScope('game'),
    requireGame,
    validate({ body: z.object({ passportId: z.string().max(40), clientVersion: z.string().max(40).optional() }) }),
    asyncHandler(async (req, res) => sendData(res, await telemetryService.open({ apiKey: req.apiKey, game: req.scopedGame }, req.body, { ipHash: ipHash(req) }), 201)),
  );
  router.post(
    '/sessions/:id/heartbeat',
    requireScope('game'),
    requireGame,
    rateLimit({ name: 'sdk-heartbeat', limit: 6000, windowMs: 60_000, key: byApiKey }),
    asyncHandler(async (req, res) => sendData(res, await telemetryService.heartbeat({ game: req.scopedGame }, req.params.id))),
  );
  router.post('/sessions/:id/close', requireScope('game'), requireGame, asyncHandler(async (req, res) => sendData(res, await telemetryService.close({ game: req.scopedGame }, req.params.id))));

  // ---------------------------------------------------------------- catalog
  router.get(
    '/items',
    requireScope('game'),
    requireGame,
    asyncHandler(async (req, res) => {
      const items = await ItemDefinitionModel.find({ gameId: req.scopedGame._id, status: 'active' }).sort({ priceUnits: 1 }).lean();
      sendCollection(res, items.map((item) => mapItemDefinition(item)));
    }),
  );
  router.post(
    '/items',
    requireScope('publish'),
    requireGame,
    asyncHandler(async (req, res) => {
      const item = await itemsService.createDefinition({ studio: req.studio, game: req.scopedGame, input: req.body ?? {} });
      sendData(res, mapItemDefinition(item), 201);
    }),
  );
  router.get('/schemas', requireScope('read'), asyncHandler(async (_req, res) => sendCollection(res, await itemsService.listSchemas())));

  // ---------------------------------------------------------------- AI agent publishing (UC-19)
  router.use(
    requireScope('publish'),
    publishRoutes({ actorOf: (req) => ({ studio: req.studio, apiKey: req.apiKey }), humanOnly: () => false }),
  );

  return router;
}

async function requireGame(req, _res, next) {
  try {
    if (req.game) {
      req.scopedGame = req.game;
      return next();
    }
    const gameId = req.query.gameId ?? req.body?.gameId ?? req.headers['x-sverse-game'];
    if (!gameId) throw Unprocessable('game_binding_required', { message: 'Bind the key to a game or pass gameId.' });
    const game = await GameModel.findOne({ pid: gameId, studioId: req.studio._id }).lean();
    if (!game) throw Forbidden('not_your_game');
    req.scopedGame = game;
    return next();
  } catch (error) {
    return next(error);
  }
}

/** Spending a passport's balance requires that player's consent grant for this game. */
function requirePassportGrant(scope) {
  return async (req, _res, next) => {
    try {
      const token = req.headers['x-sverse-passport-token'];
      const payload = token ? verifyJwt(String(token), env.ENTITLEMENT_SECRET) : null;
      if (!payload || payload.typ !== 'game_grant' || !payload.scp?.includes(scope)) throw Unauthorized('passport_grant_required');
      if (payload.gam !== req.scopedGame.pid) throw Forbidden('grant_wrong_game');
      if (req.body?.passportId && req.body.passportId !== payload.sub) throw Forbidden('grant_wrong_passport');
      const user = await UserModel.findOne({ pid: payload.sub, status: 'active' }).lean();
      if (!user) throw Unauthorized('passport_grant_required');
      req.passport = { ...user, id: user.pid };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

async function passportByPid(pid) {
  const user = await UserModel.findOne({ pid, status: { $ne: 'deleted' } }).select('_id pid').lean();
  if (!user) throw NotFound('passport_not_found');
  return user;
}

async function countDeeds(inventoryPid) {
  const item = await InventoryItemModel.findOne({ pid: inventoryPid }).select('deedCount').lean();
  return item?.deedCount ?? 0;
}

function pickCosmetic(traits = {}) {
  const allowed = ['slot', 'rarity', 'palette', 'style', 'color', 'pattern'];
  return Object.fromEntries(Object.entries(traits).filter(([key]) => allowed.includes(key)));
}
