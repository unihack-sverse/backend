import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';

const curatorAttributionSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    curatorUserId: { type: ObjectId, required: true },
    referredUserId: { type: ObjectId, required: true, unique: true },
    gameId: { type: ObjectId, default: null },
    boundAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    attributedUnits: Units,
    firstSpendAt: { type: Date, default: null },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, default: null },
  },
  { timestamps: true },
);

curatorAttributionSchema.index({ curatorUserId: 1, expiresAt: -1 });

export const CuratorAttributionModel = model('CuratorAttribution', curatorAttributionSchema, 'curatorAttributions');
