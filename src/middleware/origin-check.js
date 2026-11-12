import { isCorsOriginAllowed } from '../config/env.js';
import { Forbidden } from '../lib/errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated writes: browsers always send `Origin` on cross-origin
 * requests, so an unsafe method from an origin outside the CORS allowlist is refused. Requests
 * without Origin (server-to-server, curl, SSR) are unaffected and carry no ambient cookies anyway.
 */
export function originCheck(req, _res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !isCorsOriginAllowed(origin)) return next(Forbidden('origin_not_allowed'));
  return next();
}
