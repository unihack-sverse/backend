import { chainAdapter } from '../../../adapters/chain/index.js';
import { env } from '../../../config/env.js';
import { chainRef } from '../../../adapters/chain/refs.js';
import { eventBus } from '../../../lib/event-bus.js';
import { NotFound, Conflict } from '../../../lib/errors.js';
import { publicId } from '../../../lib/ids.js';
import { logger } from '../../../lib/logger.js';
import { ChainCursorModel, ChainEventModel, ChainOpModel } from '../models/index.js';

const MAX_ATTEMPTS = 8;
const LOCK_MS = 120_000;
export const PROJECTION_STALE_MS = 2 * 60_000;
const DROPPED_GRACE_MS = env.CHAIN_DROPPED_GRACE_MS;
const handlers = new Map();
let queue = Promise.resolve();
let leader = false;

/**
 * Chain outbox. Business transactions call `enqueue` inside their Mongo session; nothing ever
 * waits on a chain receipt while a transaction is open (README "Backend integration").
 */
export const chainService = {
  /** Owners register what happens when their op completes or permanently fails. */
  registerHandler(kind, { onCompleted, onFailed }) {
    handlers.set(kind, { onCompleted, onFailed });
  },

  async enqueue({ kind, ref, refType, refId, payload, dependsOn = null }, session) {
    const existing = await ChainOpModel.findOne({ ref }).session(session ?? null);
    if (existing) return existing;
    const [op] = await ChainOpModel.create(
      [
        {
          pid: publicId('cop'),
          kind,
          adapter: chainAdapter().name,
          ref,
          refType,
          refId,
          payload,
          dependsOn,
          result: { refHash: chainRef(ref) },
        },
      ],
      { session },
    );
    return op;
  },

  /** Marks this process as the dispatcher leader (set by the scheduler's lease). */
  setLeader(value) {
    leader = value;
  },

  /**
   * Opportunistically process an op right after its business transaction commits, waiting at
   * most `waitMs` so the response can carry a tx hash when the chain is fast.
   */
  async kick(opId, { waitMs = 1500 } = {}) {
    if (!opId || !leader) return null;
    const work = serial(() => processOp(opId));
    const timeout = new Promise((resolve) => setTimeout(resolve, waitMs, null));
    await Promise.race([work.catch(() => null), timeout]);
    return ChainOpModel.findById(opId).lean();
  },

  async dispatchDue({ limit = 25 } = {}) {
    const due = await ChainOpModel.find({
      status: 'created',
      nextAttemptAt: { $lte: new Date() },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }],
    })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    let processed = 0;
    for (const { _id } of due) {
      await serial(() => processOp(_id));
      processed += 1;
    }
    return { processed };
  },

  async reconcileSubmitted({ limit = 50, stalePendingMs = PROJECTION_STALE_MS } = {}) {
    const submitted = await ChainOpModel.find({ status: { $in: ['submitted', 'chain_confirmed'] } })
      .sort({ submittedAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    let reconciled = 0;
    for (const { _id } of submitted) {
      await serial(() => reconcileOp(_id));
      reconciled += 1;
    }
    const staleBefore = new Date(Date.now() - stalePendingMs);
    const pendingProjections = await ChainOpModel.find({
      status: 'completed',
      $or: [
        { projectionStatus: 'failed' },
        { projectionStatus: 'pending', updatedAt: { $lte: staleBefore } },
      ],
    })
      .sort({ completedAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    for (const { _id } of pendingProjections) {
      const retried = await serial(() => retryProjection(_id, { stalePendingMs }));
      if (retried) reconciled += 1;
    }
    return { reconciled };
  },

  /** Scans contract logs in chunks (catching up quickly after downtime) and reconciles matching ops. */
  async indexEvents({ maxRange = env.AVALANCHE_LOG_CHUNK, maxChunks = 10 } = {}) {
    const adapter = chainAdapter();
    if (adapter.name !== 'avalanche') return { indexed: 0 };
    const key = `index:${adapter.chainId}`;
    const safe = await adapter.latestSafeBlock();
    let indexed = 0;
    let fromBlock;
    let toBlock;
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
      const cursor = await ChainCursorModel.findOne({ key }).lean();
      fromBlock = cursor ? cursor.blockNumber + 1 : adapter.deployment.startBlock;
      if (fromBlock > safe) break;
      toBlock = Math.min(safe, fromBlock + maxRange - 1);
      const events = await adapter.fetchLogs(fromBlock, toBlock);
      if (events.length) {
        await ChainEventModel.insertMany(
          events.map((event) => ({ ...event, chainId: adapter.chainId })),
          { ordered: false },
        ).catch((error) => {
          if (error?.code !== 11000 && !error?.writeErrors?.every((e) => e.code === 11000)) throw error;
        });
        const hashes = [...new Set(events.map((event) => event.txHash))];
        const ops = await ChainOpModel.find({ txHash: { $in: hashes }, status: { $in: ['submitted', 'chain_confirmed'] } })
          .select('_id')
          .lean();
        for (const { _id } of ops) await serial(() => reconcileOp(_id));
        indexed += events.length;
      }
      await ChainCursorModel.updateOne({ key }, { $set: { blockNumber: toBlock } }, { upsert: true });
    }
    return { indexed, fromBlock, toBlock, head: safe };
  },

  async retry(opPid) {
    const op = await ChainOpModel.findOneAndUpdate(
      { pid: opPid, status: 'failed' },
      { $set: { status: 'created', nextAttemptAt: new Date(), lastError: null, lockedUntil: null }, $inc: { attempts: 0 } },
      { new: true },
    );
    if (!op) {
      if (!(await ChainOpModel.exists({ pid: opPid }))) throw NotFound('op_not_found');
      throw Conflict('op_not_retryable');
    }
    return mapOp(op.toObject());
  },

  async listOps({ status, kind, limit = 100 } = {}) {
    const filter = {};
    if (status) filter.status = status;
    if (kind) filter.kind = kind;
    const ops = await ChainOpModel.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).lean();
    return ops.map(mapOp);
  },

  async getOpById(opId) {
    return ChainOpModel.findById(opId).lean();
  },

  async getOp(opPid) {
    const op = await ChainOpModel.findOne({ pid: opPid }).lean();
    if (!op) throw NotFound();
    return mapOp(op);
  },

  async status() {
    const adapter = chainAdapter();
    const [counts, cursor, lastEvent] = await Promise.all([
      ChainOpModel.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ChainCursorModel.findOne({ key: `index:${adapter.chainId}` }).lean(),
      ChainEventModel.findOne().sort({ blockNumber: -1 }).lean(),
    ]);
    return {
      adapter: adapter.name,
      chainId: adapter.chainId,
      network: networkName(adapter.chainId),
      explorer: adapter.explorerTxUrl('0x')?.replace(/\/tx\/0x$/, '') ?? null,
      contracts: adapter.deployment?.contracts ?? null,
      relayer: adapter.relayerAddress ?? null,
      indexedBlock: cursor?.blockNumber ?? null,
      lastEventBlock: lastEvent?.blockNumber ?? null,
      ops: Object.fromEntries(counts.map((row) => [row._id, row.n])),
    };
  },

  async reconciliationReport({ stalePendingMs = PROJECTION_STALE_MS } = {}) {
    const stuckBefore = new Date(Date.now() - 10 * 60_000);
    const staleBefore = new Date(Date.now() - stalePendingMs);
    const [
      stuck,
      failed,
      failedProjections,
      stalePendingProjections,
      failedProjectionCount,
      stalePendingProjectionCount,
      counts,
    ] = await Promise.all([
      ChainOpModel.find({ status: { $in: ['created', 'submitted'] }, createdAt: { $lt: stuckBefore } }).limit(100).lean(),
      ChainOpModel.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(100).lean(),
      ChainOpModel.find({ status: 'completed', projectionStatus: 'failed' }).sort({ updatedAt: -1 }).limit(100).lean(),
      ChainOpModel.find({ status: 'completed', projectionStatus: 'pending', updatedAt: { $lte: staleBefore } }).sort({ updatedAt: 1 }).limit(100).lean(),
      ChainOpModel.countDocuments({ status: 'completed', projectionStatus: 'failed' }),
      ChainOpModel.countDocuments({ status: 'completed', projectionStatus: 'pending', updatedAt: { $lte: staleBefore } }),
      ChainOpModel.aggregate([{ $group: { _id: { kind: '$kind', status: '$status' }, n: { $sum: 1 } } }]),
    ]);
    return {
      healthy:
        stuck.length === 0 &&
        failed.length === 0 &&
        failedProjectionCount === 0 &&
        stalePendingProjectionCount === 0,
      stuck: stuck.map(mapOp),
      failed: failed.map(mapOp),
      failedProjections: failedProjections.map(mapOp),
      stalePendingProjections: stalePendingProjections.map(mapOp),
      projectionCounts: {
        failed: failedProjectionCount,
        stalePending: stalePendingProjectionCount,
      },
      byKind: counts.map((row) => ({ kind: row._id.kind, status: row._id.status, count: row.n })),
    };
  },

  explorerTxUrl(txHash) {
    return chainAdapter().explorerTxUrl(txHash);
  },

  /** Highest nonce this platform already signed for `address` that may not be mined yet. */
  async nonceFloor(address) {
    const op = await ChainOpModel.findOne({ sender: address, status: 'submitted', nonce: { $ne: null } })
      .sort({ nonce: -1 })
      .select('nonce')
      .lean();
    return op ? op.nonce + 1 : 0;
  },
};

export function mapOp(op) {
  return {
    id: op.pid,
    kind: op.kind,
    adapter: op.adapter,
    ref: op.ref,
    refType: op.refType,
    status: op.status,
    attempts: op.attempts,
    txHash: op.txHash,
    explorerUrl: chainAdapter().explorerTxUrl(op.txHash),
    blockNumber: op.blockNumber,
    lastError: op.lastError,
    result: op.result,
    createdAt: op.createdAt,
    submittedAt: op.submittedAt,
    completedAt: op.completedAt,
  };
}

// One chain writer per process: prepares and broadcasts are serialized so nonces never race.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function processOp(opId) {
  const op = await ChainOpModel.findOneAndUpdate(
    {
      _id: opId,
      status: 'created',
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }],
    },
    { $set: { lockedUntil: new Date(Date.now() + LOCK_MS) } },
    { new: true },
  ).lean();
  if (!op) return;

  if (op.dependsOn) {
    const dependency = await ChainOpModel.findById(op.dependsOn).select('status result').lean();
    if (dependency?.status !== 'completed') {
      const failedDependency = dependency?.status === 'failed';
      await ChainOpModel.updateOne(
        { _id: op._id },
        {
          $set: {
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + (failedDependency ? 60_000 : 3000)),
            lastError: failedDependency ? 'dependency_failed' : 'waiting_for_dependency',
          },
        },
      );
      return;
    }
    // Ops queued before their item was minted learn the token id from the mint result.
    if (op.payload.tokenId == null && dependency.result?.tokenId) {
      op.payload = { ...op.payload, tokenId: dependency.result.tokenId };
      await ChainOpModel.updateOne({ _id: op._id }, { $set: { 'payload.tokenId': dependency.result.tokenId } });
    }
  }

  const adapter = chainAdapter();
  let persistedSubmitted = false;
  try {
    const prepared = await adapter.prepare(op);
    if (prepared.alreadyDone) {
      await completeOp(op, prepared.result ?? {}, null);
      return;
    }
    if (prepared.pending) {
      const pendingTxHash = prepared.txHash ?? op.txHash ?? null;
      const update = {
        $set: {
          status: 'submitted',
          txHash: pendingTxHash,
          submittedAt: op.submittedAt ?? new Date(),
          lockedUntil: null,
          ...(prepared.blockNumber !== null && prepared.blockNumber !== undefined ? { blockNumber: prepared.blockNumber } : {}),
        },
      };
      if (pendingTxHash) update.$addToSet = { txHashes: pendingTxHash };
      await ChainOpModel.updateOne({ _id: op._id }, update);
      return;
    }
    // Persist the signed transaction before broadcasting: a crash now resolves by rebroadcast.
    await ChainOpModel.updateOne(
      { _id: op._id },
      {
        $set: {
          status: 'submitted',
          txHash: prepared.txHash,
          sender: prepared.sender,
          nonce: prepared.nonce,
          rawTx: prepared.rawTx,
          submittedAt: new Date(),
          lockedUntil: null,
          result: { ...(op.result ?? {}), ...(prepared.partial ?? {}) },
        },
        $addToSet: { txHashes: prepared.txHash },
        $inc: { attempts: 1 },
      },
    );
    persistedSubmitted = true;
    if (prepared.rawTx) {
      try {
        await adapter.broadcast(prepared.rawTx);
      } catch (error) {
        if (op.kind === 'payout') {
          const message = String(error?.shortMessage ?? error?.message ?? error).slice(0, 500);
          await ChainOpModel.updateOne({ _id: op._id }, { $set: { lastError: message, lockedUntil: null } });
          logger.warn({ err: error, op: op.pid, kind: op.kind, txHash: prepared.txHash }, 'payout_broadcast_failed');
          return;
        }
        throw error;
      }
    }
    await reconcileOp(op._id);
  } catch (error) {
    if (persistedSubmitted && op.kind === 'payout') {
      const message = String(error?.shortMessage ?? error?.message ?? error).slice(0, 500);
      await ChainOpModel.updateOne({ _id: op._id }, { $set: { lastError: message, lockedUntil: null } });
      logger.warn({ err: error, op: op.pid, kind: op.kind }, 'payout_post_submit_error');
      return;
    }
    await scheduleRetry(op, error);
  }
}

