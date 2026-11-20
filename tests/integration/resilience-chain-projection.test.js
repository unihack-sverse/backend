import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import '../helpers.js';
import { eventBus } from '../../src/lib/event-bus.js';
import { ChainOpModel } from '../../src/modules/chain/models/index.js';
import { chainService } from '../../src/modules/chain/services/chain.service.js';

describe('resilience: chain projection retry', () => {
  it('records projectionStatus=failed on handler error and retries idempotently via reconcileSubmitted', async () => {
    let calls = 0;
    let confirmedEvents = 0;
    eventBus.on('chain.confirmed', () => {
      confirmedEvents += 1;
    });

    chainService.registerHandler('register_studio', {
      async onCompleted() {
        calls += 1;
        if (calls === 1) throw new Error('transient_projection_error');
      },
      async onFailed() {},
    });

    const refId = new mongoose.Types.ObjectId();
    const op = await chainService.enqueue({
      kind: 'register_studio',
      ref: `test-proj:${refId.toString()}`,
      refType: 'studio',
      refId,
      payload: { handle: 'projtest', owner: '0x0000000000000000000000000000000000000001' },
    });

    await chainService.dispatchDue();
    await new Promise((r) => setTimeout(r, 20));

    const afterFail = await ChainOpModel.findById(op._id).lean();
    expect(afterFail.status).toBe('completed');
    expect(afterFail.projectionStatus).toBe('failed');
    expect(afterFail.projectionError).toContain('transient_projection_error');
    expect(calls).toBe(1);
    // chain.confirmed must not be emitted until projection succeeds.
    expect(confirmedEvents).toBe(0);

    // Public API mapping must not leak internal projection fields.
    const publicOp = await chainService.getOp(op.pid);
    expect(publicOp.projectionStatus).toBeUndefined();
    expect(publicOp.projectionError).toBeUndefined();

    const firstReconcile = await chainService.reconcileSubmitted();
    expect(firstReconcile.reconciled).toBeGreaterThanOrEqual(1);

    const afterRetry = await ChainOpModel.findById(op._id).lean();
    expect(afterRetry.projectionStatus).toBe('done');
    expect(afterRetry.projectionError).toBeNull();
    expect(calls).toBe(2);
    // Emitted exactly once after retryProjection succeeds.
    expect(confirmedEvents).toBe(1);

    // Second reconcile is a no-op for already-done projections.
    await chainService.reconcileSubmitted();
    expect(calls).toBe(2);
    expect(confirmedEvents).toBe(1);
  });

  it('detects and recovers stale pending projections in reconciliationReport and reconcileSubmitted without touching fresh pending ones', async () => {
    const completedRefs = [];
    const confirmedOpIds = [];
    let listening = true;
    eventBus.on('chain.confirmed', ({ opId }) => {
      if (listening) confirmedOpIds.push(opId);
    });

    chainService.registerHandler('register_studio', {
      async onCompleted(op) {
        completedRefs.push(op.ref);
      },
      async onFailed() {},
    });

    const staleRefId = new mongoose.Types.ObjectId();
    const freshRefId = new mongoose.Types.ObjectId();
    const failedRefId = new mongoose.Types.ObjectId();

    const staleOp = await ChainOpModel.create({
      pid: `cop_stale_proj_${Date.now()}`,
      kind: 'register_studio',
      adapter: 'mock',
      ref: `test-stale-proj:${staleRefId.toString()}`,
      refType: 'studio',
      refId: staleRefId,
      payload: { handle: 'staleproj' },
      status: 'completed',
      txHash: `0x${'a'.repeat(64)}`,
      projectionStatus: 'pending',
      completedAt: new Date(Date.now() - 5 * 60_000),
    });

    const freshOp = await ChainOpModel.create({
      pid: `cop_fresh_proj_${Date.now()}`,
      kind: 'register_studio',
      adapter: 'mock',
      ref: `test-fresh-proj:${freshRefId.toString()}`,
      refType: 'studio',
      refId: freshRefId,
      payload: { handle: 'freshproj' },
      status: 'completed',
      txHash: `0x${'b'.repeat(64)}`,
      projectionStatus: 'pending',
      completedAt: new Date(),
    });

    const failedOp = await ChainOpModel.create({
      pid: `cop_failed_proj_${Date.now()}`,
      kind: 'register_studio',
      adapter: 'mock',
      ref: `test-failed-proj:${failedRefId.toString()}`,
      refType: 'studio',
      refId: failedRefId,
      payload: { handle: 'failedproj' },
      status: 'completed',
      txHash: `0x${'c'.repeat(64)}`,
      projectionStatus: 'failed',
      projectionError: 'boom',
      completedAt: new Date(),
    });

    try {
      // Backdate updatedAt on staleOp directly in MongoDB to simulate a crash mid-projection.
      await ChainOpModel.collection.updateOne(
        { _id: staleOp._id },
        { $set: { updatedAt: new Date(Date.now() - 5 * 60_000) } },
      );

      const beforeReport = await chainService.reconciliationReport();
      expect(beforeReport.healthy).toBe(false);
      expect(beforeReport.projectionCounts).toEqual({ failed: 1, stalePending: 1 });
      expect(beforeReport.failedProjections.map((o) => o.id)).toContain(failedOp.pid);
      expect(beforeReport.stalePendingProjections.map((o) => o.id)).toContain(staleOp.pid);
      expect(beforeReport.stalePendingProjections.map((o) => o.id)).not.toContain(freshOp.pid);

      // Custom stalePendingMs override controls staleness cutoff.
      const relaxedReport = await chainService.reconciliationReport({ stalePendingMs: 10 * 60_000 });
      expect(relaxedReport.projectionCounts).toEqual({ failed: 1, stalePending: 0 });
      expect(relaxedReport.stalePendingProjections).toEqual([]);

      // Reconcile recovers staleOp and failedOp, but does NOT touch freshOp.
      const res = await chainService.reconcileSubmitted();
      expect(res.reconciled).toBeGreaterThanOrEqual(2);

      const [staleAfter, failedAfter, freshAfter] = await Promise.all([
        ChainOpModel.findById(staleOp._id).lean(),
        ChainOpModel.findById(failedOp._id).lean(),
        ChainOpModel.findById(freshOp._id).lean(),
      ]);

      expect(staleAfter.projectionStatus).toBe('done');
      expect(staleAfter.projectionError).toBeNull();
      expect(failedAfter.projectionStatus).toBe('done');
      expect(freshAfter.projectionStatus).toBe('pending');

      expect(completedRefs).toContain(staleOp.ref);
      expect(completedRefs).toContain(failedOp.ref);
      expect(completedRefs).not.toContain(freshOp.ref);
      expect(confirmedOpIds.filter((id) => id === staleOp.pid)).toHaveLength(1);
      expect(confirmedOpIds.filter((id) => id === freshOp.pid)).toHaveLength(0);

      // Report is healthy again once failed and stale pending projections are resolved.
      const afterReport = await chainService.reconciliationReport();
      expect(afterReport.healthy).toBe(true);
      expect(afterReport.projectionCounts).toEqual({ failed: 0, stalePending: 0 });
      expect(afterReport.failedProjections).toEqual([]);
      expect(afterReport.stalePendingProjections).toEqual([]);

      // Second reconcile does not re-emit or re-run staleOp, and still skips freshOp.
      await chainService.reconcileSubmitted();
      expect(completedRefs.filter((ref) => ref === staleOp.ref)).toHaveLength(1);
      expect(confirmedOpIds.filter((id) => id === staleOp.pid)).toHaveLength(1);
      expect(completedRefs).not.toContain(freshOp.ref);
    } finally {
      listening = false;
      await ChainOpModel.deleteMany({ _id: { $in: [staleOp._id, freshOp._id, failedOp._id] } });
    }
  });
});
