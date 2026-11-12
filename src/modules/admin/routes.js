import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../lib/async-handler.js';
import { NotFound } from '../../lib/errors.js';
import { sendCollection, sendData } from '../../lib/respond.js';
import { requireRole } from '../../middleware/session-auth.js';
import { positiveUnits, validate } from '../../middleware/validate.js';
import { JobLockModel } from '../../db/system-models.js';
import { chainAdapter } from '../../adapters/chain/index.js';
import { chainService } from '../chain/services/chain.service.js';
import { checkoutService } from '../checkout/services/checkout.service.js';
import { clubsService } from '../clubs/services/clubs.service.js';
import { GameModel } from '../games/models/index.js';
import { ReviewCaseModel } from '../review/models/index.js';
import { reviewService } from '../review/services/review.service.js';
import { rewardsService } from '../rewards/services/rewards.service.js';
import { studioService } from '../studios/services/studio.service.js';
import { adminService } from './services/admin.service.js';
import { env } from '../../config/env.js';
import { writeAudit } from '../../lib/audit.js';

const reason = z.object({ reason: z.string().trim().min(3).max(1000) });

export function adminRoutes() {
  const router = Router();
  // Non-staff get 404 on every admin route — the console's existence is not revealed (T19).
  router.use(requireRole('moderator'));
  const adminOnly = requireRole('admin');
  const actor = (req) => req.user;

  router.get('/review-cases', asyncHandler(async (req, res) => sendCollection(res, await reviewService.listCases(req.query))));
  router.post('/review-cases/:id/resolve', validate({ body: reason.extend({ outcome: z.enum(['upheld', 'dismissed']) }) }), asyncHandler(async (req, res) => sendData(res, await reviewService.resolveCase(actor(req), req.params.id, { ...req.body, requestId: req.id }))));
  router.post('/games/:id/approve', asyncHandler(async (req, res) => sendData(res, await reviewService.approve(actor(req), req.params.id, { reason: req.body?.reason ?? '', requestId: req.id }))));
  router.post('/games/:id/reject', validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await reviewService.reject(actor(req), req.params.id, { ...req.body, requestId: req.id }))));
  router.post('/games/:id/delist', validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await reviewService.delist(actor(req), req.params.id, { ...req.body, requestId: req.id }))));

  // Back-compat with the first admin console build, which addressed cases directly.
  router.get('/reviews', asyncHandler(async (req, res) => sendCollection(res, await reviewService.listCases({ kind: 'game_submission', ...req.query }))));
  router.post('/reviews/:id/approve', asyncHandler(async (req, res) => sendData(res, await reviewService.approve(actor(req), await gamePidForCase(req.params.id), { requestId: req.id }))));
  router.post('/reviews/:id/reject', validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await reviewService.reject(actor(req), await gamePidForCase(req.params.id), { ...req.body, requestId: req.id }))));

  router.get('/users', asyncHandler(async (req, res) => sendCollection(res, await adminService.users(req.query))));
  router.post('/users/:id/suspend', validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await adminService.setUserStatus(actor(req), req.params.id, { status: 'suspended', ...req.body, requestId: req.id }))));
  router.post('/users/:id/reinstate', validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await adminService.setUserStatus(actor(req), req.params.id, { status: 'active', ...req.body, requestId: req.id }))));
  router.post('/users/:id/roles', adminOnly, validate({ body: reason.extend({ roles: z.array(z.enum(['player', 'curator', 'moderator', 'admin'])) }) }), asyncHandler(async (req, res) => sendData(res, await adminService.setUserRoles(actor(req), req.params.id, { ...req.body, requestId: req.id }))));

  router.get('/studios', asyncHandler(async (req, res) => sendCollection(res, await adminService.studios(req.query), { minListingBondUnits: env.MIN_LISTING_BOND_UNITS.toString() })));
  router.post('/studios/:id/slash-bond', adminOnly, validate({ body: reason.extend({ amountUnits: positiveUnits, caseId: z.string().max(40).optional() }) }), asyncHandler(async (req, res) => sendData(res, await reviewService.slashBond(actor(req), req.params.id, { ...req.body, requestId: req.id }))));
  router.post('/studios/:id/suspend', adminOnly, validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await adminService.setStudioStatus(actor(req), req.params.id, { status: 'suspended', ...req.body, requestId: req.id }))));
  router.post('/studios/:id/reinstate', adminOnly, validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await adminService.setStudioStatus(actor(req), req.params.id, { status: 'active', ...req.body, requestId: req.id }))));
  router.post('/studios/:id/kyc-verified', adminOnly, validate({ body: reason }), asyncHandler(async (req, res) =>
    sendData(res, await studioService.markKycVerified(actor(req), req.params.id, { ...req.body, requestId: req.id })),
  ));

  router.get('/orders/:id', adminOnly, asyncHandler(async (req, res) => sendData(res, await checkoutService.adminGetOrder(req.params.id))));
  router.post('/orders/:id/refund', adminOnly, validate({ body: reason }), asyncHandler(async (req, res) => sendData(res, await checkoutService.refund({ type: 'user', id: req.user._id }, req.params.id, { ...req.body, requestId: req.id }))));

  router.get('/epochs', asyncHandler(async (_req, res) => sendCollection(res, await rewardsService.list({ limit: 52 }))));
  router.post('/epochs/:number/close', adminOnly, validate({ body: reason.extend({ force: z.boolean().default(false) }) }), asyncHandler(async (req, res) => sendData(res, await rewardsService.closeEpoch(Number(req.params.number), { actor: { type: 'user', id: req.user._id }, force: req.body.force, reason: req.body.reason }))));

  router.get('/ledger/trial-balance', adminOnly, asyncHandler(async (_req, res) => sendData(res, await adminService.trialBalance())));
  router.get('/ledger/entries', adminOnly, asyncHandler(async (req, res) => sendCollection(res, await adminService.ledger({ reason: req.query.reason, limit: Number(req.query.limit ?? 100), before: req.query.before }))));
  router.get('/ledger', adminOnly, asyncHandler(async (req, res) => sendCollection(res, await adminService.ledger({ limit: Number(req.query.limit ?? 100) }))));

  router.get('/chain/health', adminOnly, asyncHandler(async (_req, res) => sendData(res, { ...(await chainService.status()), adapterHealth: await chainAdapter().health().catch((error) => ({ ok: false, error: error.message })) })));
  router.get('/chain/ops', adminOnly, asyncHandler(async (req, res) => sendCollection(res, await chainService.listOps({ status: req.query.status, kind: req.query.kind, limit: Number(req.query.limit ?? 100) }))));
  router.get('/chain/ops/:id', adminOnly, asyncHandler(async (req, res) => sendData(res, await chainService.getOp(req.params.id))));
  router.post('/chain/ops/:id/retry', adminOnly, validate({ body: reason }), asyncHandler(async (req, res) => {
    const op = await chainService.retry(req.params.id);
    await writeAudit({ actor: { type: 'user', id: req.user._id }, action: 'chain_op.retry', targetType: 'chain_op', targetId: op.id, reason: req.body.reason, requestId: req.id });
    sendData(res, op);
  }));
  router.get('/chain/reconciliation', adminOnly, asyncHandler(async (_req, res) => sendData(res, await chainService.reconciliationReport())));

  router.get('/club/reports', asyncHandler(async (_req, res) => sendCollection(res, await clubsService.moderationQueue())));
  router.get('/audit-log', adminOnly, asyncHandler(async (req, res) => sendCollection(res, await adminService.auditLog(req.query))));
  router.get('/jobs', adminOnly, asyncHandler(async (_req, res) => sendCollection(res, (await JobLockModel.find().sort({ name: 1 }).lean()).map(({ _id, __v, ...rest }) => rest))));

  return router;
}

async function gamePidForCase(casePid) {
  const reviewCase = await ReviewCaseModel.findOne({ pid: casePid }).lean();
  if (!reviewCase?.gameId) throw NotFound('case_not_found');
  return (await GameModel.findById(reviewCase.gameId).select('pid').lean()).pid;
}
