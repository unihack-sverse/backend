import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const publishStepSchema = new Schema(
  {
    step: { type: String, required: true },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed', 'skipped'], default: 'pending' },
    requiresApproval: { type: Boolean, default: false },
    output: { type: Schema.Types.Mixed, default: null },
    error: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { _id: false },
);

const publishJobSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    gameId: { type: ObjectId, required: true },
    createdByUserId: { type: ObjectId, default: null },
    mode: { type: String, enum: ['ai', 'manual'], default: 'ai' },
    catalogApproved: { type: Boolean, default: false },
    approvedByUserId: { type: ObjectId, default: null },
    draftCatalog: { type: [Schema.Types.Mixed], default: [] },
    steps: { type: [publishStepSchema], default: [] },
    status: { type: String, enum: ['running', 'done', 'failed'], default: 'running' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    elapsedMs: { type: Number, default: null },
  },
  { timestamps: true },
);

publishJobSchema.index({ studioId: 1, createdAt: -1 });
publishJobSchema.index({ gameId: 1, status: 1 });

export const PublishJobModel = model('PublishJob', publishJobSchema, 'publishJobs');
