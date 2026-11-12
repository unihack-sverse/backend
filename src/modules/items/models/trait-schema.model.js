import { Schema, model } from '../../../db/model-helpers.js';
import { INTEROP_TIERS } from '../../../config/constants.js';

const traitSchemaSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    schemaId: { type: String, required: true, unique: true },
    namespace: { type: String, default: 'sts' },
    class: { type: String, required: true },
    subclass: { type: String, default: '' },
    version: { type: Number, default: 1 },
    fields: [
      {
        _id: false,
        name: { type: String, required: true },
        type: { type: String, enum: ['int', 'number', 'enum', 'string', 'bool'], required: true },
        min: Number,
        max: Number,
        values: [String],
        required: { type: Boolean, default: false },
      },
    ],
    mutation: {
      traits: { type: [String], default: [] },
      deedTypes: { type: [String], default: [] },
      maxVelocity: [{ _id: false, deedType: String, max: Number, windowHours: Number }],
      effects: [{ _id: false, deedType: String, trait: String, op: { type: String, enum: ['inc', 'set'] }, by: Number, from: String }],
    },
    allowedInteropTiers: { type: [String], enum: INTEROP_TIERS, default: ['T0'] },
    status: { type: String, enum: ['draft', 'active', 'deprecated'], default: 'active' },
  },
  { timestamps: true },
);

traitSchemaSchema.index({ class: 1, subclass: 1, version: -1 });
traitSchemaSchema.index({ status: 1 });

export const TraitSchemaModel = model('TraitSchema', traitSchemaSchema, 'traitSchemas');
