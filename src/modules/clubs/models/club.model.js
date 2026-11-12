import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const clubSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    gameId: { type: ObjectId, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    name: { type: String, required: true },
    gates: {
      postRequiresOwnership: { type: Boolean, default: true },
      qualifyingItemDefinitionIds: { type: [ObjectId], default: [] },
      minReputation: { type: Number, default: 0 },
    },
    channels: {
      type: [{ _id: false, key: String, name: String, gated: Boolean, badgeRequired: String }],
      default: () => [{ key: 'general', name: 'General', gated: false }],
    },
    counters: {
      members: { type: Number, default: 0 },
      posts: { type: Number, default: 0 },
    },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true },
);

export const ClubModel = model('Club', clubSchema, 'clubs');
