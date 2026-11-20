import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

export const CHAIN_OP_KINDS = [
  'mint_item',
  'transfer_item',
  'burn_item',
  'record_deed',
  'publish_epoch',
  'payout',
  'register_studio',
];

/**
 * Transactional outbox for every on-chain effect. Business transactions insert an op in the same
 * Mongo session; the dispatcher submits it later. Lifecycle (README "Backend integration"):
 * created → submitted → chain_confirmed → completed, or failed (→ compensated by the owner).
 */
const chainOpSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    kind: { type: String, enum: CHAIN_OP_KINDS, required: true },
    adapter: { type: String, enum: ['mock', 'avalanche'], required: true },
    ref: { type: String, required: true, unique: true },
    refType: { type: String, required: true },
    refId: { type: ObjectId, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    dependsOn: { type: ObjectId, default: null },
    status: {
      type: String,
      enum: ['created', 'submitted', 'chain_confirmed', 'completed', 'failed'],
      default: 'created',
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    txHash: { type: String, default: null },
    txHashes: { type: [String], default: [] },
    sender: { type: String, default: null },
    nonce: { type: Number, default: null },
    rawTx: { type: String, default: null, select: false },
    blockNumber: { type: Number, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    lastError: { type: String, default: null },
    projectionStatus: {
      type: String,
      enum: ['pending', 'done', 'failed'],
      default: 'pending',
    },
    projectionError: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

chainOpSchema.index({ status: 1, nextAttemptAt: 1 });
chainOpSchema.index({ status: 1, projectionStatus: 1 });
chainOpSchema.index({ refType: 1, refId: 1 });
chainOpSchema.index({ txHash: 1 }, { sparse: true });

export const ChainOpModel = model('ChainOp', chainOpSchema, 'chainOps');
