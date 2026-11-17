import { ethers } from 'ethers';

import { Schema, model } from '../../../db/model-helpers.js';

const walletChallengeSchema = new Schema(
  {
    nonce: { type: String, required: true, unique: true },
    walletAddress: {
      type: String,
      required: true,
      set: (value) => (typeof value === 'string' && value.length > 0 ? ethers.getAddress(value) : value),
    },
    chainId: { type: Number, required: true, default: 43113 },
    purpose: { type: String, enum: ['login', 'link'], required: true, default: 'login' },
    message: { type: String, required: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

walletChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
walletChallengeSchema.index({ walletAddress: 1, purpose: 1 });

export const WalletChallengeModel = model('WalletChallenge', walletChallengeSchema, 'walletChallenges');
