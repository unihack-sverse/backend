import { ObjectId, Schema, model } from '../../../db/model-helpers.js';
import { INTEROP_TIERS, ITEM_KINDS } from '../../../config/constants.js';

const inventoryItemSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    userId: { type: ObjectId, required: true },
    itemDefinitionId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    // Denormalised so inventory and entitlement reads never need $lookup (08 §9).
    name: { type: String, required: true },
    sku: { type: String, required: true },
    kind: { type: String, enum: ITEM_KINDS, required: true },
    interopTier: { type: String, enum: INTEROP_TIERS, default: 'T0' },
    schemaId: { type: String, default: null },
    slot: { type: String, default: null },
    artUrl: { type: String, default: '' },
    tokenId: { type: String, default: null },
    chain: {
      status: { type: String, enum: ['pending', 'confirmed', 'failed', 'none'], default: 'pending' },
      txHash: { type: String, default: null },
      ownerAddress: { type: String, default: null },
      opId: { type: ObjectId, default: null },
    },
    traits: { type: Schema.Types.Mixed, default: () => ({}) },
    deedCount: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },
    equipped: { type: Boolean, default: false },
    transferable: { type: Boolean, default: true },
    stackable: { type: Boolean, default: false },
    acquiredVia: { type: String, enum: ['purchase', 'reward', 'drop', 'secondary', 'airdrop', 'test'], default: 'purchase' },
    acquiredOrderId: { type: ObjectId, default: null },
    status: { type: String, enum: ['owned', 'listed', 'revoked', 'burned', 'transferred'], default: 'owned' },
    revokedReason: { type: String, default: null },
  },
  { timestamps: true },
);

inventoryItemSchema.index({ userId: 1, status: 1, createdAt: -1 });
inventoryItemSchema.index({ userId: 1, interopTier: 1, kind: 1 });
inventoryItemSchema.index({ userId: 1, equipped: 1, slot: 1 });
inventoryItemSchema.index({ itemDefinitionId: 1 });
inventoryItemSchema.index({ tokenId: 1 }, { sparse: true });
inventoryItemSchema.index({ gameId: 1, userId: 1 });
inventoryItemSchema.index({ acquiredOrderId: 1 }, { unique: true, partialFilterExpression: { acquiredOrderId: { $type: 'objectId' } } });
// Non-stackable duplicates are blocked by the index, which survives buggy service code.
inventoryItemSchema.index(
  { userId: 1, itemDefinitionId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['owned', 'listed'] }, stackable: false } },
);

export const InventoryItemModel = model('InventoryItem', inventoryItemSchema, 'inventoryItems');
