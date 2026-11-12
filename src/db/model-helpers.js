import mongoose from 'mongoose';

import { AppError } from '../lib/errors.js';

export const { Schema } = mongoose;
export const ObjectId = Schema.Types.ObjectId;
export const Units = { type: BigInt, default: 0n };
export const RequiredUnits = { type: BigInt, required: true };

export function model(name, schema, collection) {
  return mongoose.models[name] ?? mongoose.model(name, schema, collection);
}

const MUTATING_QUERIES = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];

/** Invariant 4 (and the ledger's append-only rule): no update or delete path at the model layer. */
export function appendOnly(schema, code) {
  schema.pre(MUTATING_QUERIES, function blockMutation(next) {
    next(new AppError(code, 500));
  });
  schema.pre('save', function blockResave(next) {
    if (!this.isNew) return next(new AppError(code, 500));
    return next();
  });
  schema.pre('bulkWrite', function blockBulk(next) {
    next(new AppError(code, 500));
  });
}
