import { ObjectId, Schema, appendOnly, model } from '../../../db/model-helpers.js';

const deedSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    inventoryItemId: { type: ObjectId, required: true },
    tokenId: { type: String, default: null },
    userId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    deedType: { type: String, required: true },
    detail: { type: Schema.Types.Mixed, default: () => ({}) },
    traitsBefore: { type: Schema.Types.Mixed, default: () => ({}) },
    traitsAfter: { type: Schema.Types.Mixed, default: () => ({}) },
    epoch: { type: Number, required: true },
    nonce: { type: String, required: true },
    studioSignature: { type: String, required: true },
    sverseWitness: { type: String, default: null },
    payloadHash: { type: String, required: true },
    repAtDeed: { type: Number, default: 0 },
    // Chain anchoring and verification are tracked on DeedStatus, keeping this row immutable.
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

deedSchema.index({ inventoryItemId: 1, createdAt: 1 });
deedSchema.index({ inventoryItemId: 1, nonce: 1 }, { unique: true });
deedSchema.index({ inventoryItemId: 1, deedType: 1, createdAt: -1 });
deedSchema.index({ userId: 1, createdAt: -1 });

appendOnly(deedSchema, 'deeds_are_append_only');

export const DeedModel = model('Deed', deedSchema, 'deeds');
