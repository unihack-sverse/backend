import { hostname } from 'node:os';

import { JobLockModel } from '../db/system-models.js';
import { ulid } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { chainService } from '../modules/chain/services/chain.service.js';
import { checkoutService } from '../modules/checkout/services/checkout.service.js';
import { deedsService } from '../modules/deeds/services/deeds.service.js';
import { reviewService } from '../modules/review/services/review.service.js';
import { rewardsService } from '../modules/rewards/services/rewards.service.js';
import { telemetryService } from '../modules/telemetry/services/telemetry.service.js';
import { webhooksService } from '../modules/webhooks/services/webhooks.service.js';

/**
 * Background jobs (01 §6). Each job holds a Mongo lease while it runs so several API/worker
 * processes can run the scheduler without double work; every job body is idempotent anyway.
 */
export const JOBS = [
  { name: 'chain-dispatch', everyMs: 2_000, run: () => chainService.dispatchDue() },
  { name: 'chain-reconcile', everyMs: 10_000, run: () => chainService.reconcileSubmitted() },
  { name: 'chain-index', everyMs: 6_000, run: () => chainService.indexEvents() },
  { name: 'webhooks', everyMs: 5_000, run: () => webhooksService.deliverDue() },
  { name: 'review', everyMs: 5_000, run: () => reviewService.processPending() },
  { name: 'deed-verify', everyMs: 10_000, run: () => deedsService.verifyPending() },
  { name: 'telemetry-sweep', everyMs: 60_000, run: () => telemetryService.sweepTimeouts() },
  { name: 'telemetry-rollup', everyMs: 15 * 60_000, run: () => telemetryService.rollup() },
  { name: 'stats-refresh', everyMs: 5 * 60_000, run: () => telemetryService.refreshGameStats() },
  { name: 'reputation', everyMs: 60 * 60_000, run: () => telemetryService.refreshReputation() },
  { name: 'orders-sweep', everyMs: 60_000, run: () => checkoutService.sweepExpired() },
  { name: 'dispute-unlock', everyMs: 60 * 60_000, run: () => checkoutService.releaseDisputeLocks() },
  { name: 'epoch-close', everyMs: 15 * 60_000, run: () => rewardsService.closeDueEpochs() },
];

export function startScheduler({ jobs = JOBS } = {}) {
  const owner = `${hostname()}:${process.pid}:${ulid().slice(-6)}`;
  const timers = [];
  let stopped = false;

  for (const job of jobs) {
    const tick = async () => {
      if (stopped) return;
      const started = Date.now();
      const lease = await acquire(job, owner);
      if (lease) {
        if (job.name === 'chain-dispatch') chainService.setLeader(true);
        try {
          const result = await job.run();
          await JobLockModel.updateOne({ name: job.name, owner }, { $set: { lastRunAt: new Date(), lastError: null, lastDurationMs: Date.now() - started } });
          if (result && Object.values(result).some((value) => typeof value === 'number' && value > 0)) logger.debug({ job: job.name, result }, 'job_ran');
        } catch (error) {
          logger.error({ err: error, job: job.name }, 'job_failed');
          await JobLockModel.updateOne({ name: job.name, owner }, { $set: { lastError: String(error?.message ?? error).slice(0, 500) } });
        } finally {
          await JobLockModel.updateOne({ name: job.name, owner }, { $set: { lockedUntil: new Date(Date.now() + Math.min(job.everyMs, 30_000)) } }).catch(() => {});
        }
      } else if (job.name === 'chain-dispatch') {
        chainService.setLeader(false);
      }
      if (!stopped) timers.push(setTimeout(tick, job.everyMs));
    };
    timers.push(setTimeout(tick, 500 + Math.floor(Math.random() * 500)));
  }

  return {
    owner,
    stop() {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      chainService.setLeader(false);
    },
  };
}

async function acquire(job, owner) {
  const now = new Date();
  try {
    const lock = await JobLockModel.findOneAndUpdate(
      { name: job.name, $or: [{ lockedUntil: { $lt: now } }, { owner }] },
      { $set: { owner, lockedUntil: new Date(now.getTime() + Math.max(job.everyMs * 3, 60_000)) } },
      { upsert: true, new: true },
    ).lean();
    return lock?.owner === owner;
  } catch (error) {
    // Duplicate key on upsert means another process holds the lease.
    if (error?.code === 11000) return false;
    throw error;
  }
}
