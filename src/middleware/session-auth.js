import { env } from '../config/env.js';
import { Forbidden, NotFound, Unauthorized } from '../lib/errors.js';
import { verifyJwt } from '../lib/jwt.js';
import { UserModel } from '../modules/auth/models/index.js';
import { StudioModel } from '../modules/studios/models/index.js';

export const ACCESS_COOKIE = 'sv_at';
export const REFRESH_COOKIE = 'sv_rt';

/** Resolves `req.user` from the access cookie (or a Bearer access token) without rejecting. */
export async function attachSession(req, _res, next) {
  try {
    req.user = null;
    const token = req.cookies?.[ACCESS_COOKIE] ?? bearerAccessToken(req);
    if (!token) return next();
    const payload = verifyJwt(token, env.JWT_ACCESS_SECRET);
    if (!payload || payload.typ !== 'access') return next();
    const user = await UserModel.findOne({ pid: payload.sub }).lean();
    if (!user || user.status === 'deleted') return next();
    const studio = user.studioId ? await StudioModel.findById(user.studioId).lean() : null;
    req.user = { ...user, id: user.pid, studio };
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireSession(req, _res, next) {
  if (!req.user) return next(Unauthorized('missing_session'));
  if (req.user.status === 'suspended') return next(Forbidden('account_suspended'));
  return next();
}

export function requireCreator(req, _res, next) {
  if (!req.user) return next(Unauthorized('missing_session'));
  if (!req.user.studio) return next(Forbidden('creator_required'));
  if (req.user.studio.status !== 'active') return next(Forbidden('studio_suspended'));
  return next();
}

/** Admin surfaces answer 404 to non-staff so the console's existence is not revealed (04 §2). */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user?.roles?.some((role) => roles.includes(role) || role === 'admin')) return next(NotFound());
    return next();
  };
}

function bearerAccessToken(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.startsWith('Bearer sk_')) return null;
  return header.slice(7);
}
