import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { app, registerPlayer, unique } from '../helpers.js';
import { UserModel } from '../../src/modules/auth/models/index.js';
import { mailer } from '../../src/adapters/mailer/console-mailer.js';

function cookie(res, name) {
  return (res.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`))?.split(';')[0];
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
