import { Schema, Units, model } from '../../../db/model-helpers.js';

const rewardEpochSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    number: { type: Number, required: true, unique: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    feeRevenueUnits: Units,
    bootstrapEmissionUnits: Units,
    playerPoolUnits: Units,
    creatorPoolUnits: Units,
    distributedUnits: Units,
    channelSplit: { type: Schema.Types.Mixed, default: () => ({}) },
    participants: {
      players: { type: Number, default: 0 },
      studios: { type: Number, default: 0 },
    },
    merkleRoot: { type: String, default: null },
    publishMerkleTxHash: { type: String, default: null },
    chainOpId: { type: Schema.Types.ObjectId, default: null },
    claimDeadline: { type: Date, default: null },
    status: { type: String, enum: ['open', 'calculating', 'published', 'failed'], default: 'open' },
    closedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

rewardEpochSchema.index({ status: 1, endAt: -1 });

export const RewardEpochModel = model('RewardEpoch', rewardEpochSchema, 'rewardEpochs');
