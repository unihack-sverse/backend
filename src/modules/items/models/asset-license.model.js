import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const assetLicenseSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    type: { type: String, enum: ['display_only', 'derivative', 'commercial'], required: true },
    royaltyBps: { type: Number, default: 0 },
    revocableOnNotice: { type: Boolean, default: false },
    noticeDays: { type: Number, default: 30 },
    terms: { type: String, default: '' },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  },
  { timestamps: true },
);

assetLicenseSchema.index({ studioId: 1, status: 1 });

export const AssetLicenseModel = model('AssetLicense', assetLicenseSchema, 'assetLicenses');
