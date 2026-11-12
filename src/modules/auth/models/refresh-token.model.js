import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const refreshTokenSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    userId: { type: ObjectId, required: true },
    family: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: '' },
    ipHash: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refreshTokenSchema.index({ userId: 1, family: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshTokenModel = model('RefreshToken', refreshTokenSchema, 'refreshTokens');
