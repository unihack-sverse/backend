import { ObjectId, Schema, model } from '../../../db/model-helpers.js';
import { WEBHOOK_EVENTS } from '../../../config/constants.js';

const webhookEndpointSchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    studioId: { type: ObjectId, required: true },
    url: { type: String, required: true },
    signingSecretEnc: { type: String, required: true, select: false },
    signingSecretPrefix: { type: String, required: true },
    events: { type: [String], enum: WEBHOOK_EVENTS, default: ['purchase.completed'] },
    status: { type: String, enum: ['active', 'disabled', 'deleted'], default: 'active' },
    failureStreak: { type: Number, default: 0 },
    disabledAt: { type: Date, default: null },
  },
  { timestamps: true },
);

webhookEndpointSchema.index({ studioId: 1, status: 1 });

export const WebhookEndpointModel = model('WebhookEndpoint', webhookEndpointSchema, 'webhookEndpoints');
