import { createHash } from 'node:crypto';

import { BadRequest, Conflict } from '../lib/errors.js';
import { IdempotencyRecordModel } from '../modules/checkout/models/index.js';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `Idempotency-Key` replay (03 §2.4). The first response is stored and replayed verbatim for
 * 24h; a concurrent duplicate while the first is in flight gets `409 request_in_progress`.
 */
export function idempotency({ required = true } = {}) {
  return async (req, res, next) => {
    try {
      const rawKey = req.headers['idempotency-key'];
      if (!rawKey) {
        if (required) throw BadRequest('idempotency_key_required');
        return next();
      }
      if (String(rawKey).length < 8 || String(rawKey).length > 128) throw BadRequest('invalid_idempotency_key');

      const principal = req.user?.pid ?? req.apiKey?.pid ?? 'anon';
      const key = `${principal}:${req.method}:${req.baseUrl}${req.route?.path ?? req.path}:${rawKey}`;
      const fingerprint = createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');

      const existing = await IdempotencyRecordModel.findOne({ key }).lean();
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw Conflict('idempotency_key_reused');
        if (existing.status === 'in_flight') throw Conflict('request_in_progress');
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus).type('application/json').send(existing.responseBody);
        return undefined;
      }

      try {
        await IdempotencyRecordModel.create({ key, fingerprint, expiresAt: new Date(Date.now() + TTL_MS) });
      } catch (error) {
        if (error?.code === 11000) throw Conflict('request_in_progress');
        throw error;
      }

      req.idempotencyKey = String(rawKey);
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        const serialized = JSON.stringify(body);
        const status = res.statusCode;
        // Server errors are not cached so the client can retry with the same key.
        const save =
          status >= 500
            ? IdempotencyRecordModel.deleteOne({ key })
            : IdempotencyRecordModel.updateOne({ key }, { $set: { status: 'done', responseStatus: status, responseBody: serialized } });
        save.catch(() => {}).finally(() => originalJson(body));
        return res;
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
