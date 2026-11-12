import { ObjectId, RequiredUnits, Schema, model } from '../../../db/model-helpers.js';
import { INTEROP_TIERS, ITEM_KINDS, TOKENIZATION_LEVELS } from '../../../config/constants.js';

const itemDefinitionSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    gameId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    kind: { type: String, enum: ITEM_KINDS, required: true },
    priceUnits: RequiredUnits,
    schemaId: { type: String, default: null },
    interopTier: { type: String, enum: INTEROP_TIERS, default: 'T0' },
    tokenizationLevel: { type: String, enum: TOKENIZATION_LEVELS, default: 'L2' },
    licenseId: { type: ObjectId, default: null },
    slot: { type: String, default: null },
    supply: {
      type: { type: String, enum: ['limited', 'unlimited'], default: 'unlimited' },
      max: { type: Number, default: null },
      minted: { type: Number, default: 0 },
    },
    traits: { type: Schema.Types.Mixed, default: () => ({}) },
    mutation: { traits: { type: [String], default: [] } },
    transferable: { type: Boolean, default: true },
    stackable: { type: Boolean, default: false },
    royaltyBps: { type: Number, default: 500 },
    art: {
      url: { type: String, default: '' },
      emoji: { type: String, default: '📦' },
    },
    chain: {
      definitionId: { type: String, default: null },
      status: { type: String, enum: ['none', 'pending', 'confirmed'], default: 'none' },
    },
    status: { type: String, enum: ['draft', 'active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

itemDefinitionSchema.index({ gameId: 1, sku: 1 }, { unique: true });
itemDefinitionSchema.index({ gameId: 1, status: 1 });
itemDefinitionSchema.index({ schemaId: 1, interopTier: 1 });
itemDefinitionSchema.index({ studioId: 1, status: 1 });

export const ItemDefinitionModel = model('ItemDefinition', itemDefinitionSchema, 'itemDefinitions');
