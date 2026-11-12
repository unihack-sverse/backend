import { isProduction } from '../../../config/env.js';
import { WEBHOOK_EVENTS } from '../../../config/constants.js';
import { eventBus } from '../../../lib/event-bus.js';
import { signWebhook } from '../../../lib/hmac.js';
import { publicId } from '../../../lib/ids.js';
import { logger } from '../../../lib/logger.js';
import { open } from '../../../lib/secret-box.js';
import { StudioModel, WebhookEndpointModel } from '../../studios/models/index.js';
import { WebhookDeliveryModel } from '../models/index.js';

const MAX_ATTEMPTS = 5;
const DISABLE_AFTER_STREAK = 20;
const TIMEOUT_MS = 8000;

export const webhooksService = {
  /** Fan-out of a domain event to every subscribed endpoint of the owning studio. */
  async fanOut(event, payload) {
    if (!WEBHOOK_EVENTS.includes(event) || !payload?.studioId) return 0;
    const endpoints = await WebhookEndpointModel.find({ studioId: payload.studioId, status: 'active', events: event }).lean();
    if (!endpoints.length) return 0;
    const eventId = publicId('evt');
    const body = { id: eventId, event, createdAt: new Date().toISOString(), livemode: isProduction, data: publicPayload(payload) };
    await WebhookDeliveryModel.insertMany(
      endpoints.map((endpoint) => ({
        pid: publicId('whd'),
        endpointId: endpoint._id,
        studioId: endpoint.studioId,
        event,
        eventId,
        payload: body,
      })),
      { ordered: false },
    ).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
    return endpoints.length;
  },

  /** At-least-once delivery with exponential backoff (1m → 16m), then dead-letter. */
  async deliverDue({ limit = 50, fetchImpl = fetch } = {}) {
    const due = await WebhookDeliveryModel.find({ status: { $in: ['pending', 'retrying'] }, nextRetryAt: { $lte: new Date() } })
      .sort({ nextRetryAt: 1 })
      .limit(limit)
      .lean();
    let delivered = 0;
    for (const delivery of due) {
      const endpoint = await WebhookEndpointModel.findById(delivery.endpointId).select('+signingSecretEnc').lean();
      if (!endpoint || endpoint.status !== 'active') {
        await WebhookDeliveryModel.updateOne({ _id: delivery._id }, { $set: { status: 'dead', lastError: 'endpoint_disabled' } });
        continue;
      }
      const rawBody = JSON.stringify(delivery.payload);
      let status = null;
      let error = null;
      try {
        assertSafeUrl(endpoint.url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const response = await fetchImpl(endpoint.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Sverse-Webhooks/1',
            'X-Sverse-Event': delivery.event,
            'X-Sverse-Delivery': delivery.pid,
            'X-Sverse-Signature': signWebhook(open(endpoint.signingSecretEnc), rawBody),
          },
          body: rawBody,
          signal: controller.signal,
          redirect: 'manual',
        });
        clearTimeout(timer);
        status = response.status;
      } catch (caught) {
        error = String(caught?.message ?? caught).slice(0, 300);
      }

      const attempts = delivery.attempts + 1;
      if (status && status >= 200 && status < 300) {
        delivered += 1;
        await WebhookDeliveryModel.updateOne({ _id: delivery._id }, { $set: { status: 'delivered', attempts, lastStatus: status, deliveredAt: new Date(), lastError: null } });
        await WebhookEndpointModel.updateOne({ _id: endpoint._id }, { $set: { failureStreak: 0 } });
        continue;
      }
      const dead = attempts >= MAX_ATTEMPTS;
      await WebhookDeliveryModel.updateOne(
        { _id: delivery._id },
        {
          $set: {
            status: dead ? 'dead' : 'retrying',
            attempts,
            lastStatus: status,
            lastError: error ?? `HTTP ${status}`,
            nextRetryAt: dead ? null : new Date(Date.now() + 60_000 * 2 ** (attempts - 1)),
          },
        },
      );
      const updated = await WebhookEndpointModel.findOneAndUpdate({ _id: endpoint._id }, { $inc: { failureStreak: 1 } }, { new: true }).lean();
      if (updated.failureStreak >= DISABLE_AFTER_STREAK) {
        await WebhookEndpointModel.updateOne({ _id: endpoint._id }, { $set: { status: 'disabled', disabledAt: new Date() } });
        logger.warn({ endpoint: endpoint.pid }, 'webhook_endpoint_disabled');
      }
    }
    return { attempted: due.length, delivered };
  },
};

export function assertSafeUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported_protocol');
  if (!isProduction) return;
  if (parsed.protocol !== 'https:') throw new Error('https_required');
  const host = parsed.hostname;
  // Block obvious SSRF targets in production: loopback, link-local, RFC1918, metadata services.
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$|.*\.internal$)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('private_address_blocked');
  }
}

function publicPayload(payload) {
  return JSON.parse(
    JSON.stringify(payload, (key, value) => {
      if (['studioId', 'deedObjectId', 'gameObjectId'].includes(key)) return undefined;
      if (typeof value === 'bigint') return value.toString();
      return value;
    }),
  );
}

eventBus.onAny(async (payload, event) => {
  if (!payload?.studioId && payload?.studioPid) {
    const studio = await StudioModel.findOne({ pid: payload.studioPid }).select('_id').lean();
    if (studio) payload = { ...payload, studioId: studio._id };
  }
  await webhooksService.fanOut(event, payload);
});