async function reconcileOp(opId) {
  const op = await ChainOpModel.findById(opId).select('+rawTx').lean();
  if (!op || !['submitted', 'chain_confirmed'].includes(op.status)) return;
  const adapter = chainAdapter();

  let receipt;
  try {
    receipt = await adapter.checkReceipt(op);
  } catch (error) {
    logger.warn({ err: error, op: op.pid }, 'chain_receipt_check_failed');
    return;
  }

  if (receipt.state === 'confirmed') {
    await confirmOp(op, receipt);
    return;
  }
  if (receipt.state === 'dropped' && Date.now() - new Date(op.submittedAt).getTime() > DROPPED_GRACE_MS) {
    if (op.rawTx) {
      try {
        const rebroadcast = await adapter.broadcast(op.rawTx);
        logger.warn({ op: op.pid, txHash: op.txHash }, 'chain_tx_rebroadcast');
        if (rebroadcast.nonceConsumed) {
          // Another transaction used this nonce. Re-check ours once more before re-preparing;
          // ref-guarded ops are additionally protected by lookupExisting() in prepare().
          const again = await adapter.checkReceipt(op);
          if (again.state === 'confirmed') {
            await confirmOp(op, again);
          } else if (again.state === 'dropped') {
            if (op.kind === 'payout') {
              // Payout has no on-chain idempotency ref: never clear rawTx/nonce or re-sign a second tx,
              // and do not auto-reverse via onFailed in case the original tx landed on a lagging RPC.
              await ChainOpModel.updateOne(
                { _id: op._id },
                { $set: { status: 'failed', lastError: 'payout_nonce_consumed_manual_reconcile', lockedUntil: null } },
              );
              logger.error({ op: op.pid, kind: op.kind, txHash: op.txHash }, 'payout_nonce_consumed_manual_reconcile');
            } else {
              await scheduleRetry(op, new Error('nonce_consumed'), { resetSubmission: true });
            }
          }
        }
      } catch (error) {
        if (op.kind === 'payout') {
          const message = String(error?.shortMessage ?? error?.message ?? error).slice(0, 500);
          await ChainOpModel.updateOne({ _id: op._id }, { $set: { lastError: message, lockedUntil: null } });
          logger.warn({ err: error, op: op.pid, kind: op.kind, txHash: op.txHash }, 'payout_rebroadcast_failed');
        } else {
          await scheduleRetry(op, error, { resetSubmission: true });
        }
      }
    } else {
      await scheduleRetry(op, new Error('tx_dropped'), { resetSubmission: true });
    }
    return;
  }
  if (receipt.state === 'reverted') {
    await scheduleRetry(op, new Error('tx_reverted'), { resetSubmission: true });
  }
}

