import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { Client, PASSWORD, bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app
    .get((await import('../src/modules/reference/reference-data.service')).ReferenceDataService)
    .ensure();
});
afterAll(async () => {
  await ctx.close();
});

describe('auth & sessions', () => {
  it('serves health and tags every response as sandbox', async () => {
    const res = await ctx.http().get('/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('sandbox');
    expect(res.headers['x-dfn-mode']).toBe('sandbox');
    // Guard rejections (no interceptor runs) are tagged too.
    const denied = await ctx.http().get('/v1/auth/me');
    expect(denied.status).toBe(401);
    expect(denied.headers['x-dfn-mode']).toBe('sandbox');
    expect(denied.headers['x-dfn-disclaimer']).toBeTruthy();
  });

  it('registers a user with a personal organisation and a session cookie', async () => {
    const { client, user } = await registerUser(ctx, 'awa@example.com');
    expect(user.email).toBe('awa@example.com');
    expect(user.organizations).toHaveLength(1);
    expect(user.organizations[0].type).toBe('PERSONAL');
    const me = await client.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
    const stored = await ctx.prisma.user.findUnique({ where: { email: 'awa@example.com' } });
    expect(stored?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects weak passwords and duplicate emails', async () => {
    const c = new Client(ctx);
    const weak = await c.post('/v1/auth/register', {
      email: 'x@example.com',
      password: 'short',
      firstName: 'A',
      lastName: 'B',
      country: 'CA',
      acceptTerms: true,
    });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_FAILED');
    await registerUser(ctx, 'dup@example.com');
    const dup = await c.post('/v1/auth/register', {
      email: 'dup@example.com',
      password: PASSWORD,
      firstName: 'A',
      lastName: 'B',
      country: 'CA',
      acceptTerms: true,
    });
    expect(dup.status).toBe(409);
  });

  it('requires authentication and does not leak existence of other tenants data', async () => {
    const anon = await ctx.http().get('/v1/transactions');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('UNAUTHENTICATED');
  });

  it('logs in, logs out and locks after repeated failures', async () => {
    await registerUser(ctx, 'lock@example.com');
    const c = new Client(ctx);
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/v1/auth/login', { email: 'lock@example.com', password: 'WrongPassword123' });
      expect(r.status).toBe(401);
    }
    const locked = await c.post('/v1/auth/login', {
      email: 'lock@example.com',
      password: 'WrongPassword123',
    });
    expect(locked.status).toBe(423);
    const stillLocked = await c.post('/v1/auth/login', { email: 'lock@example.com', password: PASSWORD });
    expect(stillLocked.status).toBe(423);
    await ctx.prisma.user.update({ where: { email: 'lock@example.com' }, data: { lockedUntil: null } });
    const ok = await c.post('/v1/auth/login', { email: 'lock@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaRequired).toBe(false);
    const out = await c.post('/v1/auth/logout');
    expect(out.status).toBe(200);
    const me = await c.get('/v1/auth/me');
    expect(me.status).toBe(401);
    const alerts = await ctx.prisma.riskAlert.findMany({ where: { ruleCode: 'REPEATED_LOGIN_FAILURES' } });
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('enforces TOTP MFA once enabled', async () => {
    const { client } = await registerUser(ctx, 'mfa@example.com');
    const setup = await client.post('/v1/auth/mfa/setup');
    expect(setup.status).toBe(201);
    const code = authenticator.generate(setup.body.secret);
    const enabled = await client.post('/v1/auth/mfa/enable', { code });
    expect(enabled.body.enabled).toBe(true);
    const stored = await ctx.prisma.user.findUnique({ where: { email: 'mfa@example.com' } });
    expect(stored?.mfaSecretEnc).not.toContain(setup.body.secret);

    const c2 = new Client(ctx);
    const login = await c2.post('/v1/auth/login', { email: 'mfa@example.com', password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const blocked = await c2.get('/v1/transactions');
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
    const bad = await c2.post('/v1/auth/mfa/verify', { code: '000000' });
    expect(bad.status).toBe(401);
    const good = await c2.post('/v1/auth/mfa/verify', { code: authenticator.generate(setup.body.secret) });
    expect(good.status).toBe(200);
    const allowed = await c2.get('/v1/transactions');
    expect(allowed.status).toBe(200);
  });

  it('rejects cross-origin state changes', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('writes audit logs for authentication events', async () => {
    await registerUser(ctx, 'audit@example.com');
    const logs = await ctx.prisma.auditLog.findMany({ where: { action: 'auth.register' } });
    expect(logs).toHaveLength(1);
  });
});

describe('auth — MFA hardening (phase 6)', () => {
  it('returns recovery codes once at enrolment and exposes the factors before the MFA step', async () => {
    const { client } = await registerUser(ctx, 'mfa-factors@example.com');
    const before = await client.get('/v1/auth/mfa/status');
    expect(before.body).toMatchObject({ mfaEnabled: false, passkeyCount: 0, recoveryCodesRemaining: 0 });
    const setup = await client.post('/v1/auth/mfa/setup');
    const enabled = await client.post('/v1/auth/mfa/enable', {
      code: authenticator.generate(setup.body.secret),
    });
    expect(enabled.status).toBe(201);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    // Shown once: the API never returns them again.
    const summary = await client.get('/v1/auth/mfa/recovery-codes');
    expect(summary.body.remaining).toBe(10);
    expect(summary.body.recoveryCodes).toBeUndefined();

    const c2 = new Client(ctx);
    await c2.post('/v1/auth/login', { email: 'mfa-factors@example.com', password: PASSWORD });
    const status = await c2.get('/v1/auth/mfa/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mfaEnabled: true, methods: ['totp', 'recovery_code'] });
    expect((await c2.get('/v1/auth/mfa/recovery-codes')).status).toBe(401);
    const empty = await c2.post('/v1/auth/mfa/verify', {});
    expect(empty.status).toBe(400);
  });
});
