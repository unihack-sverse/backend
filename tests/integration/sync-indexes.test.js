import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { parseSyncIndexesArgs, runSyncIndexes } from '../../scripts/sync-indexes.js';
import { publicId } from '../../src/lib/ids.js';
import { PlaySessionModel } from '../../src/modules/telemetry/models/play-session.model.js';

describe('scripts/sync-indexes', () => {
  it('defaults to dry-run and gives --dry-run precedence over --apply', () => {
    expect(parseSyncIndexesArgs([])).toEqual({ dryRun: true, apply: false });
    expect(parseSyncIndexesArgs(['--dry-run'])).toEqual({ dryRun: true, apply: false });
    expect(parseSyncIndexesArgs(['--apply'])).toEqual({ dryRun: false, apply: true });
    expect(parseSyncIndexesArgs(['--apply', '--dry-run'])).toEqual({ dryRun: true, apply: false });
  });

  it('reports duplicates without modifying DB on dry-run, then deduplicates and enforces partial unique index on --apply', async () => {
    // Drop the partial unique index so we can seed legacy duplicate open sessions.
    const indexes = await PlaySessionModel.collection.indexes();
    const partialUnique = indexes.find((idx) => idx.unique && idx.partialFilterExpression?.closedAt === null);
    if (partialUnique) {
      await PlaySessionModel.collection.dropIndex(partialUnique.name);
    }

    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();
    const userC = new mongoose.Types.ObjectId();
    const game1 = new mongoose.Types.ObjectId();

    const t1 = new Date('2026-01-01T10:00:00.000Z');
    const t2 = new Date('2026-01-01T10:05:00.000Z');
    const t3 = new Date('2026-01-01T10:10:00.000Z');

    // Pair (userA, game1): 3 open sessions -> keep newest (a3), close a1 & a2.
    const [a1, a2, a3] = await PlaySessionModel.collection.insertMany([
      { pid: publicId('ses'), userId: userA, gameId: game1, startedAt: t1, lastHeartbeatAt: t1, closedAt: null, closeReason: null },
      { pid: publicId('ses'), userId: userA, gameId: game1, startedAt: t1, lastHeartbeatAt: t2, closedAt: null, closeReason: null },
      { pid: publicId('ses'), userId: userA, gameId: game1, startedAt: t2, lastHeartbeatAt: t3, closedAt: null, closeReason: null },
    ]).then((res) => Object.values(res.insertedIds));

    // Pair (userB, game1): 2 open sessions with same lastHeartbeatAt, different startedAt -> keep b2, close b1.
    const [b1, b2] = await PlaySessionModel.collection.insertMany([
      { pid: publicId('ses'), userId: userB, gameId: game1, startedAt: t1, lastHeartbeatAt: t2, closedAt: null, closeReason: null },
      { pid: publicId('ses'), userId: userB, gameId: game1, startedAt: t2, lastHeartbeatAt: t2, closedAt: null, closeReason: null },
    ]).then((res) => Object.values(res.insertedIds));

    // Pair (userC, game1): 1 open session + 1 already-closed session -> untouched.
    const [cOpen, cClosed] = await PlaySessionModel.collection.insertMany([
      { pid: publicId('ses'), userId: userC, gameId: game1, startedAt: t1, lastHeartbeatAt: t2, closedAt: null, closeReason: null },
      { pid: publicId('ses'), userId: userC, gameId: game1, startedAt: t1, lastHeartbeatAt: t1, closedAt: t1, closeReason: 'client' },
    ]).then((res) => Object.values(res.insertedIds));

    // 1. Default dry-run and explicit dry-run (even with apply: true) must NOT touch the DB.
    const drySummary = await runSyncIndexes({ apply: true, dryRun: true });
    expect(drySummary.mode).toBe('dry-run');
    expect(drySummary.duplicateGroups).toBe(2);
    expect(drySummary.affectedSessions).toBe(3);
    expect(drySummary.closedSessions).toBe(0);
    expect(drySummary.indexesSynced).toBe(false);

    const openAfterDry = await PlaySessionModel.countDocuments({ closedAt: null });
    expect(openAfterDry).toBe(6);

    // 2. Apply deduplicates open sessions and syncs indexes cleanly.
    const applySummary = await runSyncIndexes({ apply: true });
    expect(applySummary.mode).toBe('apply');
    expect(applySummary.duplicateGroups).toBe(2);
    expect(applySummary.affectedSessions).toBe(3);
    expect(applySummary.closedSessions).toBe(3);
    expect(applySummary.indexesSynced).toBe(true);

    const byId = new Map(
      (await PlaySessionModel.find({ _id: { $in: [a1, a2, a3, b1, b2, cOpen, cClosed] } }).lean()).map((d) => [String(d._id), d]),
    );

    expect(byId.get(String(a3)).closedAt).toBeNull();
    expect(byId.get(String(a1)).closedAt).toEqual(t1);
    expect(byId.get(String(a1)).closeReason).toBe('superseded');
    expect(byId.get(String(a2)).closedAt).toEqual(t2);
    expect(byId.get(String(a2)).closeReason).toBe('superseded');

    expect(byId.get(String(b2)).closedAt).toBeNull();
    expect(byId.get(String(b1)).closedAt).toEqual(t2);
    expect(byId.get(String(b1)).closeReason).toBe('superseded');

    expect(byId.get(String(cOpen)).closedAt).toBeNull();
    expect(byId.get(String(cClosed)).closeReason).toBe('client');

    // 3. Re-synced partial unique index now rejects a duplicate open session with 11000.
    await expect(
      PlaySessionModel.create({
        pid: publicId('ses'),
        userId: userA,
        gameId: game1,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        closedAt: null,
      }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});
