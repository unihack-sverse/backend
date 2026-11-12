import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';
import { ROLES } from '../../../config/constants.js';

const userSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    handle: { type: String, required: true, unique: true, lowercase: true, trim: true },
    handleRaw: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },
    custodialAddress: { type: String, required: true },
    custodyIndex: { type: Number, required: true },
    roles: { type: [String], enum: ROLES, default: ['player'] },
    studioId: { type: ObjectId, ref: 'Studio', default: null },
    reputation: { type: Number, default: 0, min: 0, max: 100 },
    reputationInputs: {
      type: new Schema(
        {
          playtimeMinutes: { type: Number, default: 0 },
          spendUnits: Units,
          clubScore: { type: Number, default: 0 },
          accountAgeDays: { type: Number, default: 0 },
          flags: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      select: false,
      default: () => ({}),
    },
    skill: {
      tier: { type: String, default: 'unranked' },
      firstClears: { type: Number, default: 0 },
      tournamentBest: { type: String, default: null },
    },
    counters: {
      inventory: { type: Number, default: 0 },
      gamesTouched: { type: Number, default: 0 },
      deeds: { type: Number, default: 0 },
    },
    referral: {
      code: { type: String },
      referredBy: { type: ObjectId, default: null },
      boundUntil: { type: Date, default: null },
    },
    signupIpHash: { type: String, default: null },
    signupUaHash: { type: String, default: null },
    faucetClaimedAt: { type: Date, default: null },
    reputationSource: { type: String, enum: ['computed', 'seed'], default: 'computed' },
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    onboardedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

userSchema.index({ studioId: 1 }, { sparse: true });
userSchema.index({ 'referral.code': 1 }, { unique: true, partialFilterExpression: { 'referral.code': { $type: 'string' } } });
userSchema.index({ reputation: -1 });
userSchema.index({ status: 1, lastSeenAt: -1 });
userSchema.index({ custodyIndex: 1 }, { unique: true });

export const UserModel = model('User', userSchema, 'users');
