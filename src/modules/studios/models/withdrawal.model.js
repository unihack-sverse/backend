import { ObjectId, RequiredUnits, Schema, model } from '../../../db/model-helpers.js';

const withdrawalSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    amountUnits: RequiredUnits,
    destinationAddress: { type: String, required: true },
    status: { type: String, enum: ['pending', 'settling', 'settled', 'failed'], default: 'pending' },
    ledgerTxId: { type: String, default: null },
    reversalTxId: { type: String, default: null },
    chainOpId: { type: ObjectId, default: null },
    txHash: { type: String, default: null },
    failureCode: { type: String, default: null },
    settledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

withdrawalSchema.index({ studioId: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1 });

export const WithdrawalModel = model('Withdrawal', withdrawalSchema, 'withdrawals');
