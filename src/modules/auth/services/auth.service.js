import { createHash, randomBytes } from 'node:crypto';

import { ethers } from 'ethers';

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
import { AuthTokenModel, RefreshTokenModel, UserModel, WalletChallengeModel } from '../models/index.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const FUJI_CHAIN_ID = 43113;
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const authService = {
  async register({ handle, email, password, referralCode }, context = {}) {
    assertPasswordStrength(password);
    const normalizedHandle = handle.toLowerCase();
    const normalizedEmail = email.toLowerCase();

    if (await UserModel.exists({ handle: normalizedHandle })) throw Conflict('handle_taken');
    if (await UserModel.exists({ email: normalizedEmail })) throw Conflict('email_taken');

    const passwordHash = await hashPassword(password);
    const user = await provisionUser({
      pid: publicId('usr'),
      handle: normalizedHandle,
      handleRaw: handle,
      email: normalizedEmail,
      passwordHash,
      roles: ['player'],
      referral: { code: referralCodeFor(normalizedHandle) },
      signupIpHash: context.ipHash ?? null,
      signupUaHash: context.uaHash ?? null,
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

  async createWalletChallenge({ address, chainId = FUJI_CHAIN_ID, purpose = 'login' }) {
    if (chainId !== FUJI_CHAIN_ID) {
      throw BadRequest('unsupported_chain', { message: 'Only Avalanche Fuji Testnet (chainId 43113) is supported.' });
    }
    const walletAddress = normalizeWalletAddress(address);
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + WALLET_CHALLENGE_TTL_MS);
    const message = buildSiweMessage({ address: walletAddress, chainId: FUJI_CHAIN_ID, nonce, purpose, issuedAt, expiresAt });

    await WalletChallengeModel.create({
      nonce,
      walletAddress,
      chainId: FUJI_CHAIN_ID,
      purpose,
      message,
      expiresAt,
    });

    return { nonce, message, chainId: FUJI_CHAIN_ID, address: walletAddress, expiresAt };
  },

  async walletVerify({ address, signature, nonce, handle, referralCode }, context = {}) {
    const walletAddress = await consumeAndVerifyWalletChallenge({ address, signature, nonce, purpose: 'login' });

    const existing = await UserModel.findOne({ walletAddress }).lean();
    if (existing) {
      if (existing.status === 'deleted') throw Unauthorized('invalid_credentials');
      if (existing.status === 'suspended') throw Forbidden('account_suspended');
      await UserModel.updateOne({ _id: existing._id }, { $set: { lastSeenAt: new Date(), walletChainId: FUJI_CHAIN_ID } });
      return existing;
    }

    const { normalizedHandle, handleRaw } = await resolveWalletHandle(walletAddress, handle);
    let user;
    try {
      user = await provisionUser({
        pid: publicId('usr'),
        handle: normalizedHandle,
        handleRaw,
        emailVerified: false,
        walletAddress,
        walletChainId: FUJI_CHAIN_ID,
        roles: ['player'],
        referral: { code: referralCodeFor(normalizedHandle) },
        signupIpHash: context.ipHash ?? null,
        signupUaHash: context.uaHash ?? null,
      });
    } catch (error) {
      if (error?.code === 11000 && error?.keyPattern?.handle && handle) throw Conflict('handle_taken');
      throw error;
    }

    if (referralCode) await context.onReferral?.(user, referralCode);
    return user.toObject();
  },

  async walletLink(user, { address, signature, nonce }) {
    const walletAddress = await consumeAndVerifyWalletChallenge({ address, signature, nonce, purpose: 'link' });

    if (await UserModel.exists({ walletAddress, _id: { $ne: user._id } })) {
      throw Conflict('wallet_taken');
    }
    const current = await UserModel.findById(user._id).select('walletAddress status').lean();
    if (!current || current.status === 'deleted') throw Unauthorized('missing_session');
    if (current.walletAddress && current.walletAddress !== walletAddress) {
      throw Conflict('wallet_already_linked');
    }

    try {
      const updated = await UserModel.findOneAndUpdate(
        { _id: user._id, $or: [{ walletAddress: null }, { walletAddress: { $exists: false } }, { walletAddress }] },
        { $set: { walletAddress, walletChainId: FUJI_CHAIN_ID } },
        { new: true },
      ).lean();
      if (!updated) throw Conflict('wallet_already_linked');
      return updated;
    } catch (error) {
      if (error?.code === 11000) throw Conflict('wallet_taken');
      throw error;
    }
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
    if (!user?.email) throw BadRequest('email_not_set');
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

async function provisionUser(userFields) {
  return withTransaction(async (session) => {
    const custodyIndex = await nextSequence('custody:user', session);
    let custodialAddress;
    try {
      ({ address: custodialAddress } = await chainAdapter().createAccount({ kind: 'user', index: custodyIndex }));
    } catch {
      // UC-01 Alt 4a: no user, no account.
      throw new AppError('chain_unavailable', 503);
    }
    const [created] = await UserModel.create([{ ...userFields, custodialAddress, custodyIndex }], { session });
    await ledgerService.createAccount({ ownerType: 'user', ownerId: created._id, purpose: 'wallet' }, session);
    return created;
  });
}

function referralCodeFor(normalizedHandle) {
  return `${normalizedHandle.slice(0, 8)}${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

function normalizeWalletAddress(address) {
  try {
    return ethers.getAddress(address);
  } catch {
    throw BadRequest('invalid_wallet_address');
  }
}

function buildSiweMessage({ address, chainId, nonce, purpose, issuedAt, expiresAt }) {
  const baseUrl = env.APP_BASE_URL.replace(/\/$/, '');
  let domain = 'localhost:3000';
  try {
    domain = new URL(baseUrl).host || domain;
  } catch {
    // Fallback when APP_BASE_URL is configured as a bare host/path.
  }
  const statement =
    purpose === 'link'
      ? 'Link this wallet to your Sverse Passport on Avalanche Fuji Testnet. No gas fee.'
      : 'Sign in to Sverse Passport on Avalanche Fuji Testnet. No gas fee.';
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${baseUrl}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join('\n');
}

async function consumeAndVerifyWalletChallenge({ address, signature, nonce, purpose }) {
  const walletAddress = normalizeWalletAddress(address);
  const now = new Date();
  const challenge = await WalletChallengeModel.findOneAndUpdate(
    { nonce, walletAddress, chainId: FUJI_CHAIN_ID, purpose, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: false },
  ).lean();
  if (!challenge) throw Unauthorized('invalid_wallet_challenge');

  let recovered;
  try {
    recovered = ethers.getAddress(ethers.verifyMessage(challenge.message, signature));
  } catch {
    throw Unauthorized('invalid_wallet_signature');
  }
  if (recovered !== walletAddress) throw Unauthorized('invalid_wallet_signature');
  return walletAddress;
}

async function resolveWalletHandle(walletAddress, requestedHandle) {
  if (requestedHandle) {
    const normalizedHandle = requestedHandle.toLowerCase();
    if (await UserModel.exists({ handle: normalizedHandle })) throw Conflict('handle_taken');
    return { normalizedHandle, handleRaw: requestedHandle };
  }
  const baseHandle = `sve_${walletAddress.slice(2, 8).toLowerCase()}`;
  if (!(await UserModel.exists({ handle: baseHandle }))) {
    return { normalizedHandle: baseHandle, handleRaw: baseHandle };
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${baseHandle}_${randomBytes(2).toString('hex')}`;
    if (!(await UserModel.exists({ handle: candidate }))) {
      return { normalizedHandle: candidate, handleRaw: candidate };
    }
  }
  const fallback = `${baseHandle}_${randomBytes(4).toString('hex')}`;
  return { normalizedHandle: fallback, handleRaw: fallback };
}
