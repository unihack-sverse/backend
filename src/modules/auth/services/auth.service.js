import { createHash } from 'node:crypto';

import { chainAdapter } from '../../../adapters/chain/index.js';
import { mailer } from '../../../adapters/mailer/console-mailer.js';
import { env } from '../../../config/env.js';
import { nextSequence } from '../../../db/system-models.js';
import { AppError, BadRequest, Conflict, Forbidden, Unauthorized } from '../../../lib/errors.js';
import { randomToken } from '../../../lib/hmac.js';
import { publicId } from '../../../lib/ids.js';
import { signJwt } from '../../../lib/jwt.js';
import { hashPassword, needsRehash, verifyPassword } from '../../../lib/password.js';
import { withTransaction } from '../../../lib/transaction.js';
import { ledgerService } from '../../ledger/services/ledger.service.js';
import { AuthTokenModel, RefreshTokenModel, UserModel } from '../models/index.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export const authService = {
  async register({ handle, email, password, referralCode }, context = {}) {
    assertPasswordStrength(password);
    const normalizedHandle = handle.toLowerCase();
    const normalizedEmail = email.toLowerCase();

    if (await UserModel.exists({ handle: normalizedHandle })) throw Conflict('handle_taken');
    if (await UserModel.exists({ email: normalizedEmail })) throw Conflict('email_taken');

    const passwordHash = await hashPassword(password);
    const user = await withTransaction(async (session) => {
      const custodyIndex = await nextSequence('custody:user', session);
      let custodialAddress;
      try {
        ({ address: custodialAddress } = await chainAdapter().createAccount({ kind: 'user', index: custodyIndex }));
      } catch {
        // UC-01 Alt 4a: no user, no account.
        throw new AppError('chain_unavailable', 503);
      }
      const [created] = await UserModel.create(
        [
          {
            pid: publicId('usr'),
            handle: normalizedHandle,
            handleRaw: handle,
            email: normalizedEmail,
            passwordHash,
            custodialAddress,
            custodyIndex,
            roles: ['player'],
            referral: { code: `${normalizedHandle.slice(0, 8)}${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}` },
            signupIpHash: context.ipHash ?? null,
            signupUaHash: context.uaHash ?? null,
          },
        ],
        { session },
      );
      await ledgerService.createAccount({ ownerType: 'user', ownerId: created._id, purpose: 'wallet' }, session);
      return created;
    });

    if (referralCode) await context.onReferral?.(user, referralCode);
    await this.sendVerification(user);
    return user.toObject();
  },

  async login({ email, password }) {
    const user = await UserModel.findOne({ email: email.toLowerCase() }).select('+passwordHash').lean();
    // Same error for unknown email and wrong password (T03 acceptance).
    if (!user || user.status === 'deleted' || !(await verifyPassword(password, user.passwordHash))) {
      throw Unauthorized('invalid_credentials');
    }
    if (user.status === 'suspended') throw Forbidden('account_suspended');

    const update = { lastSeenAt: new Date() };
    if (needsRehash(user.passwordHash)) update.passwordHash = await hashPassword(password);
    await UserModel.updateOne({ _id: user._id }, { $set: update });
    return user;
  },

  async issueSession(user, context = {}, family = publicId('fam')) {
    const accessToken = signJwt({ sub: user.pid, typ: 'access' }, env.JWT_ACCESS_SECRET, ACCESS_TTL_SECONDS);
    const refreshToken = randomToken(48);
    await RefreshTokenModel.create({
      pid: publicId('rft'),
      userId: user._id,
      family,
      tokenHash: hashToken(refreshToken),
      userAgent: String(context.userAgent ?? '').slice(0, 200),
      ipHash: context.ipHash ?? '',
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    });
    return { accessToken, refreshToken };
  },

  /** Rotation with theft detection: reusing a spent token revokes the whole family (UC-02 §4). */
  async refresh(refreshToken, context = {}) {
    if (!refreshToken) throw Unauthorized('missing_refresh_token');
    const tokenHash = hashToken(refreshToken);
    const now = new Date();
    const record = await RefreshTokenModel.findOneAndUpdate(
      { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { new: false },
    ).lean();

    if (!record) {
      const known = await RefreshTokenModel.findOne({ tokenHash }).lean();
      if (known) {
        await RefreshTokenModel.updateMany({ userId: known.userId, family: known.family }, { $set: { revokedAt: now } });
        throw Unauthorized('refresh_token_reused');
      }
      throw Unauthorized('invalid_refresh_token');
    }

    const user = await UserModel.findById(record.userId).lean();
    if (!user || user.status !== 'active') throw Unauthorized('invalid_refresh_token');
    return { user, ...(await this.issueSession(user, context, record.family)) };
  },

  async logout(refreshToken) {
    if (!refreshToken) return;
    const record = await RefreshTokenModel.findOne({ tokenHash: hashToken(refreshToken) }).lean();
    if (record) {
      await RefreshTokenModel.updateMany({ userId: record.userId, family: record.family }, { $set: { revokedAt: new Date() } });
    }
  },

  async sendVerification(user) {
    const token = await createAuthToken(user._id, 'email_verify', 48 * 3600);
    await mailer.send({ to: user.email, template: 'verify_email', vars: { link: `${env.APP_BASE_URL}/verify-email?token=${token}` } });
    return token;
  },

  async verifyEmail(token) {
    const record = await consumeAuthToken(token, 'email_verify');
    await UserModel.updateOne({ _id: record.userId }, { $set: { emailVerified: true } });
    return { emailVerified: true };
  },

  async forgotPassword(email) {
    const user = await UserModel.findOne({ email: email.toLowerCase(), status: 'active' }).lean();
    // Always succeeds so the endpoint cannot be used to enumerate accounts.
    if (!user) return { ok: true };
    const token = await createAuthToken(user._id, 'password_reset', 3600);
    await mailer.send({ to: user.email, template: 'password_reset', vars: { link: `${env.APP_BASE_URL}/reset-password?token=${token}` } });
    return { ok: true };
  },

  async resetPassword(token, password) {
    assertPasswordStrength(password);
    const record = await consumeAuthToken(token, 'password_reset');
    await UserModel.updateOne({ _id: record.userId }, { $set: { passwordHash: await hashPassword(password) } });
    await RefreshTokenModel.updateMany({ userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { ok: true };
  },
};

export function hashToken(token) {
  return `sha256:${createHash('sha256').update(String(token)).digest('hex')}`;
}

function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9\W_]/.test(password)) {
    throw BadRequest('weak_password', { message: 'Password must be at least 10 characters with a letter and a digit or symbol.' });
  }
}

async function createAuthToken(userId, purpose, ttlSeconds) {
  const token = randomToken(32);
  await AuthTokenModel.create({
    userId,
    purpose,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
  return token;
}

async function consumeAuthToken(token, purpose) {
  const record = await AuthTokenModel.findOneAndUpdate(
    { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  ).lean();
  if (!record) throw BadRequest('invalid_token');
  return record;
}
