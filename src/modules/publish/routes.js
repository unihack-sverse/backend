import { Router } from 'express';
import { z } from 'zod';

import { GENRES, PUBLISH_STEPS } from '../../config/constants.js';
import { asyncHandler } from '../../lib/async-handler.js';
import { Forbidden } from '../../lib/errors.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { validate } from '../../middleware/validate.js';
import { publishService } from './services/publish.service.js';

/**
 * Shared by `/api/v1` (creator session) and `/sdk/v1` (API key with `publish` scope).
 * `actorOf(req)` normalizes both into `{ studio, user?, apiKey? }`.
 */
export function publishRoutes({ actorOf, humanOnly }) {
  const router = Router();

  router.get('/publish/jobs', asyncHandler(async (req, res) => sendCollection(res, await publishService.listJobs(actorOf(req)))));
  router.post(
    '/publish/jobs',
    validate({ body: z.object({ mode: z.enum(['ai', 'manual']).default('ai'), gameId: z.string().max(40).optional(), title: z.string().min(2).max(80).optional(), genre: z.enum(GENRES).optional() }) }),
    asyncHandler(async (req, res) => sendData(res, await publishService.createJob(actorOf(req), req.body), 201)),
  );
  router.get('/publish/jobs/:id', asyncHandler(async (req, res) => sendData(res, await publishService.getJob(actorOf(req), req.params.id))));
  router.post(
    '/publish/jobs/:id/steps/:step',
    validate({ params: z.object({ id: z.string().max(40), step: z.enum(PUBLISH_STEPS) }) }),
    asyncHandler(async (req, res) => sendData(res, await publishService.runStep(actorOf(req), req.params.id, req.params.step, req.body))),
  );
  router.post(
    '/publish/jobs/:id/approve-catalog',
    asyncHandler(async (req, res) => {
      if (!humanOnly(req)) throw Forbidden('human_approval_required');
      sendData(res, await publishService.approveCatalog(actorOf(req), req.params.id, req.body ?? {}));
    }),
  );
  router.post('/publish/jobs/:id/run-agent', asyncHandler(async (req, res) => sendData(res, await publishService.runReferenceAgent(actorOf(req), req.params.id))));

  return router;
}
