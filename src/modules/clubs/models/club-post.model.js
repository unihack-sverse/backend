import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const clubPostSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    clubId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    channel: { type: String, default: 'general' },
    authorUserId: { type: ObjectId, default: null },
    authorHandle: { type: String, default: null },
    kind: { type: String, enum: ['post', 'reply', 'deed_auto', 'patch_note'], default: 'post' },
    parentId: { type: ObjectId, default: null },
    body: { type: String, required: true },
    badges: { type: [String], default: [] },
    repAtPost: { type: Number, default: 0 },
    weight: { type: Number, default: 0 },
    score: { type: Number, default: 0 },
    reactions: {
      up: { type: Number, default: 0 },
      insightful: { type: Number, default: 0 },
    },
    replyCount: { type: Number, default: 0 },
    deedId: { type: ObjectId, default: null },
    reportCount: { type: Number, default: 0 },
    status: { type: String, enum: ['visible', 'hidden', 'removed'], default: 'visible' },
    moderatedBy: { type: ObjectId, default: null },
    moderationReason: { type: String, default: null },
  },
  { timestamps: true },
);

clubPostSchema.index({ clubId: 1, channel: 1, status: 1, score: -1 });
clubPostSchema.index({ clubId: 1, createdAt: -1 });
clubPostSchema.index({ parentId: 1, createdAt: 1 });
// Partial, not sparse: sparse indexes still collide on explicit nulls.
clubPostSchema.index({ deedId: 1 }, { unique: true, partialFilterExpression: { deedId: { $type: 'objectId' } } });
clubPostSchema.index({ status: 1, reportCount: -1 });
clubPostSchema.index({ authorUserId: 1, createdAt: -1 });

export const ClubPostModel = model('ClubPost', clubPostSchema, 'clubPosts');
