import { ObjectId, RequiredUnits, Schema, model } from '../../../db/model-helpers.js';

const rewardClaimSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    epochId: { type: ObjectId, required: true },
    epochNumber: { type: Number, required: true },
    claimantType: { type: String, enum: ['user', 'studio'], required: true },
    claimantId: { type: ObjectId, required: true },
    claimantAddress: { type: String, required: true },
    leafIndex: { type: Number, required: true },
    amountUnits: RequiredUnits,
    channels: [{ _id: false, channel: String, sharePct: Number, amountUnits: BigInt, note: String }],
    score: { type: Number, default: 0 },
    scoreInputs: { type: Schema.Types.Mixed, default: () => ({}) },
    merkleProof: { type: [String], default: [] },
    status: { type: String, enum: ['unclaimed', 'claimed', 'expired'], default: 'unclaimed' },
    claimedAt: { type: Date, default: null },
    ledgerTxId: { type: String, default: null },
  },
  { timestamps: true },
);

// Storage-level double-claim guard (UC-27).
rewardClaimSchema.index({ epochId: 1, claimantType: 1, claimantId: 1 }, { unique: true });
rewardClaimSchema.index({ claimantId: 1, status: 1, epochNumber: -1 });
rewardClaimSchema.index({ status: 1, epochNumber: 1 });

export const RewardClaimModel = model('RewardClaim', rewardClaimSchema, 'rewardClaims');
