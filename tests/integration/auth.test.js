import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import request from 'supertest';

import { app, registerPlayer, server, unique } from '../helpers.js';
import { UserModel, WalletChallengeModel } from '../../src/modules/auth/models/index.js';
import { authService } from '../../src/modules/auth/services/auth.service.js';
import { AccountModel } from '../../src/modules/ledger/models/index.js';
import { mailer } from '../../src/adapters/mailer/console-mailer.js';

function cookie(res, name) {
  return (res.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`))?.split(';')[0];
}

async function challengeAndSign(wallet, { agent = request(server), address = wallet.address, chainId = 43113, purpose = 'login' } = {}) {
  const challengeRes = await agent.post('/api/v1/auth/wallet/challenge').send({ address, chainId, purpose });
  expect(challengeRes.status).toBe(200);
  const signature = await wallet.signMessage(challengeRes.body.data.message);
  return { challenge: challengeRes.body.data, signature };
}

describe('auth (UC-01, UC-02)', () => {
  it('registers a passport with a custodial EVM address and a zero wallet', async () => {
    const handle = unique('a');
    const res = await request(app).post('/api/v1/auth/register').send({ handle, email: `${handle}@x.dev`, password: 'correct-horse-9' });
    expect(res.status).toBe(201);
    expect(res.body.data.custodialAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(res.body.data.balanceUnits).toBe('0');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(cookie(res, 'sv_at')).toBeTruthy();
    expect(cookie(res, 'sv_rt')).toBeTruthy();
  });

  it('rejects duplicates and weak passwords', async () => {
    const { handle } = await registerPlayer();
    const dup = await request(app).post('/api/v1/auth/register').send({ handle, email: `${unique('e')}@x.dev`, password: 'correct-horse-9' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('handle_taken');
    const dupEmail = await request(app).post('/api/v1/auth/register').send({ handle: unique('h'), email: `${handle}@test.dev`, password: 'correct-horse-9' });
    expect(dupEmail.body.error.code).toBe('email_taken');
    const weak = await request(app).post('/api/v1/auth/register').send({ handle: unique('w'), email: `${unique('w')}@x.dev`, password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('weak_password');
  });

  it('answers unknown email and wrong password identically', async () => {
    const { handle } = await registerPlayer();
    const wrong = await request(app).post('/api/v1/auth/login').send({ email: `${handle}@test.dev`, password: 'nope-nope-1' });
    const unknown = await request(app).post('/api/v1/auth/login').send({ email: `${unique('z')}@test.dev`, password: 'nope-nope-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('invalid_credentials');
    expect(unknown.body.error.code).toBe('invalid_credentials');
  });

  it('locks out after 5 failed logins (429 too_many_attempts)', async () => {
    const { handle } = await registerPlayer();
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app).post('/api/v1/auth/login').set('x-test-rate-limit', '1').send({ email: `${handle}@test.dev`, password: 'wrong-pass-1' });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('too_many_attempts');
    expect(last.headers['retry-after']).toBeTruthy();
  });

  it('rotates refresh tokens and revokes the whole family on reuse', async () => {
    const handle = unique('r');
    const reg = await request(app).post('/api/v1/auth/register').send({ handle, email: `${handle}@x.dev`, password: 'correct-horse-9' });
    const first = cookie(reg, 'sv_rt');
    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(rotated.status).toBe(200);
    const second = cookie(rotated, 'sv_rt');
    expect(second).not.toBe(first);

    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('refresh_token_reused');
    // The legitimate newest token is revoked too: theft detection kills the family.
    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', second);
    expect(after.status).toBe(401);
  });

  it('verifies email and resets password with single-use tokens', async () => {
    const { handle, user } = await registerPlayer();
    const verifyMail = mailer.outbox.filter((mail) => mail.to === user.email && mail.template === 'verify_email').at(-1);
    const token = new URL(verifyMail.vars.link).searchParams.get('token');
    expect((await request(app).post('/api/v1/auth/email/verify').send({ token })).status).toBe(200);
    expect((await UserModel.findById(user._id).lean()).emailVerified).toBe(true);
    expect((await request(app).post('/api/v1/auth/email/verify').send({ token })).status).toBe(400);

    await request(app).post('/api/v1/auth/password/forgot').send({ email: `${handle}@test.dev` });
    const resetMail = mailer.outbox.filter((mail) => mail.to === user.email && mail.template === 'password_reset').at(-1);
    const resetToken = new URL(resetMail.vars.link).searchParams.get('token');
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token: resetToken, password: 'brand-new-pass-7' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email: `${handle}@test.dev`, password: 'brand-new-pass-7' })).status).toBe(200);
  });

  it('requires a session for passport routes', async () => {
    const res = await request(app).get('/api/v1/passport/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('missing_session');
  });
});

describe('web security', () => {
  it('refuses cookie-authenticated writes from origins outside the allowlist', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
    const ok = await request(app).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000').send({ email: 'a@b.co', password: 'x' });
    expect(ok.status).toBe(401);
  });

  it('rejects javascript: URLs for game builds', async () => {
    const { createLiveGame } = await import('../helpers.js');
    const { creator, game } = await createLiveGame();
    const res = await creator.agent.patch(`/api/v1/games/${game.pid}`).send({ buildUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });
});

describe('Avalanche Fuji wallet auth, linking & handle editing', () => {
  it('logs in a new wallet user with @sve_<6hex>, custodialAddress, ledger wallet, and HTTP-only cookies', async () => {
    const wallet = ethers.Wallet.createRandom();
    const lowercaseAddress = wallet.address.toLowerCase();
    const challengeRes = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: lowercaseAddress });
    expect(challengeRes.status).toBe(200);

    const { nonce, message, chainId, address, expiresAt } = challengeRes.body.data;
    expect(chainId).toBe(43113);
    expect(address).toBe(wallet.address);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(message).toContain(wallet.address);
    expect(message).toContain('Chain ID: 43113');
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain('Issued At:');
    expect(message).toContain('Expiration Time:');
    expect(message).toContain('No gas fee');

    const agent = request.agent(server);
    const signature = await wallet.signMessage(message);
    const verifyRes = await agent.post('/api/v1/auth/wallet/verify').send({ address: lowercaseAddress, signature, nonce });
    expect(verifyRes.status).toBe(200);

    const expectedHandle = `sve_${wallet.address.slice(2, 8).toLowerCase()}`;
    expect(verifyRes.body.data).toMatchObject({
      handle: expectedHandle,
      displayHandle: expectedHandle,
      email: null,
      emailVerified: false,
      walletAddress: wallet.address,
      walletChainId: 43113,
      balanceUnits: '0',
    });
    expect(verifyRes.body.data.custodialAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(JSON.stringify(verifyRes.body)).not.toContain('passwordHash');
    expect(cookie(verifyRes, 'sv_at')).toBeTruthy();
    expect(cookie(verifyRes, 'sv_rt')).toBeTruthy();

    const dbUser = await UserModel.findOne({ pid: verifyRes.body.data.id }).lean();
    expect(dbUser.email).toBeUndefined();
    expect(dbUser.walletAddress).toBe(wallet.address);
    expect(dbUser.walletChainId).toBe(43113);
    const ledgerWallet = await AccountModel.findOne({ ownerType: 'user', ownerId: dbUser._id, purpose: 'wallet' }).lean();
    expect(ledgerWallet).toBeTruthy();

    const meRes = await agent.get('/api/v1/passport/me');
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.id).toBe(verifyRes.body.data.id);
  });

  it('supports optional custom handle & referralCode on verify, rejects taken handle, and appends suffix on auto-handle collision', async () => {
    const referrer = await registerPlayer();
    const refCode = (await UserModel.findById(referrer.user._id).lean()).referral.code;

    const customWallet = ethers.Wallet.createRandom();
    const customHandle = `Hero_${unique('w').slice(0, 12)}`;
    const first = await challengeAndSign(customWallet);
    const verifyCustom = await request(app)
      .post('/api/v1/auth/wallet/verify')
      .send({ address: customWallet.address, signature: first.signature, nonce: first.challenge.nonce, handle: customHandle, referralCode: refCode });
    expect(verifyCustom.status).toBe(200);
    expect(verifyCustom.body.data.handle).toBe(customHandle.toLowerCase());
    expect(verifyCustom.body.data.displayHandle).toBe(customHandle);
    const createdCustom = await UserModel.findOne({ pid: verifyCustom.body.data.id }).lean();
    expect(String(createdCustom.referral.referredBy)).toBe(String(referrer.user._id));

    const dupWallet = ethers.Wallet.createRandom();
    const dupChallenge = await challengeAndSign(dupWallet);
    const dupRes = await request(app)
      .post('/api/v1/auth/wallet/verify')
      .send({ address: dupWallet.address, signature: dupChallenge.signature, nonce: dupChallenge.challenge.nonce, handle: customHandle });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe('handle_taken');

    const collidedWallet = ethers.Wallet.createRandom();
    const collidedBase = `sve_${collidedWallet.address.slice(2, 8).toLowerCase()}`;
    await UserModel.updateOne({ _id: createdCustom._id }, { $set: { handle: collidedBase, handleRaw: collidedBase } });
    const collided = await challengeAndSign(collidedWallet);
    const collidedRes = await request(app)
      .post('/api/v1/auth/wallet/verify')
      .send({ address: collidedWallet.address, signature: collided.signature, nonce: collided.challenge.nonce });
    expect(collidedRes.status).toBe(200);
    expect(collidedRes.body.data.handle).toMatch(new RegExp(`^${collidedBase}_[0-9a-f]+$`));
  });

  it('allows creating a second email-less wallet user without E11000 and reuses existing user on repeat login', async () => {
    const walletA = ethers.Wallet.createRandom();
    const walletB = ethers.Wallet.createRandom();

    const sigA1 = await challengeAndSign(walletA);
    const loginA1 = await request(app).post('/api/v1/auth/wallet/verify').send({ address: walletA.address, signature: sigA1.signature, nonce: sigA1.challenge.nonce });
    expect(loginA1.status).toBe(200);

    const sigB = await challengeAndSign(walletB);
    const loginB = await request(app).post('/api/v1/auth/wallet/verify').send({ address: walletB.address, signature: sigB.signature, nonce: sigB.challenge.nonce });
    expect(loginB.status).toBe(200);
    expect(loginB.body.data.id).not.toBe(loginA1.body.data.id);

    const sigA2 = await challengeAndSign(walletA);
    const loginA2 = await request(app).post('/api/v1/auth/wallet/verify').send({ address: walletA.address, signature: sigA2.signature, nonce: sigA2.challenge.nonce });
    expect(loginA2.status).toBe(200);
    expect(loginA2.body.data.id).toBe(loginA1.body.data.id);
  });

  it('rejects nonce replay, expired challenges, purpose mismatch, wrong signature, invalid chainId, and deleted/suspended wallet users', async () => {
    const wallet = ethers.Wallet.createRandom();
    const { challenge, signature } = await challengeAndSign(wallet);

    const ok = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature, nonce: challenge.nonce });
    expect(ok.status).toBe(200);

    const replay = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature, nonce: challenge.nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('invalid_wallet_challenge');

    const expired = await challengeAndSign(wallet);
    await WalletChallengeModel.updateOne({ nonce: expired.challenge.nonce }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expiredRes = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature: expired.signature, nonce: expired.challenge.nonce });
    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body.error.code).toBe('invalid_wallet_challenge');

    const linkPurpose = await challengeAndSign(wallet, { purpose: 'link' });
    const wrongPurpose = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature: linkPurpose.signature, nonce: linkPurpose.challenge.nonce });
    expect(wrongPurpose.status).toBe(401);
    expect(wrongPurpose.body.error.code).toBe('invalid_wallet_challenge');

    const otherWallet = ethers.Wallet.createRandom();
    const challengeForSig = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address });
    const wrongSig = await otherWallet.signMessage(challengeForSig.body.data.message);
    const badSigRes = await request(app)
      .post('/api/v1/auth/wallet/verify')
      .send({ address: wallet.address, signature: wrongSig, nonce: challengeForSig.body.data.nonce });
    expect(badSigRes.status).toBe(401);
    expect(badSigRes.body.error.code).toBe('invalid_wallet_signature');

    const mainnetChallenge = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address, chainId: 43114 });
    expect(mainnetChallenge.status).toBe(400);
    expect(mainnetChallenge.body.error.code).toBe('validation_failed');
    const ethChallenge = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address, chainId: 1 });
    expect(ethChallenge.status).toBe(400);

    await UserModel.updateOne({ walletAddress: wallet.address }, { $set: { status: 'suspended' } });
    const susp = await challengeAndSign(wallet);
    const suspRes = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature: susp.signature, nonce: susp.challenge.nonce });
    expect(suspRes.status).toBe(403);
    expect(suspRes.body.error.code).toBe('account_suspended');

    await UserModel.updateOne({ walletAddress: wallet.address }, { $set: { status: 'deleted' } });
    const del = await challengeAndSign(wallet);
    const delRes = await request(app).post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature: del.signature, nonce: del.challenge.nonce });
    expect(delRes.status).toBe(401);
    expect(delRes.body.error.code).toBe('invalid_credentials');
  });

  it('updates handle via PATCH /api/v1/passport/me/handle and rejects duplicates or invalid handles', async () => {
    const unauth = await request(app).patch('/api/v1/passport/me/handle').send({ handle: 'Valid_123' });
    expect(unauth.status).toBe(401);

    const wallet = ethers.Wallet.createRandom();
    const agent = request.agent(server);
    const { challenge, signature } = await challengeAndSign(wallet, { agent });
    await agent.post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature, nonce: challenge.nonce });

    const invalid = await agent.patch('/api/v1/passport/me/handle').send({ handle: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('validation_failed');

    const other = await registerPlayer();
    const dup = await agent.patch('/api/v1/passport/me/handle').send({ handle: other.handle.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('handle_taken');

    const newHandle = `Ace_${unique('h').slice(0, 12)}`;
    const updated = await agent.patch('/api/v1/passport/me/handle').send({ handle: newHandle });
    expect(updated.status).toBe(200);
    expect(updated.body.data.handle).toBe(newHandle.toLowerCase());
    expect(updated.body.data.displayHandle).toBe(newHandle);

    const recase = await agent.patch('/api/v1/passport/me/handle').send({ handle: newHandle.toLowerCase() });
    expect(recase.status).toBe(200);
    expect(recase.body.data.displayHandle).toBe(newHandle.toLowerCase());
  });

  it('links wallet to an email user, allows wallet login afterward, and rejects wallet_taken / wallet_already_linked', async () => {
    const emailUser = await registerPlayer();
    const wallet1 = ethers.Wallet.createRandom();
    const wallet2 = ethers.Wallet.createRandom();

    const unauth = await request(app).post('/api/v1/auth/wallet/link').send({ address: wallet1.address, signature: '0x12', nonce: '12345678' });
    expect(unauth.status).toBe(401);

    const link1 = await challengeAndSign(wallet1, { agent: emailUser.agent, purpose: 'link' });
    const linkedRes = await emailUser.agent
      .post('/api/v1/auth/wallet/link')
      .send({ address: wallet1.address.toLowerCase(), signature: link1.signature, nonce: link1.challenge.nonce });
    expect(linkedRes.status).toBe(200);
    expect(linkedRes.body.data.id).toBe(emailUser.id);
    expect(linkedRes.body.data.walletAddress).toBe(wallet1.address);
    expect(linkedRes.body.data.walletChainId).toBe(43113);

    // Wallet login afterward signs into the exact same user account.
    const loginSig = await challengeAndSign(wallet1);
    const loginRes = await request(app)
      .post('/api/v1/auth/wallet/verify')
      .send({ address: wallet1.address, signature: loginSig.signature, nonce: loginSig.challenge.nonce });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.id).toBe(emailUser.id);

    // Another user cannot link wallet1 (409 wallet_taken).
    const otherUser = await registerPlayer();
    const takenSig = await challengeAndSign(wallet1, { agent: otherUser.agent, purpose: 'link' });
    const takenRes = await otherUser.agent
      .post('/api/v1/auth/wallet/link')
      .send({ address: wallet1.address, signature: takenSig.signature, nonce: takenSig.challenge.nonce });
    expect(takenRes.status).toBe(409);
    expect(takenRes.body.error.code).toBe('wallet_taken');

    // Original user cannot link a different wallet2 (409 wallet_already_linked).
    const diffSig = await challengeAndSign(wallet2, { agent: emailUser.agent, purpose: 'link' });
    const diffRes = await emailUser.agent
      .post('/api/v1/auth/wallet/link')
      .send({ address: wallet2.address, signature: diffSig.signature, nonce: diffSig.challenge.nonce });
    expect(diffRes.status).toBe(409);
    expect(diffRes.body.error.code).toBe('wallet_already_linked');
  });

  it('handles email-less users safely in resendVerification, sendVerification, admin search, review notifications, and partial index sync', async () => {
    const wallet = ethers.Wallet.createRandom();
    const agent = request.agent(server);
    const { challenge, signature } = await challengeAndSign(wallet, { agent });
    const verifyRes = await agent.post('/api/v1/auth/wallet/verify').send({ address: wallet.address, signature, nonce: challenge.nonce });
    expect(verifyRes.status).toBe(200);

    const resendRes = await agent.post('/api/v1/auth/email/resend').send({});
    expect(resendRes.status).toBe(200);
    expect(resendRes.body.data).toEqual({ sent: false });

    const dbUser = await UserModel.findOne({ pid: verifyRes.body.data.id }).lean();
    await expect(authService.sendVerification(dbUser)).rejects.toMatchObject({ status: 400, code: 'email_not_set' });

    const admin = await registerPlayer({ roles: ['player', 'admin'] });
    const adminUsersRes = await admin.agent.get(`/admin/v1/users?q=${wallet.address.toLowerCase()}`);
    expect(adminUsersRes.status).toBe(200);
    expect(adminUsersRes.body.data).toHaveLength(1);
    expect(adminUsersRes.body.data[0]).toMatchObject({
      id: verifyRes.body.data.id,
      email: null,
      walletAddress: wallet.address,
    });

    // Guarded mailer calls on rejection & bond slash when studio owner has no email.
    const { createLiveGame } = await import('../helpers.js');
    const { reviewService } = await import('../../src/modules/review/services/review.service.js');
    const { studio, game } = await createLiveGame();
    await UserModel.updateOne({ _id: studio.ownerUserId }, { $unset: { email: '' } });
    const outboxBefore = mailer.outbox.length;
    const rejected = await reviewService.reject(admin.user, game.pid, { reason: 'missing asset' });
    expect(rejected.status).toBe('rejected');
    const slashed = await reviewService.slashBond(admin.user, studio.pid, { amountUnits: 1_000_000n, reason: 'policy violation' });
    expect(slashed.slashedUnits).toBe('1000000');
    expect(mailer.outbox.length).toBe(outboxBefore);

    // Partial unique indexes exist on email and walletAddress.
    const indexes = await UserModel.collection.indexes();
    const emailIdx = indexes.find((idx) => idx.key?.email === 1);
    const walletIdx = indexes.find((idx) => idx.key?.walletAddress === 1);
    expect(emailIdx?.partialFilterExpression).toEqual({ email: { $type: 'string' } });
    expect(walletIdx?.partialFilterExpression).toEqual({ walletAddress: { $type: 'string' } });
  });

  it('rate-limits repeated failed wallet verify attempts via loginLimit', async () => {
    const wallet = ethers.Wallet.createRandom();
    const wrong = ethers.Wallet.createRandom();
    let last;
    for (let i = 0; i < 6; i += 1) {
      const challengeRes = await request(app).post('/api/v1/auth/wallet/challenge').send({ address: wallet.address });
      const wrongSig = await wrong.signMessage(challengeRes.body.data.message);
      last = await request(app)
        .post('/api/v1/auth/wallet/verify')
        .set('x-test-rate-limit', '1')
        .send({ address: wallet.address, signature: wrongSig, nonce: challengeRes.body.data.nonce });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('too_many_attempts');
  });
});
