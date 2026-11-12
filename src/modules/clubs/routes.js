import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/async-handler.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { byUser, rateLimit } from '../../middleware/rate-limit.js';
import { requireSession } from '../../middleware/session-auth.js';
import { validate } from '../../middleware/validate.js';
import { clubsService } from './services/clubs.service.js';

export function clubRoutes() {
  const router = Router();
  const postLimit = rateLimit({ name: 'club-post', limit: 10, windowMs: 10 * 60 * 1000, key: byUser });
  const body = z.object({ body: z.string().min(1).max(4000) });

  router.get('/club/posts/:id/replies', asyncHandler(async (req, res) => sendCollection(res, await clubsService.replies(req.params.id, req.user))));
  router.post('/club/posts/:id/replies', requireSession, postLimit, validate({ body }), asyncHandler(async (req, res) => sendData(res, await clubsService.reply(req.user, req.params.id, req.body), 201)));
  router.post(
    '/club/posts/:id/react',
    requireSession,
    validate({ body: z.object({ kind: z.enum(['up', 'insightful']).default('up') }) }),
    asyncHandler(async (req, res) => sendData(res, await clubsService.react(req.user, req.params.id, req.body.kind))),
  );
  router.post(
    '/club/posts/:id/report',
    requireSession,
    validate({ body: z.object({ reason: z.string().min(3).max(500) }) }),
    asyncHandler(async (req, res) => sendData(res, await clubsService.report(req.user, req.params.id, req.body.reason))),
  );
  router.patch(
    '/club/posts/:id',
    requireSession,
    validate({ body: body.partial().extend({ status: z.enum(['visible', 'hidden', 'removed']).optional(), reason: z.string().max(500).optional() }) }),
    asyncHandler(async (req, res) => {
      if (req.body.status) return sendData(res, await clubsService.moderate(req.user, req.params.id, { ...req.body, requestId: req.id }));
      return sendData(res, await clubsService.edit(req.user, req.params.id, req.body));
    }),
  );
  router.delete(
    '/club/posts/:id',
    requireSession,
    asyncHandler(async (req, res) => sendData(res, await clubsService.moderate(req.user, req.params.id, { status: 'removed', reason: req.query.reason ?? 'removed', requestId: req.id }))),
  );

  return router;
}
