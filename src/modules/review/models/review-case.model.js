import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const reviewCaseSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['game_submission', 'deed_mismatch', 'fraud', 'infringement'], default: 'game_submission' },
    gameId: { type: ObjectId, default: null },
    studioId: { type: ObjectId, required: true },
    submissionNo: { type: Number, default: 0 },
    subjectRef: { type: String, default: null },
    checks: [{ _id: false, name: String, status: { type: String, enum: ['pending', 'passed', 'flagged'] }, evidence: Schema.Types.Mixed }],
    outcome: { type: String, enum: ['pending', 'auto_approved', 'approved', 'rejected', 'escalated', 'upheld', 'dismissed'], default: 'pending' },
    reason: { type: String, default: null },
    reviewedBy: { type: ObjectId, default: null },
    reviewedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reviewCaseSchema.index({ outcome: 1, createdAt: -1 });
reviewCaseSchema.index({ gameId: 1, submissionNo: -1 });
reviewCaseSchema.index({ subjectRef: 1 }, { unique: true, partialFilterExpression: { subjectRef: { $type: 'string' } } });

export const ReviewCaseModel = model('ReviewCase', reviewCaseSchema, 'reviewCases');
