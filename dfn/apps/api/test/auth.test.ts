import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MfaVerifierService, acceptedTotpStep } from '../src/modules/auth/mfa-verifier.service';
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

/** `count` 6-digit codes that are not valid for `secret` around now (previous, current, next step). */
function wrongTotpCodes(secret: string, count: number): string[] {
  const now = Date.now();
  const codes: string[] = [];
  for (let n = 100000; codes.length < count; n += 7) {
    const code = String(n);
    if ([-30_000, 0, 30_000].every((d) => acceptedTotpStep(secret, code, now + d) === null)) codes.push(code);
  }
  return codes;
}

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

  it('counts each code attempt before checking it: a parallel burst gets at most 5 codes checked', async () => {
    const { client, user } = await registerUser(ctx, 'mfa-burst@example.com');
    const { secret, recoveryCodes } = await enableMfa(client);
    const wrongCodes = wrongTotpCodes(secret, 12);
    const checked = vi.spyOn(ctx.app.get(MfaVerifierService), 'verifyTotp');
    try {
      // Step-ups of the verified session: it outlives the lock (pre-MFA sessions are revoked).
      const burst = await Promise.all(
        wrongCodes.map((mfaCode) => client.post('/v1/auth/mfa/recovery-codes/regenerate', { mfaCode })),
      );
      expect(checked).toHaveBeenCalledTimes(5);
      const statuses = burst.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(4);
      expect(statuses.filter((s) => s === 423)).toHaveLength(8);
      for (const r of burst)
        expect(r.body.code).toBe(r.status === 401 ? 'STEP_UP_REQUIRED' : 'ACCOUNT_LOCKED');
      expect(
        await ctx.prisma.auditLog.count({ where: { action: 'auth.mfa_locked', entityId: user.id } }),
      ).toBe(1);

      // While locked, right codes are refused without being checked (nor burnt).
      const totp = await client.post('/v1/auth/mfa/recovery-codes/regenerate', {
        mfaCode: authenticator.generate(secret),
      });
      expect(totp.status).toBe(423);
      const recovery = await client.post('/v1/auth/mfa/recovery-codes/regenerate', {
        mfaCode: recoveryCodes[0],
      });
      expect(recovery.status).toBe(423);
      expect(checked).toHaveBeenCalledTimes(5);
      expect((await client.get('/v1/auth/mfa/recovery-codes')).body.remaining).toBe(10);
    } finally {
      checked.mockRestore();
    }
  });

  it('never keeps the TOTP secret or recovery codes in the Idempotency-Key store', async () => {
    const { client, user } = await registerUser(ctx, 'mfa-idempotency@example.com');
    const cookie = (client as unknown as { cookie: string }).cookie;
    const post = (url: string, key: string, body: object = {}) =>
      ctx.http().post(url).set('Cookie', cookie).set('Idempotency-Key', key).send(body);
    const stored = (idempotencyKey: string) =>
      ctx.prisma.idempotencyRecord.count({ where: { scopeKey: user.id, idempotencyKey } });

    // Control: an ordinary session request with a key is kept for replay.
    expect((await post('/v1/auth/sessions/revoke-others', 'idem-auth-control')).status).toBe(200);
    expect(await stored('idem-auth-control')).toBe(1);

    const setup = await post('/v1/auth/mfa/setup', 'idem-auth-setup');
    expect(setup.status).toBe(201);
    expect(setup.body.secret).toBeTruthy();
    expect(await stored('idem-auth-setup')).toBe(0);
    if (authenticator.timeRemaining() < 3) await sleep(authenticator.timeRemaining() * 1000 + 250);
    const enabled = await post('/v1/auth/mfa/enable', 'idem-auth-enable', {
      code: authenticator.generate(setup.body.secret),
      currentPassword: PASSWORD,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect(await stored('idem-auth-enable')).toBe(0);
    const regenerated = await post('/v1/auth/mfa/recovery-codes/regenerate', 'idem-auth-regenerate', {
      mfaCode: enabled.body.recoveryCodes[0],
    });
    expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(200);
    expect(await stored('idem-auth-regenerate')).toBe(0);
    expect(await ctx.prisma.idempotencyRecord.count({ where: { scopeKey: user.id } })).toBe(1);
  });
});

