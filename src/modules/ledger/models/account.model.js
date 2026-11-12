import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';

const accountSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    ownerType: {
      type: String,
      enum: ['user', 'studio', 'studio_bond', 'treasury', 'pool', 'payable', 'external'],
      required: true,
    },
    ownerId: { type: ObjectId, default: null },
    purpose: {
      type: String,
      enum: [
        'wallet',
        'vault',
        'bond',
        'burn',
        'creator_rewards',
        'player_rewards',
        'treasury',
        'curator',
        'payable',
        'onramp',
      ],
      required: true,
    },
    balanceUnits: Units,
    lockedUnits: Units,
    currency: { type: String, default: 'SRV' },
    allowNegative: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'frozen'], default: 'active' },
  },
  { timestamps: true },
);

accountSchema.index({ ownerType: 1, ownerId: 1, purpose: 1 }, { unique: true });
accountSchema.index({ purpose: 1 });

export const AccountModel = model('Account', accountSchema, 'accounts');
