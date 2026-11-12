import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const playSessionSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    userId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    apiKeyId: { type: ObjectId, default: null },
    startedAt: { type: Date, required: true },
    lastHeartbeatAt: { type: Date, required: true },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, enum: ['client', 'timeout', 'superseded', null], default: null },
    activeMs: { type: Number, default: 0 },
    minutes: { type: Number, default: 0 },
    heartbeatCount: { type: Number, default: 0 },
    ipHash: { type: String, default: null },
    clientVersion: { type: String, default: null },
    suspicious: { type: Boolean, default: false },
    rolledUpAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

playSessionSchema.index({ userId: 1, gameId: 1, closedAt: 1 });
playSessionSchema.index({ closedAt: 1, lastHeartbeatAt: 1 });
playSessionSchema.index({ closedAt: 1, rolledUpAt: 1 });
playSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

export const PlaySessionModel = model('PlaySession', playSessionSchema, 'playSessions');
