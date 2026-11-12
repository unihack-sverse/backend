import { z } from 'zod';

import { AppError } from '../lib/errors.js';

/** Validates and replaces `req.body|query|params` with parsed values (08 §4). */
export function validate(schema) {
  return (req, _res, next) => {
    const details = [];
    for (const part of ['params', 'query', 'body', 'headers']) {
      if (!schema[part]) continue;
      const result = schema[part].safeParse(req[part] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          details.push({ field: [part === 'body' ? null : part, ...issue.path].filter(Boolean).join('.'), issue: issue.message });
        }
        continue;
      }
      if (part === 'query') {
        Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
      } else if (part !== 'headers') {
        req[part] = result.data;
      }
    }
    if (details.length) {
      return next(new AppError('validation_failed', 400, { message: 'Request validation failed.', details }));
    }
    return next();
  };
}

export const publicIdOf = (prefix) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z_-]{3,40}$`), `must be a ${prefix}_ id`);

export const unitsString = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value))
  .refine((value) => /^\d+$/.test(value) && value.length <= 19, 'must be a non-negative integer string of units')
  .transform((value) => BigInt(value));

export const positiveUnits = unitsString.refine((value) => value > 0n, 'must be greater than zero');

/** http(s) only — `z.string().url()` alone would accept `javascript:` URLs (stored XSS). */
export const httpUrl = z
  .string()
  .max(500)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');

/** Same, but also allows site-relative asset paths and the empty string. */
export const assetUrl = z
  .string()
  .max(500)
  .refine((value) => value === '' || value.startsWith('/') || /^https?:\/\//i.test(value), 'must be an http(s) URL or a /path');

export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be an EVM address');
