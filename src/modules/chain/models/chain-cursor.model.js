import { Schema, model } from '../../../db/model-helpers.js';

const chainCursorSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    blockNumber: { type: Number, required: true },
  },
  { timestamps: true },
);

export const ChainCursorModel = model('ChainCursor', chainCursorSchema, 'chainCursors');
