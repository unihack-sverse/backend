import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

// One reaction (and one report) per user per post keeps counters honest under retries.
const clubReactionSchema = new Schema(
  {
    postId: { type: ObjectId, required: true },
    userId: { type: ObjectId, required: true },
    kind: { type: String, enum: ['up', 'insightful', 'report'], required: true },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

clubReactionSchema.index({ postId: 1, userId: 1, kind: 1 }, { unique: true });

export const ClubReactionModel = model('ClubReaction', clubReactionSchema, 'clubReactions');