async function confirmOp(op, receipt) {
  const confirmedTxHash = receipt.txHash && receipt.txHash !== op.txHash ? receipt.txHash : op.txHash;
  await ChainOpModel.updateOne(
    { _id: op._id, status: 'submitted' },
    {
      $set: {
        status: 'chain_confirmed',
        confirmedAt: new Date(),
        blockNumber: receipt.blockNumber ?? null,
        ...(confirmedTxHash ? { txHash: confirmedTxHash } : {}),
      },
    },
  );
  const nextOp = confirmedTxHash !== op.txHash ? { ...op, txHash: confirmedTxHash } : op;
  await completeOp(nextOp, receipt.result ?? {}, receipt.blockNumber, confirmedTxHash);
}

async function completeOp(op, result, blockNumber, confirmedTxHash) {
  const merged = { ...(op.result ?? {}), ...result };
  const resolvedTxHash = confirmedTxHash ?? result?.txHash ?? op.txHash;
  const updated = await ChainOpModel.findOneAndUpdate(
    { _id: op._id, status: { $ne: 'completed' } },
    {
      $set: {
        status: 'completed',
        result: merged,
        completedAt: new Date(),
        lockedUntil: null,
        lastError: null,
        projectionStatus: 'pending',
        projectionError: null,
        ...(resolvedTxHash && resolvedTxHash !== op.txHash ? { txHash: resolvedTxHash } : {}),
        ...(blockNumber !== null && blockNumber !== undefined ? { blockNumber } : {}),
      },
    },
    { new: true },
  ).lean();
  if (!updated) return;
  await runProjection(updated, merged);
}

