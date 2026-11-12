import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

// Single-use email verification and password reset tokens. Only a hash is stored.
const authTokenSchema = new Schema(
  {
    userId: { type: ObjectId, required: true },
    purpose: { type: String, enum: ['email_verify', 'password_reset'], required: true },
    tokenHash: { type: String, required: true, unique: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authTokenSchema.index({ userId: 1, purpose: 1 });

export const AuthTokenModel = model('AuthToken', authTokenSchema, 'authTokens');
