import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { INTEROP_TIERS, ITEM_KINDS } from '../../config/constants.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { signJwt } from '../../lib/jwt.js';
import { NotFound } from '../../lib/errors.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { requireSession } from '../../middleware/session-auth.js';
import { validate } from '../../middleware/validate.js';
import { updateHandleSchema } from '../auth/schemas/auth.schema.js';
import { checkoutService } from '../checkout/services/checkout.service.js';
import { deedsService } from '../deeds/services/deeds.service.js';
import { GameModel } from '../games/models/index.js';
import { inventoryService } from '../inventory/services/inventory.service.js';
import { rewardsService } from '../rewards/services/rewards.service.js';
import { passportService } from './services/passport.service.js';

export const GAME_GRANT_TTL_SECONDS = 30 * 24 * 3600;

export function passportRoutes() {
  const router = Router();

  router.get('/passport/me', requireSession, asyncHandler(async (req, res) => sendData(res, await passportService.me(req.user._id))));
  router.patch(
    '/passport/me/handle',
    requireSession,
    validate(updateHandleSchema),
    asyncHandler(async (req, res) => sendData(res, await passportService.updateHandle(req.user._id, req.body.handle))),
  );
  router.get(
    '/passport/me/inventory',
    requireSession,
    validate({
      query: z.object({
        kind: z.enum(ITEM_KINDS).optional(),
        gameId: z.string().max(40).optional(),
        interopTier: z.enum(INTEROP_TIERS).optional(),
        living: z.enum(['true', 'false']).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { items, meta } = await inventoryService.list(req.user, req.query);
      sendCollection(res, items, meta);
    }),
  );
  router.get('/passport/me/wardrobe', requireSession, asyncHandler(async (req, res) => sendData(res, await inventoryService.wardrobe(req.user))));
  router.patch(
    '/passport/me/wardrobe',
    requireSession,
    validate({ body: z.object({ equip: z.array(z.string().max(40)).max(20).default([]), unequip: z.array(z.string().max(40)).max(50).default([]) }) }),
    asyncHandler(async (req, res) => sendData(res, await inventoryService.updateWardrobe(req.user, req.body))),
  );
  router.get('/passport/me/deeds', requireSession, asyncHandler(async (req, res) => sendCollection(res, await deedsService.listForUser(req.user))));
  router.get('/passport/me/balance', requireSession, asyncHandler(async (req, res) => sendData(res, await passportService.balance(req.user))));
  router.post('/passport/me/faucet', requireSession, asyncHandler(async (req, res) => sendData(res, await passportService.faucet(req.user))));
  router.get('/passport/me/orders', requireSession, asyncHandler(async (req, res) => sendCollection(res, await checkoutService.listOrders(req.user))));
  router.get('/passport/me/rewards', requireSession, asyncHandler(async (req, res) => sendData(res, await rewardsService.forUser(req.user))));
  router.post(
    '/passport/me/rewards/:epochId/claim',
    requireSession,
    asyncHandler(async (req, res) => sendData(res, await rewardsService.claim({ claimantType: 'user', claimantId: req.user._id, epochPid: req.params.epochId }))),
  );
  // "Connect S-Passport": a player-consented grant a game uses to act for this passport via the SDK.
  router.post(
    '/passport/me/game-grants',
    requireSession,
    validate({ body: z.object({ gameId: z.string().max(40), scopes: z.array(z.enum(['purchase', 'read'])).default(['purchase', 'read']) }) }),
    asyncHandler(async (req, res) => {
      const game = await GameModel.findOne({ pid: req.body.gameId, status: 'live' }).select('pid title').lean();
      if (!game) throw NotFound('game_not_found');
      const token = signJwt({ typ: 'game_grant', sub: req.user.pid, gam: game.pid, scp: req.body.scopes }, env.ENTITLEMENT_SECRET, GAME_GRANT_TTL_SECONDS);
      sendData(res, { passportId: req.user.pid, gameId: game.pid, scopes: req.body.scopes, token, expiresAt: new Date(Date.now() + GAME_GRANT_TTL_SECONDS * 1000) }, 201);
    }),
  );
  router.get('/items/:inventoryItemId/deeds', asyncHandler(async (req, res) => sendCollection(res, await deedsService.listForItem(req.params.inventoryItemId, req.user))));

  return router;
}
