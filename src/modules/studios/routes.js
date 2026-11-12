import { Router } from 'express';
import { z } from 'zod';

import { API_KEY_SCOPES, WEBHOOK_EVENTS } from '../../config/constants.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { requireCreator, requireSession } from '../../middleware/session-auth.js';
import { assetUrl, evmAddress, httpUrl, positiveUnits, validate } from '../../middleware/validate.js';
import { rewardsService } from '../rewards/services/rewards.service.js';
import { requireStudio, studioService } from './services/studio.service.js';
import { assertSafeUrl } from '../webhooks/services/webhooks.service.js';
import { Unprocessable } from '../../lib/errors.js';

export function studioRoutes() {
  const router = Router();

  router.post(
    '/studios',
    requireSession,
    validate({
      body: z.object({
        handle: z.string().regex(/^[a-z0-9._-]{3,30}$/i, 'handle must be 3-30 letters, digits, dot, dash or underscore'),
        displayName: z.string().min(2).max(60),
        bio: z.string().max(500).optional(),
      }),
    }),
    asyncHandler(async (req, res) => sendData(res, await studioService.create(req.user, req.body), 201)),
  );
  router.get('/studios/me', requireCreator, asyncHandler(async (req, res) => sendData(res, await studioService.getMine(req.user))));
  router.patch(
    '/studios/me',
    requireCreator,
    validate({
      body: z.object({
        displayName: z.string().min(2).max(60).optional(),
        bio: z.string().max(500).optional(),
        avatarUrl: assetUrl.optional(),
        payoutAddress: evmAddress.optional(),
        links: z.object({ site: httpUrl.or(z.literal('')).optional(), x: httpUrl.or(z.literal('')).optional(), discord: httpUrl.or(z.literal('')).optional() }).optional(),
      }),
    }),
    asyncHandler(async (req, res) => sendData(res, await studioService.updateMine(req.user, req.body))),
  );
  router.get(
    '/studios/me/analytics',
    requireCreator,
    validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }),
    asyncHandler(async (req, res) => sendData(res, await studioService.analytics(req.user, req.query))),
  );
  router.post('/studios/me/bond/stake', requireCreator, validate({ body: z.object({ amountUnits: positiveUnits }) }), asyncHandler(async (req, res) => sendData(res, await studioService.stake(req.user, req.body.amountUnits))));
  router.post('/studios/me/bond/unstake', requireCreator, validate({ body: z.object({ amountUnits: positiveUnits }) }), asyncHandler(async (req, res) => sendData(res, await studioService.unstake(req.user, req.body.amountUnits))));

  router.get('/studios/me/api-keys', requireCreator, asyncHandler(async (req, res) => sendCollection(res, await studioService.listApiKeys(req.user))));
  router.post(
    '/studios/me/api-keys',
    requireCreator,
    validate({ body: z.object({ label: z.string().max(60).optional(), scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).default(['game']), gameId: z.string().max(40).nullable().optional() }) }),
    asyncHandler(async (req, res) => sendData(res, await studioService.createApiKey(req.user, req.body), 201)),
  );
  router.delete('/studios/me/api-keys/:id', requireCreator, asyncHandler(async (req, res) => sendData(res, await studioService.revokeApiKey(req.user, req.params.id))));

  const webhookBody = z.object({ url: httpUrl, events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) });
  router.get(
    '/studios/me/webhooks',
    requireCreator,
    asyncHandler(async (req, res) => {
      const { endpoints, deliveries } = await studioService.listWebhooks(req.user);
      sendCollection(res, endpoints, { deliveries, availableEvents: WEBHOOK_EVENTS });
    }),
  );
  router.post(
    '/studios/me/webhooks',
    requireCreator,
    validate({ body: webhookBody }),
    asyncHandler(async (req, res) => {
      try {
        assertSafeUrl(req.body.url);
      } catch (error) {
        throw Unprocessable('invalid_webhook_url', { message: error.message });
      }
      sendData(res, await studioService.createWebhook(req.user, req.body), 201);
    }),
  );
  router.patch(
    '/studios/me/webhooks/:id',
    requireCreator,
    validate({ body: webhookBody.partial().extend({ status: z.enum(['active', 'disabled']).optional() }) }),
    asyncHandler(async (req, res) => sendData(res, await studioService.updateWebhook(req.user, req.params.id, req.body))),
  );
  router.delete('/studios/me/webhooks/:id', requireCreator, asyncHandler(async (req, res) => sendData(res, await studioService.deleteWebhook(req.user, req.params.id))));
  router.post(
    '/studios/me/webhooks/:id/replay/:deliveryId',
    requireCreator,
    asyncHandler(async (req, res) => sendData(res, await studioService.replayDelivery(req.user, req.params.id, req.params.deliveryId))),
  );

  router.get('/studios/me/withdrawals', requireCreator, asyncHandler(async (req, res) => sendCollection(res, await studioService.listWithdrawals(req.user))));
  router.post(
    '/studios/me/withdrawals',
    requireCreator,
    validate({ body: z.object({ amountUnits: positiveUnits, destinationAddress: evmAddress.optional() }) }),
    asyncHandler(async (req, res) => sendData(res, await studioService.withdraw(req.user, req.body), 201)),
  );
  router.get('/studios/me/rewards', requireCreator, asyncHandler(async (req, res) => sendCollection(res, await rewardsService.forStudio(await requireStudio(req.user)))));
  router.post(
    '/studios/me/rewards/:epochId/claim',
    requireCreator,
    asyncHandler(async (req, res) => {
      const studio = await requireStudio(req.user);
      sendData(res, await rewardsService.claim({ claimantType: 'studio', claimantId: studio._id, epochPid: req.params.epochId }));
    }),
  );

  return router;
}
