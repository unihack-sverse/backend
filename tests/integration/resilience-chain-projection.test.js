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
});