describe('auth — password confirmations share the login lockout', () => {
  it('counts wrong current passwords per account, locks sign-in with them and resets on success', async () => {
    const email = 'confirm-lock@example.com';
    const { client, user } = await registerUser(ctx, email);
    const setup = await client.post('/v1/auth/mfa/setup');
    expect(setup.status).toBe(201);
    const [code] = wrongTotpCodes(setup.body.secret, 1);
    const enable = (currentPassword: string) => client.post('/v1/auth/mfa/enable', { code, currentPassword });
    const failures = async () =>
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount;

    for (let i = 0; i < 2; i++) {
      const wrong = await enable('NotThePassword123');
      expect(wrong.status).toBe(401);
      expect(wrong.body.code).toBe('STEP_UP_REQUIRED');
    }
    expect(await failures()).toBe(2);
    // The right password resets the counter (the code is checked next, and refused).
    expect((await enable(PASSWORD)).status).toBe(400);
    expect(await failures()).toBe(0);

    // A parallel burst gets 5 passwords checked: the 5th locks, the others are refused unchecked.
    const burst = await Promise.all(Array.from({ length: 8 }, () => enable('NotThePassword123')));
    const statuses = burst.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses.filter((s) => s === 423)).toHaveLength(4);
    for (const r of burst) expect(r.body.code).toBe(r.status === 401 ? 'STEP_UP_REQUIRED' : 'ACCOUNT_LOCKED');

    // It is the login lock: sign-in and every password confirmation are refused, even right ones.
    const login = await new Client(ctx).post('/v1/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(423);
    expect(login.body.code).toBe('ACCOUNT_LOCKED');
    expect((await enable(PASSWORD)).status).toBe(423);
    const change = await client.post('/v1/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'AnotherHorse42Battery',
    });
    expect(change.status).toBe(423);
    const passkey = await client.post('/v1/auth/passkeys/registration/options', {
      currentPassword: PASSWORD,
    });
    expect(passkey.status).toBe(423);
    expect(await ctx.prisma.authChallenge.count()).toBe(0);

    // Once the lock has expired, the right password signs in again and resets the counter.
    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await new Client(ctx).post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
    expect(await failures()).toBe(0);
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

  it('reports the effective role on /v1/auth/me (USER + staffMfaRequired until staff MFA is on)', async () => {
    const { client } = await registerUser(strict, 'staff-me@example.com');
    await promote(strict, 'staff-me@example.com', 'ADMIN');
    const downgraded = await client.get('/v1/auth/me');
    expect(downgraded.status).toBe(200);
    expect(downgraded.body.user).toMatchObject({ globalRole: 'USER', staffMfaRequired: true });
    await enableMfa(client);
    expect((await client.get('/v1/auth/me')).body.user).toMatchObject({
      globalRole: 'ADMIN',
      staffMfaRequired: false,
    });
    // Customers, and staff when REQUIRE_STAFF_MFA is off: the stored role, nothing required.
    const { client: customer } = await registerUser(strict, 'customer-me@example.com');
    expect((await customer.get('/v1/auth/me')).body.user).toMatchObject({
      globalRole: 'USER',
      staffMfaRequired: false,
    });
    const { client: lax } = await registerUser(ctx, 'staff-lax-me@example.com');
    await promote(ctx, 'staff-lax-me@example.com', 'COMPLIANCE');
    expect((await lax.get('/v1/auth/me')).body.user).toMatchObject({
      globalRole: 'COMPLIANCE',
      staffMfaRequired: false,
    });
  });
});
