import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';
import { INTEROP_TIERS } from '../../../config/constants.js';

const interopEnvelopeSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    gameId: { type: ObjectId, required: true, unique: true },
    acceptsTierMax: { type: String, enum: INTEROP_TIERS, default: 'T1' },
    accepts: [
      {
        _id: false,
        schemaId: { type: String, required: true },
        tierMax: { type: String, enum: INTEROP_TIERS, required: true },
        powerTierRange: { type: [Number], default: undefined },
        // Declarative only: { trait: { from, curve: 'linear'|'step', inRange?, outRange } | { from, passthrough: true } }
        mapping: { type: Schema.Types.Mixed, default: () => ({}) },
        clampPolicy: { type: String, enum: ['reject', 'clamp'], default: 'reject' },
      },
    ],
    licenseRequirement: { type: String, enum: ['display_only', 'derivative', 'commercial'], default: 'display_only' },
    feeUnits: Units,
    hostSharePct: { type: Number, default: 50, min: 0, max: 100 },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
  },
  { timestamps: true },
);

interopEnvelopeSchema.index({ 'accepts.schemaId': 1, acceptsTierMax: 1 });

export const InteropEnvelopeModel = model('InteropEnvelope', interopEnvelopeSchema, 'interopEnvelopes');
