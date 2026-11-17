import { mailer } from '../../../adapters/mailer/console-mailer.js';
import { env } from '../../../config/env.js';
import { BadRequest, Conflict, Forbidden, NotFound, Unprocessable } from '../../../lib/errors.js';
import { eventBus } from '../../../lib/event-bus.js';
import { publicId } from '../../../lib/ids.js';
import { fromUnits, toBigInt } from '../../../lib/money.js';
import { withTransaction } from '../../../lib/transaction.js';
import { writeAudit } from '../../../lib/audit.js';
import { UserModel } from '../../auth/models/index.js';
import { clubsService } from '../../clubs/services/clubs.service.js';
import { GameModel } from '../../games/models/index.js';
import { ItemDefinitionModel } from '../../items/models/index.js';
import { AccountModel } from '../../ledger/models/index.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { StudioModel } from '../../studios/models/index.js';
import { ReviewCaseModel } from '../models/index.js';
import { ipFingerprint } from '../scanners/ip-scanner.js';
import { malwareScan } from '../scanners/malware-scanner.js';
import { contentPolicy } from '../scanners/policy-scanner.js';
import { fetchBuild } from '../scanners/safe-fetch.js';

const MISMATCH_STRIKE_THRESHOLD = 3;

export const reviewService = {
  /** UC-20 §1: submission opens a case; automated checks run in the review job. */
  async submit(studio, gamePid, { actor } = {}) {
    const game = await GameModel.findOne({ pid: gamePid, studioId: studio._id });
    if (!game) throw NotFound('game_not_found');
    if (!['draft', 'rejected'].includes(game.status)) throw Conflict('game_not_submittable');
    // RequireVerifiedEmail (04 §2) is enforced here too; the client guard is only UX.
    const owner = await UserModel.findById(studio.ownerUserId).select('emailVerified').lean();
    if (!owner?.emailVerified) throw Forbidden('email_unverified', { message: 'Verify your email before submitting a game.' });
    const activeItems = await ItemDefinitionModel.countDocuments({ gameId: game._id, status: 'active' });
    if (!game.buildUrl) throw Unprocessable('build_required');
    if (activeItems === 0 && game.tokenizationLevel !== 'L0') throw Unprocessable('catalog_required');

    game.submissionNo += 1;
    game.status = 'in_review';
    game.blockedReason = null;
    game.rejectionReason = null;
    const reviewCase = await ReviewCaseModel.create({
      pid: publicId('rvw'),
      kind: 'game_submission',
      gameId: game._id,
      studioId: studio._id,
      submissionNo: game.submissionNo,
      checks: [
        { name: 'malware_scan', status: 'pending' },
        { name: 'ip_fingerprint', status: 'pending' },
        { name: 'content_policy', status: 'pending' },
      ],
    });
    game.reviewCaseId = reviewCase._id;
    await game.save();
    if (actor) await writeAudit({ actor, action: 'game.submit', targetType: 'game', targetId: game.pid });
    eventBus.emit('game.submitted', { gameId: game.pid, studioId: studio._id, studioPid: studio.pid, submissionNo: game.submissionNo });
    return { game: game.toObject(), reviewCase: reviewCase.toObject() };
  },

  /** Review worker: automated checks, then auto-approve or escalate (UC-20 §2–3). */
  async processPending({ limit = 20 } = {}) {
    const cases = await ReviewCaseModel.find({ kind: 'game_submission', outcome: 'pending' }).sort({ createdAt: 1 }).limit(limit).lean();
    for (const reviewCase of cases) await this.runChecks(reviewCase._id);
    return { processed: cases.length };
  },

  async runChecks(caseId) {
    const reviewCase = await ReviewCaseModel.findById(caseId).lean();
    if (!reviewCase || reviewCase.outcome !== 'pending') return reviewCase;
    const game = await GameModel.findById(reviewCase.gameId).lean();
    const studio = await StudioModel.findById(reviewCase.studioId).lean();
    if (!game || game.status !== 'in_review') {
      await ReviewCaseModel.updateOne({ _id: caseId }, { $set: { outcome: 'dismissed', reason: 'game no longer in review' } });
      return null;
    }
    const build = await fetchBuild(game);
    const checks = [
      await runScanner('malware_scan', () => malwareScan(game, build)),
      await runScanner('ip_fingerprint', () => ipFingerprint(game, build)),
      await runScanner('content_policy', () => contentPolicy(game, build)),
    ];
    const flagged = checks.some((check) => check.status === 'flagged') || studio.strikes > 0;
    await ReviewCaseModel.updateOne(
      { _id: caseId, outcome: 'pending' },
      { $set: { checks, outcome: flagged ? 'escalated' : 'auto_approved', reason: studio.strikes > 0 && !checks.some((c) => c.status === 'flagged') ? 'studio has open strikes' : null } },
    );
    if (!flagged) await this.publish(game._id);
    return ReviewCaseModel.findById(caseId).lean();
  },

  /** Publishing requires a staked listing bond ≥ MIN_LISTING_BOND_UNITS (UC-20 §4). */
  async publish(gameId) {
    const game = await GameModel.findById(gameId);
    if (!game || game.status !== 'in_review') return null;
    const studio = await StudioModel.findById(game.studioId).lean();
    const bond = await AccountModel.findById(studio.bondAccountId).lean();
    if (toBigInt(bond.balanceUnits) < env.MIN_LISTING_BOND_UNITS) {
      game.blockedReason = 'bond_required';
      await game.save();
      return game.toObject();
    }
    await withTransaction(async (session) => {
      const doc = await GameModel.findById(gameId).session(session);
      doc.status = 'live';
      doc.blockedReason = null;
      doc.publishedAt ??= new Date();
      await doc.save({ session });
      await clubsService.ensureForGame(doc, session);
    });
    eventBus.emit('game.published', { gameId: game.pid, slug: game.slug, studioId: studio._id, studioPid: studio.pid });
    return GameModel.findById(gameId).lean();
  },

  /** Re-attempts publishing games that were only blocked on the bond. */
  async releaseBondBlocks(studioId) {
    const blocked = await GameModel.find({ studioId, status: 'in_review', blockedReason: 'bond_required' }).select('_id reviewCaseId').lean();
    for (const game of blocked) {
      const reviewCase = await ReviewCaseModel.findById(game.reviewCaseId).lean();
      if (['auto_approved', 'approved'].includes(reviewCase?.outcome)) await this.publish(game._id);
    }
  },

  async listCases({ outcome, kind, limit = 100 } = {}) {
    const filter = {};
    if (outcome) filter.outcome = outcome;
    if (kind) filter.kind = kind;
    const cases = await ReviewCaseModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 300)).lean();
    const [games, studios] = await Promise.all([
      GameModel.find({ _id: { $in: cases.map((row) => row.gameId).filter(Boolean) } }).select('pid slug title status blockedReason buildUrl').lean(),
      StudioModel.find({ _id: { $in: cases.map((row) => row.studioId) } }).select('pid handle strikes status').lean(),
    ]);
    const gameById = new Map(games.map((game) => [String(game._id), game]));
    const studioById = new Map(studios.map((studio) => [String(studio._id), studio]));
    return cases.map((row) => mapCase(row, gameById.get(String(row.gameId)), studioById.get(String(row.studioId))));
  },

  async approve(actor, gamePid, { reason = '', requestId } = {}) {
    const game = await GameModel.findOne({ pid: gamePid }).lean();
    if (!game || game.status !== 'in_review') throw Conflict('game_not_in_review');
    await ReviewCaseModel.updateOne(
      { _id: game.reviewCaseId },
      { $set: { outcome: 'approved', reason, reviewedBy: actor._id, reviewedAt: new Date() } },
    );
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'game.approve', targetType: 'game', targetId: game.pid, reason, requestId });
    const published = await this.publish(game._id);
    return { id: game.pid, status: published?.status, blockedReason: published?.blockedReason ?? null };
  },

  async reject(actor, gamePid, { reason, requestId }) {
    if (!reason?.trim()) throw BadRequest('reason_required');
    const game = await GameModel.findOne({ pid: gamePid });
    if (!game || !['in_review', 'live'].includes(game.status)) throw Conflict('game_not_in_review');
    game.status = 'rejected';
    game.rejectionReason = reason;
    await game.save();
    await ReviewCaseModel.updateOne({ _id: game.reviewCaseId }, { $set: { outcome: 'rejected', reason, reviewedBy: actor._id, reviewedAt: new Date() } });
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'game.reject', targetType: 'game', targetId: game.pid, reason, requestId });
    const studio = await StudioModel.findById(game.studioId).lean();
    const owner = await UserModel.findById(studio.ownerUserId).select('email').lean();
    if (owner?.email) await mailer.send({ to: owner.email, template: 'game_rejected', vars: { title: game.title, reason } });
    eventBus.emit('game.rejected', { gameId: game.pid, studioId: studio._id, studioPid: studio.pid, reason });
    return { id: game.pid, status: game.status, reason };
  },

  async delist(actor, gamePid, { reason, requestId }) {
    if (!reason?.trim()) throw BadRequest('reason_required');
    const game = await GameModel.findOne({ pid: gamePid });
    if (!game || game.status !== 'live') throw Conflict('game_not_live');
    game.status = 'delisted';
    await game.save();
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'game.delist', targetType: 'game', targetId: game.pid, reason, requestId });
    return { id: game.pid, status: game.status };
  },

  /** UC-11 §7: telemetry mismatch opens a case; repeated mismatches add a strike (UC-22 path). */
  async openDeedMismatch({ deed, note }) {
    try {
      await ReviewCaseModel.create({
        pid: publicId('rvw'),
        kind: 'deed_mismatch',
        gameId: deed.gameId,
        studioId: deed.studioId,
        subjectRef: deed.pid,
        checks: [{ name: 'telemetry_cross_check', status: 'flagged', evidence: { note, deedType: deed.deedType, detail: deed.detail } }],
        outcome: 'escalated',
        reason: note,
      });
    } catch (error) {
      if (error?.code === 11000) return;
      throw error;
    }
    const recent = await ReviewCaseModel.countDocuments({
      kind: 'deed_mismatch',
      studioId: deed.studioId,
      createdAt: { $gte: new Date(Date.now() - 7 * 86_400_000) },
    });
    if (recent > 0 && recent % MISMATCH_STRIKE_THRESHOLD === 0) {
      await StudioModel.updateOne({ _id: deed.studioId }, { $inc: { strikes: 1 } });
    }
  },

  async resolveCase(actor, casePid, { outcome, reason, requestId }) {
    if (!['upheld', 'dismissed'].includes(outcome)) throw BadRequest('invalid_outcome');
    const reviewCase = await ReviewCaseModel.findOneAndUpdate(
      { pid: casePid, kind: { $ne: 'game_submission' } },
      { $set: { outcome, reason, reviewedBy: actor._id, reviewedAt: new Date() } },
      { new: true },
    ).lean();
    if (!reviewCase) throw NotFound('case_not_found');
    if (outcome === 'dismissed') await StudioModel.updateOne({ _id: reviewCase.studioId, strikes: { $gt: 0 } }, { $inc: { strikes: -1 } });
    await writeAudit({ actor: { type: 'user', id: actor._id }, action: `case.${outcome}`, targetType: 'review_case', targetId: casePid, reason, requestId });
    return mapCase(reviewCase);
  },

  /** UC-22: slash ≤ bond into treasury; below minimum the studio is suspended and delisted. */
  async slashBond(actor, studioPid, { amountUnits, reason, caseId, requestId }) {
    if (!reason?.trim()) throw BadRequest('reason_required');
    const studio = await StudioModel.findOne({ pid: studioPid }).lean();
    if (!studio) throw NotFound('studio_not_found');
    const amount = toBigInt(amountUnits);
    const result = await withTransaction(async (session) => {
      const bond = await AccountModel.findById(studio.bondAccountId).session(session).lean();
      if (amount <= 0n || amount > toBigInt(bond.balanceUnits)) throw Unprocessable('slash_exceeds_bond');
      await ledgerService.post(
        {
          legs: [
            { accountId: studio.bondAccountId, direction: 'debit', amountUnits: amount, reason: 'bond_slash' },
            { accountId: await ledgerService.systemAccountId('treasury', session), direction: 'credit', amountUnits: amount, reason: 'bond_slash' },
          ],
          refType: 'studio',
          refId: studio._id,
          memo: `slash: ${reason}${caseId ? ` (${caseId})` : ''}`,
        },
        session,
      );
      const remaining = toBigInt(bond.balanceUnits) - amount;
      let suspended = false;
      if (remaining < env.MIN_LISTING_BOND_UNITS) {
        suspended = true;
        await StudioModel.updateOne({ _id: studio._id }, { $set: { status: 'suspended', stakedUnits: remaining } }, { session });
        const live = await GameModel.find({ studioId: studio._id, status: 'live' }).session(session);
        for (const game of live) {
          game.status = 'delisted';
          await game.save({ session });
        }
      } else {
        await StudioModel.updateOne({ _id: studio._id }, { $set: { stakedUnits: remaining } }, { session });
      }
      await writeAudit({ actor: { type: 'user', id: actor._id }, action: 'studio.slash_bond', targetType: 'studio', targetId: studio.pid, reason, after: { amountUnits: amount.toString(), suspended }, requestId }, session);
      return { remaining, suspended };
    });
    const owner = await UserModel.findById(studio.ownerUserId).select('email').lean();
    if (owner?.email) await mailer.send({ to: owner.email, template: 'bond_slashed', vars: { amount: fromUnits(amount), reason, caseId } });
    eventBus.emit('studio.bond_slashed', { studioId: studio._id, studioPid: studio.pid, amountUnits: amount.toString(), reason, caseId: caseId ?? null });
    return { studioId: studio.pid, slashedUnits: amount.toString(), remainingBondUnits: result.remaining.toString(), suspended: result.suspended };
  },
};

/** A scanner crash must never auto-approve a game: fail closed by flagging the check. */
async function runScanner(name, scan) {
  try {
    return await scan();
  } catch (error) {
    return { name, status: 'flagged', evidence: { reason: `scanner error: ${error.message}` } };
  }
}

function mapCase(row, game, studio) {
  return {
    id: row.pid,
    kind: row.kind,
    outcome: row.outcome,
    status: row.outcome === 'pending' || row.outcome === 'escalated' ? 'needs_review' : row.outcome,
    submissionNo: row.submissionNo,
    subjectRef: row.subjectRef,
    game: game ? { id: game.pid, slug: game.slug, title: game.title, status: game.status, blockedReason: game.blockedReason, buildUrl: game.buildUrl, studio: studio?.handle } : null,
    studio: studio ? { id: studio.pid, handle: studio.handle, strikes: studio.strikes, status: studio.status } : null,
    checks: (row.checks ?? []).map((check) => ({ name: check.name, status: check.status, evidence: check.evidence, detail: check.evidence?.reason ?? check.evidence?.note ?? '' })),
    reason: row.reason,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}
