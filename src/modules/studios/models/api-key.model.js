import { ObjectId, Schema, model } from '../../../db/model-helpers.js';
import { API_KEY_SCOPES } from '../../../config/constants.js';

const apiKeySchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, default: null },
    label: { type: String, default: '' },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true },
    // Encrypted copy used to verify game-side HMAC attestations (deeds). Never returned.
    attestationSecretEnc: { type: String, required: true, select: false },
    scopes: { type: [String], enum: API_KEY_SCOPES, default: ['game'] },
    lastUsedAt: { type: Date, default: null },
    requestCount: { type: Number, default: 0 },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

apiKeySchema.index({ studioId: 1, revokedAt: 1 });

export const ApiKeyModel = model('ApiKey', apiKeySchema, 'apiKeys');
