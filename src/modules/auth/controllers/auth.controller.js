import { env, isProduction } from '../../../config/env.js';
import { sha256Hex } from '../../../lib/hmac.js';
import { sendData } from '../../../lib/respond.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../../middleware/session-auth.js';
import { passportService } from '../../passport/services/passport.service.js';
import { curationService } from '../../rewards/services/curation.service.js';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, authService } from '../services/auth.service.js';

export const authController = {
  async register(req, res) {
    const device = { ipHash: ipHash(req), uaHash: sha256Hex(String(req.headers['user-agent'] ?? '')).slice(0, 32) };
    const user = await authService.register(req.body, {
      ...device,
      onReferral: (created, code) => curationService.bindReferral({ referredUser: created, code, ...device }),
    });
    await startSession(req, res, user);
    sendData(res, await passportService.me(user._id), 201);
  },

  async login(req, res) {
    const user = await authService.login(req.body);
    await startSession(req, res, user);
    sendData(res, await passportService.me(user._id));
  },

  async walletChallenge(req, res) {
    sendData(res, await authService.createWalletChallenge(req.body));
  },

  async walletVerify(req, res) {
    const device = { ipHash: ipHash(req), uaHash: sha256Hex(String(req.headers['user-agent'] ?? '')).slice(0, 32) };
    const user = await authService.walletVerify(req.body, {
      ...device,
      onReferral: (created, code) => curationService.bindReferral({ referredUser: created, code, ...device }),
    });
    await startSession(req, res, user);
    sendData(res, await passportService.me(user._id));
  },

  async walletLink(req, res) {
    await authService.walletLink(req.user, req.body);
    sendData(res, await passportService.me(req.user._id));
  },

  async refresh(req, res) {
    try {
      const { user, accessToken, refreshToken } = await authService.refresh(req.cookies?.[REFRESH_COOKIE], context(req));
      setCookies(res, accessToken, refreshToken);
      sendData(res, { refreshed: true, userId: user.pid });
    } catch (error) {
      clearCookies(res);
      throw error;
    }
  },

  async logout(req, res) {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearCookies(res);
    sendData(res, { ok: true });
  },

  async me(req, res) {
    sendData(res, await passportService.me(req.user._id));
  },

  async forgotPassword(req, res) {
    sendData(res, await authService.forgotPassword(req.body.email));
  },

  async resetPassword(req, res) {
    sendData(res, await authService.resetPassword(req.body.token, req.body.password));
  },

  async verifyEmail(req, res) {
    sendData(res, await authService.verifyEmail(req.body.token));
  },

  async resendVerification(req, res) {
    if (!req.user.email || req.user.emailVerified) return sendData(res, { sent: false });
    await authService.sendVerification(req.user);
    return sendData(res, { sent: true });
  },
};

async function startSession(req, res, user) {
  const { accessToken, refreshToken } = await authService.issueSession(user, context(req));
  setCookies(res, accessToken, refreshToken);
}

function context(req) {
  return { userAgent: req.headers['user-agent'], ipHash: ipHash(req) };
}

export function ipHash(req) {
  return sha256Hex(`${req.ip}:${env.WEBHOOK_SIGNING_PEPPER}`).slice(0, 32);
}

function cookieOptions(maxAgeSeconds, path = '/') {
  return {
    httpOnly: true,
    sameSite: env.COOKIE_SAMESITE,
    secure: env.COOKIE_SECURE || isProduction,
    domain: env.COOKIE_DOMAIN || undefined,
    maxAge: maxAgeSeconds * 1000,
    path,
  };
}

function setCookies(res, accessToken, refreshToken) {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_TTL_SECONDS));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_TTL_SECONDS, '/api/v1/auth'));
}

function clearCookies(res) {
  const { maxAge: _a, ...access } = cookieOptions(0);
  const { maxAge: _r, ...refresh } = cookieOptions(0, '/api/v1/auth');
  res.clearCookie(ACCESS_COOKIE, access);
  res.clearCookie(REFRESH_COOKIE, refresh);
  res.clearCookie('sv_demo_uid');
}
