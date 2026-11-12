import { Schema, model } from './model-helpers.js';

const sequenceSchema = new Schema({ key: { type: String, required: true, unique: true }, value: { type: Number, default: 0 } });
export const SequenceModel = model('Sequence', sequenceSchema, 'sequences');

const jobRunSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    queue: { type: String, required: true },
    status: { type: String, enum: ['running', 'done', 'failed'], default: 'running' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
jobRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
export const JobRunModel = model('JobRun', jobRunSchema, 'jobRuns');

// Lease lock so only one process runs each scheduled job at a time.
const jobLockSchema = new Schema({
  name: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  lockedUntil: { type: Date, required: true },
  lastRunAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  lastDurationMs: { type: Number, default: null },
});
export const JobLockModel = model('JobLock', jobLockSchema, 'jobLocks');

const rateBucketSchema = new Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  resetAt: { type: Date, required: true },
});
rateBucketSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });
export const RateBucketModel = model('RateBucket', rateBucketSchema, 'rateBuckets');

export async function nextSequence(key, session) {
  const doc = await SequenceModel.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { upsert: true, new: true, session },
  ).lean();
  return doc.value;
}
