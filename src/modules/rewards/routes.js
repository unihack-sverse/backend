import { Router } from 'express';

import { asyncHandler } from '../../lib/async-handler.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { rewardsService } from './services/rewards.service.js';

export function rewardsRoutes() {
  const router = Router();
  router.get('/rewards/epochs', asyncHandler(async (_req, res) => sendCollection(res, await rewardsService.list())));
  router.get('/rewards/epochs/current', asyncHandler(async (_req, res) => sendData(res, await rewardsService.current())));
  router.get('/rewards/epochs/:number', asyncHandler(async (req, res) => sendData(res, await rewardsService.byNumber(Number(req.params.number)))));
  return router;
}
