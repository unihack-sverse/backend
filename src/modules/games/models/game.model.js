import { ObjectId, Schema, Units, model } from '../../../db/model-helpers.js';
import { GENRES, INTEROP_TIERS, TOKENIZATION_LEVELS, levelIndex } from '../../../config/constants.js';
import { AppError } from '../../../lib/errors.js';

const gameSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    title: { type: String, required: true },
    blurb: { type: String, default: '' },
    description: { type: String, default: '' },
    genre: { type: String, enum: GENRES, required: true },
    coverArt: {
      url: { type: String, default: '' },
      gradient: { type: String, default: '#7b2ff7,#e935c1' },
      emoji: { type: String, default: '🎮' },
    },
    media: [{ url: String, kind: { type: String, enum: ['screenshot', 'video'] }, order: Number }],
    buildType: { type: String, enum: ['web', 'native', 'miniapp'], default: 'web' },
    buildUrl: { type: String, default: '' },
    // Content fingerprints captured by the review scan (UC-20 ip_fingerprint).
    fingerprints: {
      build: { sha256: String, sizeBytes: Number, contentType: String, scannedAt: Date },
      cover: { sha256: String, sizeBytes: Number, contentType: String, scannedAt: Date },
    },
    tokenizationLevel: { type: String, enum: TOKENIZATION_LEVELS, default: 'L0' },
    interopTier: { type: String, enum: INTEROP_TIERS, default: 'T0' },
    clubId: { type: ObjectId, default: null },
    status: { type: String, enum: ['draft', 'in_review', 'live', 'rejected', 'delisted'], default: 'draft' },
    submissionNo: { type: Number, default: 0 },
    blockedReason: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    reviewCaseId: { type: ObjectId, default: null },
    priceFromUnits: Units,
    secondaryCount: { type: Number, default: 0 },
    stats: {
      playersLive: { type: Number, default: 0 },
      dau: { type: Number, default: 0 },
      mau: { type: Number, default: 0 },
      playtimeMinutes: { type: Number, default: 0 },
      grossUnits: Units,
      proofOfPlayScore: { type: Number, default: 0 },
      d1: { type: Number, default: 0 },
      d7: { type: Number, default: 0 },
      d30: { type: Number, default: 0 },
    },
    // 'seed' marks demo numbers that must never be presented as traction; real play flips it.
    statsSource: { type: String, enum: ['telemetry', 'seed'], default: 'telemetry' },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

gameSchema.index({ studioId: 1, status: 1 });
gameSchema.index({ status: 1, 'stats.proofOfPlayScore': -1, _id: -1 });
gameSchema.index({ status: 1, publishedAt: -1, _id: -1 });
gameSchema.index({ genre: 1, status: 1 });
gameSchema.index({ interopTier: 1, status: 1 });
gameSchema.index({ title: 'text', blurb: 'text' });
gameSchema.index({ 'fingerprints.build.sha256': 1 }, { sparse: true });
gameSchema.index({ 'fingerprints.cover.sha256': 1 }, { sparse: true });

gameSchema.post('init', function rememberLevel() {
  this.$locals.previousLevel = this.tokenizationLevel;
  this.$locals.previousSlug = this.slug;
  this.$locals.previousPublishedAt = this.publishedAt;
});

// Invariant 5 backstop: the service checks first, this guarantees no code path can bypass it.
gameSchema.pre('save', function enforceInvariants(next) {
  const previous = this.$locals.previousLevel;
  if (!this.isNew && previous && levelIndex(this.tokenizationLevel) < levelIndex(previous)) {
    return next(new AppError('level_downgrade_forbidden', 422));
  }
  if (!this.isNew && this.$locals.previousPublishedAt && this.slug !== this.$locals.previousSlug) {
    return next(new AppError('slug_immutable', 422));
  }
  return next();
});

gameSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function guardLevel(next) {
  const update = this.getUpdate() ?? {};
  const level = update.tokenizationLevel ?? update.$set?.tokenizationLevel;
  if (level !== undefined && !this.getOptions().allowLevelWrite) {
    return next(new AppError('level_write_requires_document_save', 500));
  }
  return next();
});

export const GameModel = model('Game', gameSchema, 'games');
