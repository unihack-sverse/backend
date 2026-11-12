import { ObjectId, RequiredUnits, Schema, model } from '../../../db/model-helpers.js';

const listingSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    inventoryItemId: { type: ObjectId, required: true },
    sellerUserId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    schemaId: { type: String, default: null },
    name: { type: String, required: true },
    artUrl: { type: String, default: '' },
    priceUnits: RequiredUnits,
    royaltyBps: { type: Number, default: 500 },
    protocolBps: { type: Number, default: 250 },
    deedCountAtListing: { type: Number, default: 0 },
    verifiedDeedCount: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'sold', 'cancelled', 'stale'], default: 'open' },
    buyerUserId: { type: ObjectId, default: null },
    soldAt: { type: Date, default: null },
    ledgerTxId: { type: String, default: null },
    chainOpId: { type: ObjectId, default: null },
  },
  { timestamps: true },
);

listingSchema.index({ inventoryItemId: 1, status: 1 });
listingSchema.index({ status: 1, priceUnits: 1 });
listingSchema.index({ status: 1, deedCountAtListing: -1 });
listingSchema.index({ gameId: 1, status: 1 });
listingSchema.index({ sellerUserId: 1, status: 1 });
// One open listing per item at a time.
listingSchema.index({ inventoryItemId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

export const ListingModel = model('Listing', listingSchema, 'listings');