async function runProjection(op, result) {
  const handler = handlers.get(op.kind);
  try {
    await handler?.onCompleted?.(op, result);
    await ChainOpModel.updateOne(
      { _id: op._id },
      { $set: { projectionStatus: 'done', projectionError: null } },
    );
    eventBus.emit('chain.confirmed', { opId: op.pid, kind: op.kind, ref: op.ref, txHash: op.txHash });
  } catch (error) {
    const message = String(error?.shortMessage ?? error?.message ?? error).slice(0, 500);
    logger.error({ err: error, op: op.pid }, 'chain_projection_failed');
    await ChainOpModel.updateOne(
      { _id: op._id },
      { $set: { projectionStatus: 'failed', projectionError: message } },
    );
  }
}

async function retryProjection(opId, { stalePendingMs = PROJECTION_STALE_MS } = {}) {
  const staleBefore = new Date(Date.now() - stalePendingMs);
  const op = await ChainOpModel.findOneAndUpdate(
    {
      _id: opId,
      status: 'completed',
      $or: [
        { projectionStatus: 'failed' },
        { projectionStatus: 'pending', updatedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { projectionStatus: 'pending', projectionError: null } },
    { new: true },
  ).lean();
  if (!op) return false;
  await runProjection(op, op.result ?? {});
  return true;
}

async function scheduleRetry(op, error, { resetSubmission = false } = {}) {
  const attempts = (op.attempts ?? 0) + (resetSubmission ? 0 : 1);
  const message = String(error?.shortMessage ?? error?.message ?? error).slice(0, 500);
  if (attempts >= MAX_ATTEMPTS) {
    const failed = await ChainOpModel.findOneAndUpdate(
      { _id: op._id },
      { $set: { status: 'failed', lastError: message, lockedUntil: null, attempts } },
      { new: true },
    ).lean();
    logger.error({ op: op.pid, kind: op.kind, error: message }, 'chain_op_failed');
    try {
      await handlers.get(op.kind)?.onFailed?.(failed, message);
    } catch (handlerError) {
      logger.error({ err: handlerError, op: op.pid }, 'chain_failure_handler_failed');
    }
    return;
  }
  const delay = Math.min(600_000, 2 ** attempts * 2000);
  logger.warn({ op: op.pid, kind: op.kind, attempts, error: message }, 'chain_op_retry');
  await ChainOpModel.updateOne(
    { _id: op._id },
    {
      $set: {
        status: 'created',
        attempts,
        lastError: message,
        lockedUntil: null,
        nextAttemptAt: new Date(Date.now() + delay),
        ...(resetSubmission ? { rawTx: null, nonce: null } : {}),
      },
    },
  );
}

function networkName(chainId) {
  return { 43113: 'avalanche-fuji', 43114: 'avalanche-mainnet', 31337: 'hardhat-local', 0: 'mock' }[chainId] ?? `chain-${chainId}`;
}
