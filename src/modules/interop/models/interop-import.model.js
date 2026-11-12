import { ObjectId, Schema, Units, appendOnly, model } from '../../../db/model-helpers.js';

const interopImportSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    inventoryItemId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    sourceGameId: { type: ObjectId, required: true },
    hostGameId: { type: ObjectId, required: true },
    tier: { type: String, required: true },
    schemaId: { type: String, required: true },
    sourceTraits: { type: Schema.Types.Mixed, default: () => ({}) },
    mappedTraits: { type: Schema.Types.Mixed, default: () => ({}) },
    envelopeSnapshot: { type: Schema.Types.Mixed, required: true },
    checks: [{ _id: false, name: String, passed: Boolean, detail: String }],
    licenseId: { type: ObjectId, default: null },
    feeUnits: Units,
    ledgerTxId: { type: String, default: null },
    deedsCarried: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

interopImportSchema.index({ inventoryItemId: 1, hostGameId: 1 }, { unique: true });
interopImportSchema.index({ hostGameId: 1, createdAt: -1 });
interopImportSchema.index({ userId: 1, createdAt: -1 });

appendOnly(interopImportSchema, 'interop_imports_are_append_only');

export const InteropImportModel = model('InteropImport', interopImportSchema, 'interopImports');
