import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';

const studioSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    ownerUserId: { type: ObjectId, required: true },
    handle: { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true },
    bio: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    links: {
      site: { type: String, default: '' },
      x: { type: String, default: '' },
      discord: { type: String, default: '' },
    },
    vaultAccountId: { type: ObjectId, required: true },
    bondAccountId: { type: ObjectId, required: true },
    stakedUnits: Units,
    feeTier: { type: String, enum: ['standard', 'staked', 'premium'], default: 'standard' },
    feeBps: { type: Number, default: 1000 },
    oneHumanStudio: { type: Boolean, default: true },
    genesis: { type: Boolean, default: false },
    strikes: { type: Number, default: 0 },
    counters: {
      games: { type: Number, default: 0 },
      itemsSold: { type: Number, default: 0 },
      grossUnits: Units,
    },
    custodyIndex: { type: Number, required: true },
    signerAddress: { type: String, required: true },
    payoutAddress: { type: String, default: null },
    kycVerifiedAt: { type: Date, default: null },
    withdrawnUnits: Units,
    debtUnits: Units,
    status: { type: String, enum: ['active', 'suspended', 'closed'], default: 'active' },
  },
  { timestamps: true },
);

studioSchema.index({ ownerUserId: 1 });
studioSchema.index({ status: 1, 'counters.grossUnits': -1 });
studioSchema.index({ custodyIndex: 1 }, { unique: true });

export const StudioModel = model('Studio', studioSchema, 'studios');
