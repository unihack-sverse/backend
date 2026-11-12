import { RateLimited } from '../lib/errors.js';
import { RateBucketModel } from '../db/system-models.js';
import { env } from '../config/env.js';

const memory = new Map();

/**
 * Fixed-window limiter. `durable: true` counts in Mongo (survives restarts, shared across
 * instances) — used for auth abuse limits. Others count in-process memory.
 */
export function rateLimit({ name, limit, windowMs, key, durable = false }) {
  return async (req, res, next) => {
    try {
      if (env.NODE_ENV === 'test' && !req.headers['x-test-rate-limit']) return next();
      const id = key(req);
      if (!id) return next();
      const bucketKey = `${name}:${id}`;
      const { count, resetAt } = durable ? await hitDurable(bucketKey, windowMs) : hitMemory(bucketKey, windowMs);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
      if (count > limit) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        throw RateLimited(name === 'login' ? 'too_many_attempts' : 'rate_limited', { retryAfter });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export async function hitDurable(bucketKey, windowMs) {
  const now = Date.now();
  const doc = await RateBucketModel.findOneAndUpdate(
    { key: bucketKey, resetAt: { $gt: new Date(now) } },
    { $inc: { count: 1 } },
    { new: true },
  ).lean();
  if (doc) return { count: doc.count, resetAt: doc.resetAt.getTime() };
  const resetAt = new Date(now + windowMs);
  const fresh = await RateBucketModel.findOneAndUpdate(
    { key: bucketKey },
    { $set: { count: 1, resetAt } },
    { upsert: true, new: true },
  ).lean();
  return { count: fresh.count, resetAt: fresh.resetAt.getTime() };
}

function hitMemory(bucketKey, windowMs) {
  const now = Date.now();
  const bucket = memory.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    memory.set(bucketKey, fresh);
    if (memory.size > 50_000) pruneMemory(now);
    return fresh;
  }
  bucket.count += 1;
  return bucket;
}

function pruneMemory(now) {
  for (const [key, bucket] of memory) if (bucket.resetAt <= now) memory.delete(key);
}

export const byIp = (req) => req.ip;
export const byUser = (req) => req.user?.pid ?? null;
export const byUserOrIp = (req) => req.user?.pid ?? req.ip;
export const byApiKey = (req) => req.apiKey?.pid ?? null;
