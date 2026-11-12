import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/async-handler.js';
import { sendData } from '../../lib/respond.js';
import { idempotency } from '../../middleware/idempotency.js';
import { byUser, rateLimit } from '../../middleware/rate-limit.js';
import { requireSession } from '../../middleware/session-auth.js';
import { httpUrl, validate } from '../../middleware/validate.js';
import { isCorsOriginAllowed } from '../../config/env.js';
import { checkoutService } from './services/checkout.service.js';

export const intentBody = z.object({
  itemDefinitionId: z.string().regex(/^itd_[0-9A-Za-z_-]{3,40}$/),
  quantity: z.number().int().min(1).max(10).default(1),
  paymentMethod: z.enum(['srv_balance', 'fiat_onramp']).default('srv_balance'),
});

export function checkoutRoutes() {
  const router = Router();
  const limit = rateLimit({ name: 'checkout', limit: 30, windowMs: 60_000, key: byUser });

  router.post(
    '/checkout/intents',
    requireSession,
    limit,
    validate({ body: intentBody }),
    idempotency({ required: true }),
    asyncHandler(async (req, res) => sendData(res, await checkoutService.createIntent(req.user, req.body, { idempotencyKey: req.idempotencyKey }), 201)),
  );
  const confirm = asyncHandler(async (req, res) => sendData(res, await checkoutService.confirm(req.user, req.params.id)));
  router.post('/checkout/intents/:id/confirm', requireSession, limit, idempotency({ required: false }), confirm);
  // Back-compat path used by the first Store build.
  router.post('/checkout/:id/confirm', requireSession, limit, confirm);
  router.post('/checkout/intents/:id/cancel', requireSession, asyncHandler(async (req, res) => sendData(res, await checkoutService.cancel(req.user, req.params.id))));
  router.post(
    '/checkout/fiat-sessions',
    requireSession,
    limit,
    validate({
      body: z.object({
        orderId: z.string().max(40),
        // Only our own web origins may receive the on-ramp redirect (no open redirect).
        returnUrl: httpUrl.refine((value) => isCorsOriginAllowed(new URL(value).origin), 'must be a Sverse origin').optional(),
      }),
    }),
    asyncHandler(async (req, res) => sendData(res, await checkoutService.createFiatSession(req.user, req.body), 201)),
  );
  router.get('/orders/:id', requireSession, asyncHandler(async (req, res) => sendData(res, await checkoutService.getOrder(req.user, req.params.id))));

  return router;
}
