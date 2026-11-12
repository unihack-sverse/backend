import { ObjectId, RequiredUnits, Schema, Units, model } from '../../../db/model-helpers.js';

const orderSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    userId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    itemDefinitionId: { type: ObjectId, required: true },
    sku: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    channel: { type: String, enum: ['web', 'sdk', 'sandbox'], default: 'web' },
    paymentMethod: { type: String, enum: ['srv_balance', 'fiat_onramp'], default: 'srv_balance' },
    quote: {
      priceUnits: RequiredUnits,
      usdAmount: { type: String, required: true },
      rateSnapshot: { type: String, required: true },
      expiresAt: { type: Date, required: true },
    },
    feeBreakdown: {
      feeBps: Number,
      studioUnits: Units,
      protocolUnits: Units,
      burnUnits: Units,
      creatorRewardsUnits: Units,
      playerRewardsUnits: Units,
      treasuryUnits: Units,
      curatorUnits: Units,
    },
    status: {
      type: String,
      enum: ['pending', 'settling', 'completed', 'failed', 'refunded', 'cancelled'],
      default: 'pending',
    },
    failureCode: { type: String, default: null },
    ledgerTxId: { type: String, default: null },
    refundTxId: { type: String, default: null },
    inventoryItemId: { type: ObjectId, default: null },
    chainOpId: { type: ObjectId, default: null },
    txHash: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    onrampSessionId: { type: String, default: null },
    onrampCreditedAt: { type: Date, default: null },
    disputeWindowEndsAt: { type: Date, default: null },
    lockReleasedAt: { type: Date, default: null },
    settledAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

orderSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ gameId: 1, status: 1, settledAt: -1 });
orderSchema.index({ status: 1, 'quote.expiresAt': 1 });
orderSchema.index({ disputeWindowEndsAt: 1, lockReleasedAt: 1 });
orderSchema.index({ onrampSessionId: 1 }, { sparse: true });

export const OrderModel = model('Order', orderSchema, 'orders');
