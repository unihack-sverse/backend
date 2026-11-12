import { ObjectId, RequiredUnits, Schema, appendOnly, model } from '../../../db/model-helpers.js';

export const LEDGER_REASONS = [
  'purchase',
  'fee',
  'royalty',
  'refund',
  'reward_claim',
  'withdrawal',
  'onramp_credit',
  'faucet',
  'interop_fee',
  'bond_stake',
  'bond_slash',
  'secondary_sale',
  'reversal',
  'reward_funding',
  'studio_debt',
];

const ledgerEntrySchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    txId: { type: String, required: true },
    accountId: { type: ObjectId, required: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    amountUnits: RequiredUnits,
    balanceAfter: RequiredUnits,
    reason: { type: String, enum: LEDGER_REASONS, required: true },
    refType: { type: String, default: null },
    refId: { type: ObjectId, default: null },
    reversalOf: { type: String, default: null },
    memo: { type: String, default: '' },
    epoch: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerEntrySchema.index({ txId: 1 });
ledgerEntrySchema.index({ accountId: 1, createdAt: -1 });
ledgerEntrySchema.index({ refType: 1, refId: 1 });
ledgerEntrySchema.index({ reason: 1, epoch: 1 });
ledgerEntrySchema.index({ createdAt: -1 });
ledgerEntrySchema.index({ reversalOf: 1 }, { sparse: true });

appendOnly(ledgerEntrySchema, 'ledger_is_append_only');

export const LedgerEntryModel = model('LedgerEntry', ledgerEntrySchema, 'ledgerEntries');
