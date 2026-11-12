import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const playRollupSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    userId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    date: { type: String, required: true },
    minutes: { type: Number, default: 0 },
    sessions: { type: Number, default: 0 },
    reputationWeight: { type: Number, default: 0 },
    weightedMinutes: { type: Number, default: 0 },
    epoch: { type: Number, required: true },
  },
  { timestamps: true },
);

playRollupSchema.index({ userId: 1, gameId: 1, date: 1 }, { unique: true });
playRollupSchema.index({ gameId: 1, date: -1 });
playRollupSchema.index({ epoch: 1, userId: 1 });

export const PlayRollupModel = model('PlayRollup', playRollupSchema, 'playRollups');
