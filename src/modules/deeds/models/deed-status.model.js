import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

/**
 * Mutable side-car for an immutable deed: verification outcome and chain anchoring. Keeping
 * these off the deed row is what lets the deed collection be strictly insert-only.
 */
const deedStatusSchema = new Schema(
  {
    deedId: { type: ObjectId, required: true, unique: true },
    inventoryItemId: { type: ObjectId, required: true },
    verified: { type: Boolean, default: null },
    verificationNote: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    chain: {
      status: { type: String, enum: ['pending', 'confirmed', 'failed', 'none'], default: 'pending' },
      txHash: { type: String, default: null },
      chainDeedId: { type: String, default: null },
      opId: { type: ObjectId, default: null },
    },
  },
  { timestamps: true },
);

deedStatusSchema.index({ verified: 1, createdAt: -1 });
deedStatusSchema.index({ inventoryItemId: 1 });

export const DeedStatusModel = model('DeedStatus', deedStatusSchema, 'deedStatuses');
