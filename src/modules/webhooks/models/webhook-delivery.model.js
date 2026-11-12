import { ObjectId, Schema, model } from '../../../db/model-helpers.js';

const webhookDeliverySchema = new Schema(
  {
    pid: { type: String, required: true, unique: true },
    endpointId: { type: ObjectId, required: true },
    studioId: { type: ObjectId, required: true },
    event: { type: String, required: true },
    eventId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, default: 0 },
    lastStatus: { type: Number, default: null },
    lastError: { type: String, default: null },
    nextRetryAt: { type: Date, default: () => new Date() },
    status: { type: String, enum: ['pending', 'retrying', 'delivered', 'dead'], default: 'pending' },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

webhookDeliverySchema.index({ eventId: 1, endpointId: 1 }, { unique: true });
webhookDeliverySchema.index({ status: 1, nextRetryAt: 1 });
webhookDeliverySchema.index({ studioId: 1, createdAt: -1 });
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

export const WebhookDeliveryModel = model('WebhookDelivery', webhookDeliverySchema, 'webhookDeliveries');
