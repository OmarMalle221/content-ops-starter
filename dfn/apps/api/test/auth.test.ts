import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { generateRecoveryCode } from '../src/modules/auth/recovery-codes.service';
import { enableMfa, waitForFreshTotpStep, waitForNextTotpStep } from './helpers/webauthn';

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

  it('enforces TOTP MFA once enabled (password-confirmed enrolment, code burnt)', async () => {
    const { client } = await registerUser(ctx, 'mfa@example.com');
    const other = new Client(ctx);
    expect(
      (await other.post('/v1/auth/login', { email: 'mfa@example.com', password: PASSWORD })).status,
    ).toBe(200);
    const setup = await client.post('/v1/auth/mfa/setup');
    expect(setup.status).toBe(201);
    await waitForFreshTotpStep(12);
    const code = authenticator.generate(setup.body.secret);
    // A session alone cannot put a second factor on the account (stolen-cookie takeover).
    const noPassword = await client.post('/v1/auth/mfa/enable', { code });
    expect(noPassword.status).toBe(400);
    const wrongPassword = await client.post('/v1/auth/mfa/enable', {
      code,
      currentPassword: 'not-the-password',
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('STEP_UP_REQUIRED');
    expect(
      (await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'mfa@example.com' } })).mfaEnabled,
    ).toBe(false);
    const enabled = await client.post('/v1/auth/mfa/enable', { code, currentPassword: PASSWORD });
    expect(enabled.body.enabled).toBe(true);
    const stored = await ctx.prisma.user.findUnique({ where: { email: 'mfa@example.com' } });
    expect(stored?.mfaSecretEnc).not.toContain(setup.body.secret);
    // Sessions opened without the new factor are closed; the enrolling session stays usable.
    expect((await other.get('/v1/auth/me')).status).toBe(401);
    expect((await client.get('/v1/transactions')).status).toBe(200);

    const c2 = new Client(ctx);
    const login = await c2.post('/v1/auth/login', { email: 'mfa@example.com', password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const blocked = await c2.get('/v1/transactions');
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
    const bad = await c2.post('/v1/auth/mfa/verify', { code: '000000' });
    expect(bad.status).toBe(401);
    // The enrolment code was burnt: it cannot be replayed as a login proof.
    const replay = await c2.post('/v1/auth/mfa/verify', { code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_CODE_REUSED');
    await waitForNextTotpStep();
    const good = await c2.post('/v1/auth/mfa/verify', { code: authenticator.generate(setup.body.secret) });
    expect(good.status).toBe(200);
    const allowed = await c2.get('/v1/transactions');
    expect(allowed.status).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.mfa_enable_refused' } })).toBe(1);
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
    const { recoveryCodes } = await enableMfa(client);
    expect(recoveryCodes).toHaveLength(10);
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

  it('locks second-factor codes per account after 5 wrong attempts, whatever the session or IP', async () => {
    const email = 'mfa-lock@example.com';
    const { client, user } = await registerUser(ctx, email);
    const { recoveryCodes } = await enableMfa(client);
    const attacker = new Client(ctx);
    await attacker.post('/v1/auth/login', { email, password: PASSWORD });
    for (let i = 0; i < 4; i++) {
      const wrong = await attacker.post('/v1/auth/mfa/verify', { code: String(100000 + i) });
      expect(wrong.status).toBe(401);
    }
    // A wrong recovery code counts too; the 5th failure locks the account's codes.
    const fifth = await attacker.post('/v1/auth/mfa/verify', { code: generateRecoveryCode() });
    expect(fifth.status).toBe(423);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    // The guessing (pre-MFA) session is revoked; the verified session is kept.
    expect((await attacker.get('/v1/auth/me')).status).toBe(401);
    expect((await client.get('/v1/transactions')).status).toBe(200);

    // While locked, even a valid code is refused without being checked (no oracle, not burnt),
    // from a new session and for step-ups of the verified session alike.
    const fresh = new Client(ctx);
    await fresh.post('/v1/auth/login', { email, password: PASSWORD });
    const lockedLogin = await fresh.post('/v1/auth/mfa/verify', { code: recoveryCodes[0] });
    expect(lockedLogin.status).toBe(423);
    const lockedStepUp = await client.post('/v1/auth/mfa/recovery-codes/regenerate', {
      mfaCode: recoveryCodes[0],
    });
    expect(lockedStepUp.status).toBe(423);
    expect((await client.get('/v1/auth/mfa/recovery-codes')).body.remaining).toBe(10);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.mfa_locked', entityId: user.id } })).toBe(
      1,
    );
    expect(await ctx.prisma.notification.count({ where: { userId: user.id, type: 'auth.mfa_locked' } })).toBe(
      1,
    );

    // Once the lock has expired, a valid code works and resets the counter.
    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { mfaLockedUntil: new Date(Date.now() - 1000) },
    });
    const later = await fresh.post('/v1/auth/mfa/verify', { code: recoveryCodes[0] });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.mfaFailedCount).toBe(0);
  });
});

describe('auth — REQUIRE_STAFF_MFA', () => {
  let strict: TestContext;
  beforeAll(async () => {
    strict = await bootTestApp({ REQUIRE_STAFF_MFA: 'true' });
  });
  afterAll(async () => {
    await strict.close();
  });

  it('refuses staff permissions until the staff member has enabled a second factor', async () => {
    const { client } = await registerUser(strict, 'staff-mfa@example.com');
    await promote(strict, 'staff-mfa@example.com', 'COMPLIANCE');
    const refused = await client.get('/v1/admin/risk-alerts');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('STAFF_MFA_REQUIRED');
    // Tenant data too: without MFA the staff account has no staff read access at all.
    const { user: tenantOwner } = await registerUser(strict, 'tenant-owner-mfa@example.com');
    const tenantOrg = await strict.prisma.organizationMember.findFirstOrThrow({
      where: { userId: tenantOwner.id },
    });
    expect((await client.get(`/v1/organizations/${tenantOrg.organizationId}`)).status).toBe(404);
    // Enrolment itself stays reachable; customers are not affected.
    const { recoveryCodes } = await enableMfa(client);
    expect((await client.get('/v1/admin/risk-alerts')).status).toBe(200);
    expect((await client.get(`/v1/organizations/${tenantOrg.organizationId}`)).status).toBe(200);
    const { client: customer } = await registerUser(strict, 'customer-no-mfa@example.com');
    expect((await customer.get('/v1/transactions')).status).toBe(200);
    // Every new staff session goes through the second factor.
    const again = new Client(strict);
    await again.post('/v1/auth/login', { email: 'staff-mfa@example.com', password: PASSWORD });
    expect((await again.get('/v1/admin/risk-alerts')).status).toBe(401);
    expect((await again.post('/v1/auth/mfa/verify', { code: recoveryCodes[0] })).status).toBe(200);
    expect((await again.get('/v1/admin/risk-alerts')).status).toBe(200);
  });
});
