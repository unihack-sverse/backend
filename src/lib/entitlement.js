import { env } from '../config/env.js';
import { signJwt, verifyJwt } from './jwt.js';

export const ENTITLEMENT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Offline-tolerant entitlement token. Games cache it and verify locally with the shared
 * entitlement key so gameplay never blocks on a network call.
 */
export function issueEntitlementToken({ passportId, gameId, entitlements }) {
  const token = signJwt(
    { typ: 'sverse.entitlement', sub: passportId, gam: gameId, ent: entitlements },
    env.ENTITLEMENT_SECRET,
    ENTITLEMENT_TTL_SECONDS,
  );
  return { token, expiresAt: new Date(Date.now() + ENTITLEMENT_TTL_SECONDS * 1000) };
}

export function verifyEntitlementToken(token) {
  const payload = verifyJwt(token, env.ENTITLEMENT_SECRET);
  if (!payload || payload.typ !== 'sverse.entitlement') return null;
  return payload;
}
