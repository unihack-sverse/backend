import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/async-handler.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { idempotency } from '../../middleware/idempotency.js';
import { requireSession } from '../../middleware/session-auth.js';
import { positiveUnits, validate } from '../../middleware/validate.js';
import { interopService } from '../interop/services/interop.service.js';
import { marketService } from './services/market.service.js';

export function marketRoutes() {
  const router = Router();

  router.get(
    '/market/listings',
    validate({
      query: z.object({
        gameId: z.string().max(40).optional(),
        game: z.string().max(60).optional(),
        schemaId: z.string().max(80).optional(),
        sort: z.enum(['price_asc', 'price_desc', 'newest', 'most_deeds']).default('price_asc'),
        q: z.string().max(60).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const { data, meta } = await marketService.list({ ...req.query, gameSlug: req.query.game });
      sendCollection(res, data, meta);
    }),
  );
  router.get('/market/listings/mine', requireSession, asyncHandler(async (req, res) => sendCollection(res, await marketService.mine(req.user))));
  router.get('/market/listings/:id', asyncHandler(async (req, res) => sendData(res, await marketService.get(req.params.id))));
  router.post(
    '/market/listings',
    requireSession,
    validate({ body: z.object({ inventoryItemId: z.string().max(40), priceUnits: positiveUnits }) }),
    asyncHandler(async (req, res) => sendData(res, await marketService.create(req.user, req.body), 201)),
  );
  router.delete('/market/listings/:id', requireSession, asyncHandler(async (req, res) => sendData(res, await marketService.cancel(req.user, req.params.id))));
  router.post(
    '/market/listings/:id/buy',
    requireSession,
    idempotency({ required: false }),
    asyncHandler(async (req, res) => sendData(res, await marketService.buy(req.user, req.params.id))),
  );

  router.post(
    '/interop/imports',
    requireSession,
    validate({ body: z.object({ inventoryItemId: z.string().max(40), hostGameId: z.string().max(40), dryRun: z.boolean().default(true) }) }),
    asyncHandler(async (req, res) => sendData(res, await interopService.importItem(req.user, req.body), req.body.dryRun ? 200 : 201)),
  );
  router.get('/interop/imports', requireSession, asyncHandler(async (req, res) => sendCollection(res, await interopService.listImports(req.user))));

  return router;
}
