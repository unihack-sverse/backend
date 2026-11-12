import express, { Router } from 'express';

import { onrampAdapter } from '../../adapters/onramp/mock-onramp-adapter.js';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { Forbidden, Unauthorized } from '../../lib/errors.js';
import { sendData } from '../../lib/respond.js';
import { checkoutService } from '../checkout/services/checkout.service.js';

/** Inbound partner webhooks. Mounted before express.json so signatures cover the raw body. */
export function hookRoutes() {
  const router = Router();
  router.post(
    '/onramp',
    express.raw({ type: '*/*', limit: '256kb' }),
    asyncHandler(async (req, res) => {
      const rawBody = req.body?.toString('utf8') ?? '';
      if (!onrampAdapter().verifyWebhook({ rawBody, signature: req.headers['x-onramp-signature'] })) throw Unauthorized('bad_signature');
      const event = JSON.parse(rawBody);
      sendData(res, await checkoutService.completeFiatSession({ sessionId: event.sessionId, status: event.status }));
    }),
  );
  // Development helper that plays the partner's role for the mock on-ramp.
  router.post(
    '/onramp/simulate',
    express.json(),
    asyncHandler(async (req, res) => {
      if (env.NODE_ENV === 'production') throw Forbidden('not_available');
      sendData(res, await checkoutService.completeFiatSession({ sessionId: req.body.sessionId, status: req.body.status ?? 'succeeded' }));
    }),
  );
  return router;
}
