import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

import '../src/db/register-models.js';
import { connectDatabase, disconnectDatabase, ensureIndexes } from '../src/db/connection.js';
import { PlaySessionModel } from '../src/modules/telemetry/models/play-session.model.js';

/**
 * Pre-flight deduplication for open PlaySessions followed by Mongoose index sync across all
 * registered models. Defaults to dry-run; pass `--apply` to write changes and run `syncIndexes()`.
 *
 *   node scripts/sync-indexes.js            # dry run (default): reports duplicates, writes nothing
 *   node scripts/sync-indexes.js --dry-run  # explicit dry run (takes precedence over --apply)
 *   node scripts/sync-indexes.js --apply    # closes duplicate open sessions, then syncs indexes
 */
export function parseSyncIndexesArgs(argv = process.argv.slice(2)) {
  const hasDryRun = argv.includes('--dry-run');
  const hasApply = argv.includes('--apply');
  const dryRun = hasDryRun || !hasApply;
  return { dryRun, apply: !dryRun };
}

export async function deduplicateOpenPlaySessions({ dryRun = true } = {}) {
  const groups = await PlaySessionModel.aggregate([
    { $match: { closedAt: null } },
    { $group: { _id: { userId: '$userId', gameId: '$gameId' }, count: { $sum: 1 } } },
    { $match: { count: { $gte: 2 } } },
  ]);

  let affectedSessions = 0;
  let closedSessions = 0;

  for (const group of groups) {
    const openSessions = await PlaySessionModel.find({
      userId: group._id.userId,
      gameId: group._id.gameId,
      closedAt: null,
    })
      .sort({ lastHeartbeatAt: -1, startedAt: -1, _id: -1 })
      .select('_id lastHeartbeatAt startedAt')
      .lean();

    if (openSessions.length < 2) continue;
    const [, ...stale] = openSessions;
    affectedSessions += stale.length;

    if (!dryRun) {
      for (const doc of stale) {
        const closedAt = doc.lastHeartbeatAt ?? doc.startedAt ?? new Date();
        const res = await PlaySessionModel.updateOne(
          { _id: doc._id, closedAt: null },
          { $set: { closedAt, closeReason: 'superseded' } },
        );
        closedSessions += res.modifiedCount;
      }
    }
  }

  return {
    dryRun: Boolean(dryRun),
    duplicateGroups: groups.length,
    affectedSessions,
    closedSessions,
  };
}

export async function runSyncIndexes({ apply = false, dryRun, connect = false, uri } = {}) {
  const effectiveDryRun = dryRun === true || !apply;
  if (connect) {
    await connectDatabase({ ...(uri ? { uri } : {}), syncIndexes: false });
  }
  try {
    const deduplication = await deduplicateOpenPlaySessions({ dryRun: effectiveDryRun });
    const modelNames = Object.keys(mongoose.models).sort();
    let indexesSynced = false;

    if (!effectiveDryRun) {
      await ensureIndexes();
      indexesSynced = true;
    }

    const summary = {
      mode: effectiveDryRun ? 'dry-run' : 'apply',
      duplicateGroups: deduplication.duplicateGroups,
      affectedSessions: deduplication.affectedSessions,
      closedSessions: deduplication.closedSessions,
      indexesSynced,
      modelCount: modelNames.length,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    if (connect) {
      await disconnectDatabase();
    }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const { apply, dryRun } = parseSyncIndexesArgs(process.argv.slice(2));
  runSyncIndexes({ apply, dryRun, connect: true }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
