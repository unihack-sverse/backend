import { Schema, model } from '../../../db/model-helpers.js';

// Stores the first response for an Idempotency-Key so replays are byte-identical (UC-07 Alt 1a).
const idempotencyRecordSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    fingerprint: { type: String, required: true },
    status: { type: String, enum: ['in_flight', 'done'], default: 'in_flight' },
    responseStatus: { type: Number, default: null },
    responseBody: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecordModel = model('IdempotencyRecord', idempotencyRecordSchema, 'idempotencyRecords');
