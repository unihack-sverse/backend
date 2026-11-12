import { Schema, model } from '../../../db/model-helpers.js';

// Indexed contract logs. Unique on (txHash, logIndex) so re-scanning a block range is idempotent.
const chainEventSchema = new Schema(
  {
    chainId: { type: Number, required: true },
    contract: { type: String, required: true },
    address: { type: String, required: true },
    event: { type: String, required: true },
    args: { type: Schema.Types.Mixed, default: () => ({}) },
    blockNumber: { type: Number, required: true },
    blockHash: { type: String, required: true },
    txHash: { type: String, required: true },
    logIndex: { type: Number, required: true },
    appliedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

chainEventSchema.index({ txHash: 1, logIndex: 1 }, { unique: true });
chainEventSchema.index({ event: 1, blockNumber: -1 });
chainEventSchema.index({ appliedAt: 1, blockNumber: 1 });

export const ChainEventModel = model('ChainEvent', chainEventSchema, 'chainEvents');
