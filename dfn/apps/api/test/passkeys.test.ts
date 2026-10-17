import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { StepUpOperation } from '@dfn/shared';
import { JobRegistry } from '../src/modules/jobs/job-registry';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { acceptedTotpStep } from '../src/modules/auth/mfa-verifier.service';
import { generateRecoveryCode } from '../src/modules/auth/recovery-codes.service';
import { stepUpOperationKey } from '../src/modules/auth/webauthn.service';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { createBeneficiary, createTransferActors, fundWallet, quoteAndCreate } from './helpers/transfers';
import { put } from './helpers/wallet';
import {
  SoftwareAuthenticator,
  deleteWithBody,
  enableMfa,
  passkeyLogin,
  registerPasskey,
  stepUpAssertion,
  stepUpOptions,
  waitForFreshTotpStep,
} from './helpers/webauthn';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

const RECOVERY_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{2}$/;
const PROOF = { currentPassword: PASSWORD };

async function passwordLogin(email: string) {
  const client = new Client(ctx);
  const res = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { client, mfaRequired: res.body.mfaRequired as boolean };
}

describe('passkeys — registration', () => {
  it('registers a passkey for a signed-in session, lists, renames it, audits and notifies', async () => {
    const { client, user } = await registerUser(ctx, 'pk-reg@example.com');
    const device = new SoftwareAuthenticator();

    const options = await client.post('/v1/auth/passkeys/registration/options', PROOF);
    expect(options.status).toBe(200);
    expect(options.body.rp).toEqual({ id: 'localhost', name: 'Diaspora Trust (sandbox)' });
    expect(options.body.authenticatorSelection).toMatchObject({
      residentKey: 'preferred',
      userVerification: 'required',
    });
    expect(options.body.excludeCredentials).toEqual([]);
    const stored = await ctx.prisma.authChallenge.findUnique({
      where: { challenge: options.body.challenge },
    });
    expect(stored).toMatchObject({ purpose: 'REGISTRATION', userId: user.id, usedAt: null });
    expect(stored!.sessionId).toBeTruthy();
    expect(stored!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    const verify = await client.post('/v1/auth/passkeys/registration/verify', {
      name: 'MacBook',
      response: device.createCredential(options.body),
    });
    expect(verify.status, JSON.stringify(verify.body)).toBe(201);
    expect(verify.body).toMatchObject({ name: 'MacBook', status: 'ACTIVE', transports: ['internal'] });
    expect(verify.body.nextActions).toEqual(['RENAME', 'REVOKE']);
    expect(verify.body.publicKey).toBeUndefined();

    const row = await ctx.prisma.webAuthnCredential.findUniqueOrThrow({ where: { credentialId: device.id } });
    expect(row.userId).toBe(user.id);
    expect(row.counter).toBe(0n);
    expect(row.publicKey.length).toBeGreaterThan(60);
    expect(row.aaguid).toBe('00000000-0000-0000-0000-000000000000');
    expect(row.deviceType).toBe('singleDevice');
    const burnt = await ctx.prisma.authChallenge.findUniqueOrThrow({ where: { id: stored!.id } });
    expect(burnt.usedAt).not.toBeNull();

    const list = await client.get('/v1/auth/passkeys');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(row.id);

    // The existing credential is excluded from the next registration ceremony.
    const again = await client.post('/v1/auth/passkeys/registration/options', PROOF);
    expect(again.body.excludeCredentials).toEqual([
      { id: device.id, type: 'public-key', transports: ['internal'] },
    ]);

    const renamed = await client.patch(`/v1/auth/passkeys/${row.id}`, { name: 'MacBook Pro' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('MacBook Pro');

    const audit = await ctx.prisma.auditLog.findMany({
      where: { actorUserId: user.id, action: { in: ['auth.passkey_registered', 'auth.passkey_renamed'] } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(['auth.passkey_registered', 'auth.passkey_renamed']);
    const notification = await ctx.prisma.notification.findFirst({
      where: { userId: user.id, type: 'auth.passkey_registered' },
    });
    expect(notification?.title).toBe('Nouvelle clé d’accès');
  });

  it('refuses a wrong origin, a wrong RP ID or an assertion without user verification', async () => {
    const { client } = await registerUser(ctx, 'pk-bad@example.com');
    const device = new SoftwareAuthenticator();
    for (const overrides of [
      { origin: 'https://evil.example' },
      { rpId: 'evil.example' },
      { noUserVerification: true },
    ]) {
      const options = await client.post('/v1/auth/passkeys/registration/options', PROOF);
      const res = await client.post('/v1/auth/passkeys/registration/verify', {
        name: 'Clé',
        response: device.createCredential(options.body, overrides),
      });
      expect(res.status, JSON.stringify(overrides)).toBe(400);
      expect(res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    }
    expect(await ctx.prisma.webAuthnCredential.count()).toBe(0);
    // Every failed ceremony burnt its challenge.
    expect(await ctx.prisma.authChallenge.count({ where: { usedAt: null } })).toBe(0);
  });

  it('refuses a reused, expired, foreign-session or wrong-purpose challenge', async () => {
    const { client } = await registerUser(ctx, 'pk-chal@example.com');
    const device = new SoftwareAuthenticator();

    // Reuse: the same response twice.
    const options = await client.post('/v1/auth/passkeys/registration/options', PROOF);
    const response = device.createCredential(options.body);
    expect((await client.post('/v1/auth/passkeys/registration/verify', { name: 'A', response })).status).toBe(
      201,
    );
    const replay = await client.post('/v1/auth/passkeys/registration/verify', { name: 'A', response });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('CHALLENGE_EXPIRED');

    // Expiry.
    const device2 = new SoftwareAuthenticator();
    const expiring = await client.post('/v1/auth/passkeys/registration/options', PROOF);
    await ctx.prisma.authChallenge.update({
      where: { challenge: expiring.body.challenge },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await client.post('/v1/auth/passkeys/registration/verify', {
      name: 'B',
      response: device2.createCredential(expiring.body),
    });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('CHALLENGE_EXPIRED');

    // Bound to the session: another session of the same user cannot answer it.
    const foreign = await client.post('/v1/auth/passkeys/registration/options', PROOF);
    const { client: other } = await passwordLogin('pk-chal@example.com');
    const otherSession = await other.post('/v1/auth/passkeys/registration/verify', {
      name: 'C',
      response: device2.createCredential(foreign.body),
    });
    expect(otherSession.status).toBe(401);
    expect(otherSession.body.code).toBe('CHALLENGE_EXPIRED');

    // A passwordless-login challenge cannot be used to register.
    const loginOptions = await new Client(ctx).post('/v1/auth/passkeys/authentication/options', {});
    const wrongPurpose = await client.post('/v1/auth/passkeys/registration/verify', {
      name: 'D',
      response: device2.createCredential(options.body, { challenge: loginOptions.body.challenge }),
    });
    expect(wrongPurpose.status).toBe(401);
    expect(wrongPurpose.body.code).toBe('CHALLENGE_EXPIRED');
    expect(await ctx.prisma.webAuthnCredential.count()).toBe(1);
  });

  it('isolates passkeys between users (404) and requires a full session', async () => {
    const a = await registerUser(ctx, 'pk-iso-a@example.com');
    const b = await registerUser(ctx, 'pk-iso-b@example.com');
    const device = new SoftwareAuthenticator();
    const created = await registerPasskey(a.client, device);
    expect(created.status).toBe(201);
    const rename = await b.client.patch(`/v1/auth/passkeys/${created.body.id}`, { name: 'Volée' });
    expect(rename.status).toBe(404);
    expect(rename.body.code).toBe('PASSKEY_NOT_FOUND');
    const revoke = await deleteWithBody(ctx, b.client, `/v1/auth/passkeys/${created.body.id}`);
    expect(revoke.status).toBe(404);
    expect((await b.client.get('/v1/auth/passkeys')).body.items).toEqual([]);
    expect((await ctx.http().get('/v1/auth/passkeys')).status).toBe(401);
    expect((await ctx.http().post('/v1/auth/passkeys/registration/options')).status).toBe(401);
  });

  it('requires a fresh proof before issuing a registration challenge', async () => {
    const { client, user } = await registerUser(ctx, 'pk-proof@example.com');
    const url = '/v1/auth/passkeys/registration/options';
    const bare = await client.post(url, {});
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    const wrong = await client.post(url, { currentPassword: 'NotThePassword123' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('STEP_UP_REQUIRED');
    expect(
      await ctx.prisma.auditLog.count({
        where: { actorUserId: user.id, action: 'auth.passkey_registration_refused' },
      }),
    ).toBe(1);
    expect(await ctx.prisma.authChallenge.count()).toBe(0);

    // With MFA enabled the password is not enough: a second factor is required.
    const first = new SoftwareAuthenticator();
    expect((await registerPasskey(client, first)).status).toBe(201);
    const { secret } = await enableMfa(client);
    const passwordOnly = await client.post(url, PROOF);
    expect(passwordOnly.status).toBe(401);
    expect(passwordOnly.body.code).toBe('STEP_UP_REQUIRED');
    await waitForFreshTotpStep();
    const second = new SoftwareAuthenticator();
    const viaTotp = await registerPasskey(client, second, 'Via TOTP', {
      mfaCode: authenticator.generate(secret),
    });
    expect(viaTotp.status, JSON.stringify(viaTotp.body)).toBe(201);
    const third = new SoftwareAuthenticator();
    const viaPasskey = await registerPasskey(client, third, 'Via clé', {
      passkeyAssertion: await stepUpAssertion(client, first, { operation: StepUpOperation.PASSKEY_REGISTER }),
    });
    expect(viaPasskey.status, JSON.stringify(viaPasskey.body)).toBe(201);
    expect((await client.get('/v1/auth/passkeys')).body.items).toHaveLength(3);
  });

  it('re-checks the 20-passkey cap when a ceremony completes (parallel ceremonies)', async () => {
    const { client, user } = await registerUser(ctx, 'passkey-cap@example.com');
    await ctx.prisma.webAuthnCredential.createMany({
      data: Array.from({ length: 19 }, (_, i) => ({
        userId: user.id,
        credentialId: `cap${i}${user.id.replace(/-/g, '')}`,
        publicKey: Buffer.alloc(32, i),
        transports: [],
        name: `Clé ${i}`,
      })),
    });
    // Two ceremonies started while the account had 19 passkeys: only one may complete.
    const first = await client.post('/v1/auth/passkeys/registration/options', { currentPassword: PASSWORD });
    const second = await client.post('/v1/auth/passkeys/registration/options', { currentPassword: PASSWORD });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const done = await client.post('/v1/auth/passkeys/registration/verify', {
      name: 'Vingtième',
      response: new SoftwareAuthenticator().createCredential(first.body),
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const capped = await client.post('/v1/auth/passkeys/registration/verify', {
      name: 'De trop',
      response: new SoftwareAuthenticator().createCredential(second.body),
    });
    expect(capped.status).toBe(409);
    expect(await ctx.prisma.webAuthnCredential.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      20,
    );
  });
});

describe('passkeys — passwordless login', () => {
  it('does not reveal whether an account or its passkeys exist', async () => {
    const { client } = await registerUser(ctx, 'pk-enum@example.com');
    await registerPasskey(client, new SoftwareAuthenticator());
    const anon = new Client(ctx);
    const bodies = [];
    for (const body of [{ email: 'pk-enum@example.com' }, { email: 'nobody@example.com' }, {}, undefined]) {
      const res = await anon.post('/v1/auth/passkeys/authentication/options', body);
      expect(res.status).toBe(200);
      bodies.push(res.body);
    }
    const normalized = bodies.map((b) => JSON.stringify({ ...b, challenge: '<challenge>' }));
    expect(new Set(normalized).size).toBe(1);
    expect(new Set(bodies.map((b) => b.challenge)).size).toBe(4);
    expect(bodies[0].allowCredentials ?? []).toEqual([]);
    expect(bodies[0].userVerification).toBe('required');
    expect(bodies[0].rpId).toBe('localhost');
    const challenges = await ctx.prisma.authChallenge.findMany({ where: { purpose: 'AUTHENTICATION' } });
    expect(challenges).toHaveLength(4);
    expect(challenges.every((c) => c.userId === null && c.sessionId === null)).toBe(true);
  });

  it('creates an MFA-verified session (even with TOTP enabled), updates counter and audits', async () => {
    const { client, user } = await registerUser(ctx, 'pk-login@example.com');
    const device = new SoftwareAuthenticator();
    expect((await registerPasskey(client, device)).status).toBe(201);
    await enableMfa(client);

    const { client: browser, res } = await passkeyLogin(ctx, device);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mfaRequired).toBe(false);
    expect(res.body.user.id).toBe(user.id);
    expect(res.headers['set-cookie']).toBeDefined();
    // A user-verifying passkey satisfies MFA: protected routes are reachable at once.
    expect((await browser.get('/v1/transactions')).status).toBe(200);
    const me = await browser.get('/v1/auth/me');
    expect(me.body.mfaRequired).toBe(false);

    const credential = await ctx.prisma.webAuthnCredential.findUniqueOrThrow({
      where: { credentialId: device.id },
    });
    expect(credential.counter).toBe(1n);
    expect(credential.lastUsedAt).not.toBeNull();
    const session = await ctx.prisma.session.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(session.mfaVerified).toBe(true);
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'auth.login' },
      orderBy: { createdAt: 'desc' },
    });
    expect((audit?.metadata as any).method).toBe('passkey');

    // The login challenge is single use.
    const replay = await browser.post('/v1/auth/passkeys/authentication/verify', {
      response: device.getAssertion({
        challenge: (await ctx.prisma.authChallenge.findFirstOrThrow({ where: { purpose: 'AUTHENTICATION' } }))
          .challenge,
      }),
    });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('refuses a signature counter regression and counts it as a failed login', async () => {
    const { client, user } = await registerUser(ctx, 'pk-clone@example.com');
    const device = new SoftwareAuthenticator(0, 5);
    await registerPasskey(client, device);
    expect((await passkeyLogin(ctx, device)).res.status).toBe(200); // counter 5
    expect((await passkeyLogin(ctx, device)).res.status).toBe(200); // counter 10

    const regressed = await passkeyLogin(ctx, device, { counter: 7 });
    expect(regressed.res.status).toBe(401);
    expect(regressed.res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    const equal = await passkeyLogin(ctx, device, { counter: 10 });
    expect(equal.res.status).toBe(401);

    const credential = await ctx.prisma.webAuthnCredential.findUniqueOrThrow({
      where: { credentialId: device.id },
    });
    expect(credential.counter).toBe(10n);
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.failedLoginCount).toBe(2);
    const failures = await ctx.prisma.auditLog.findMany({
      where: { actorUserId: user.id, action: 'auth.login_failed' },
    });
    expect(failures.map((f) => (f.metadata as any).reason)).toEqual([
      'counter_regression',
      'counter_regression',
    ]);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: user.id, type: 'auth.passkey_counter_regression' },
      }),
    ).toBe(2);
    // A legitimate next assertion still works and resets the counter of failures.
    expect((await passkeyLogin(ctx, device, { counter: 11 })).res.status).toBe(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).failedLoginCount).toBe(0);
  });

  it('accepts authenticators that always report a zero counter', async () => {
    const { client } = await registerUser(ctx, 'pk-zero@example.com');
    const device = new SoftwareAuthenticator(0, 0);
    await registerPasskey(client, device);
    expect((await passkeyLogin(ctx, device)).res.status).toBe(200);
    expect((await passkeyLogin(ctx, device)).res.status).toBe(200);
  });

  it('refuses revoked passkeys, forged signatures, locked, suspended and deleted accounts', async () => {
    const { client, user } = await registerUser(ctx, 'pk-refuse@example.com');
    const device = new SoftwareAuthenticator();
    const other = new SoftwareAuthenticator();
    const created = await registerPasskey(client, device);
    await registerPasskey(client, other, 'Autre');

    // Forged: the signature of another key.
    const options = await new Client(ctx).post('/v1/auth/passkeys/authentication/options', {});
    const forged = device.getAssertion(options.body);
    forged.response.signature = other.getAssertion(options.body).response.signature;
    const forgedRes = await new Client(ctx).post('/v1/auth/passkeys/authentication/verify', {
      response: forged,
    });
    expect(forgedRes.status).toBe(401);
    expect(forgedRes.body.code).toBe('PASSKEY_VERIFICATION_FAILED');

    // Wrong origin at login.
    const evil = await passkeyLogin(ctx, device, { origin: 'https://evil.example' });
    expect(evil.res.status).toBe(401);

    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() + 60_000) },
    });
    expect((await passkeyLogin(ctx, device)).res.status).toBe(423);
    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: null, status: 'SUSPENDED' },
    });
    expect((await passkeyLogin(ctx, device)).res.status).toBe(403);
    await ctx.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', deletedAt: new Date() },
    });
    expect((await passkeyLogin(ctx, device)).res.status).toBe(401);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
    expect((await passkeyLogin(ctx, device)).res.status).toBe(200);

    // Revocation (no MFA on this account: the session is enough).
    const revoked = await deleteWithBody(ctx, client, `/v1/auth/passkeys/${created.body.id}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    const refused = await passkeyLogin(ctx, device);
    expect(refused.res.status).toBe(401);
    expect(refused.res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    expect((await client.get('/v1/auth/passkeys')).body.items.map((p: any) => p.name)).toEqual(['Autre']);
    expect((await deleteWithBody(ctx, client, `/v1/auth/passkeys/${created.body.id}`)).status).toBe(404);
    expect(
      await ctx.prisma.notification.count({ where: { userId: user.id, type: 'auth.passkey_revoked' } }),
    ).toBe(1);
    const lastFailure = await ctx.prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'auth.login_failed' },
      orderBy: { createdAt: 'desc' },
    });
    expect((lastFailure?.metadata as any).reason).toBe('credential_revoked');
    // An unknown credential is refused the same way.
    expect((await passkeyLogin(ctx, new SoftwareAuthenticator())).res.status).toBe(401);
  });
});

describe('passkeys — step-up', () => {
  it('replaces the TOTP code to authorise a transfer, bound to the session and single use', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '2000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const device = new SoftwareAuthenticator();
    expect((await registerPasskey(a.owner, device)).status).toBe(201);
    await enableMfa(a.owner);

    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    const missing = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {});
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('MFA_REQUIRED');

    // A step-up challenge issued to another (fully signed-in) session of the same user is refused.
    const { client: otherSession } = await passkeyLogin(ctx, device);
    const forTransfer = { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: transfer.id };
    const foreign = await stepUpAssertion(otherSession, device, forTransfer);
    const foreignRes = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      passkeyAssertion: foreign,
    });
    expect(foreignRes.status).toBe(401);
    expect(foreignRes.body.code).toBe('CHALLENGE_EXPIRED');

    // A passwordless-login challenge is not a step-up challenge.
    const loginOptions = await new Client(ctx).post('/v1/auth/passkeys/authentication/options', {});
    const wrongPurpose = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      passkeyAssertion: device.getAssertion(loginOptions.body),
    });
    expect(wrongPurpose.status).toBe(401);
    expect(wrongPurpose.body.code).toBe('CHALLENGE_EXPIRED');

    const assertion = await stepUpAssertion(a.owner, device, forTransfer);
    const ok = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, { passkeyAssertion: assertion });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('PROCESSING');
    const event = await ctx.prisma.transferEvent.findFirst({
      where: { transferId: transfer.id, type: 'transfer.authorized' },
    });
    expect((event?.payload as any).mfaVerified).toBe(true);
    const stepUp = await ctx.prisma.auditLog.findFirst({
      where: { actorUserId: a.ownerUser.id, action: 'auth.passkey_step_up' },
    });
    expect((stepUp?.metadata as any).purpose).toBe('transfer.authorize');

    // The same assertion cannot authorise a second transfer.
    const { transfer: t2 } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '50.00' });
    const replay = await a.owner.post(`/v1/transfers/${t2.id}/authorize`, { passkeyAssertion: assertion });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('CHALLENGE_EXPIRED');
  });

  it('lets a passkey or a recovery code lower the security preferences', async () => {
    const { client, user } = await registerUser(ctx, 'pk-prefs@example.com');
    const device = new SoftwareAuthenticator();
    await registerPasskey(client, device);
    const { recoveryCodes } = await enableMfa(client);
    const url = '/v1/users/me/security-preferences';
    const strict = { requireMfaForTransfers: true, transferAlerts: true, dailyTransferLimit: '1000.00' };
    expect((await put(ctx, client, url, strict)).status).toBe(200);

    const refused = await put(ctx, client, url, { ...strict, dailyTransferLimit: null });
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('MFA_REQUIRED');

    const viaPasskey = await put(ctx, client, url, {
      ...strict,
      dailyTransferLimit: '2000.00',
      passkeyAssertion: await stepUpAssertion(client, device, {
        operation: StepUpOperation.SECURITY_PREFERENCES_LOWER,
      }),
    });
    expect(viaPasskey.status, JSON.stringify(viaPasskey.body)).toBe(200);
    expect(viaPasskey.body.dailyTransferLimit).toBe('2000.00');
    expect(viaPasskey.body.passkeyAssertion).toBeUndefined();

    const viaRecovery = await put(ctx, client, url, {
      ...strict,
      requireMfaForTransfers: false,
      dailyTransferLimit: null,
      mfaCode: recoveryCodes[0].toLowerCase().replace(/-/g, ''),
    });
    expect(viaRecovery.status, JSON.stringify(viaRecovery.body)).toBe(200);
    expect(viaRecovery.body.requireMfaForTransfers).toBe(false);
    const audits = await ctx.prisma.auditLog.findMany({
      where: { actorUserId: user.id, action: 'user.security_preferences_updated' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => (a.metadata as any).stepUp)).toEqual([null, 'passkey', 'recovery_code']);
  });

  it('completes the login MFA step with a passkey and is refused without a passkey', async () => {
    const { client } = await registerUser(ctx, 'pk-mfa-step@example.com');
    const device = new SoftwareAuthenticator();
    await registerPasskey(client, device);
    await enableMfa(client);

    const { client: browser, mfaRequired } = await passwordLogin('pk-mfa-step@example.com');
    expect(mfaRequired).toBe(true);
    const status = await browser.get('/v1/auth/mfa/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mfaEnabled: true, passkeyCount: 1, recoveryCodesRemaining: 10 });
    expect((await browser.get('/v1/transactions')).status).toBe(401);
    const verified = await browser.post('/v1/auth/mfa/verify', {
      passkeyAssertion: await stepUpAssertion(browser, device, { operation: StepUpOperation.LOGIN_MFA }),
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body.method).toBe('passkey');
    expect((await browser.get('/v1/transactions')).status).toBe(200);

    const { client: noPasskey } = await registerUser(ctx, 'pk-none@example.com');
    const none = await stepUpOptions(noPasskey, { operation: StepUpOperation.PASSKEY_REGISTER });
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('PASSKEY_NOT_FOUND');
  });

  it('requires a fresh proof to revoke a passkey or disable MFA when MFA is enabled', async () => {
    const { client, user } = await registerUser(ctx, 'pk-revoke@example.com');
    const main = new SoftwareAuthenticator();
    const spare = new SoftwareAuthenticator();
    await registerPasskey(client, main, 'Principale');
    const spareRow = await registerPasskey(client, spare, 'Secours');
    await enableMfa(client);

    const bare = await deleteWithBody(ctx, client, `/v1/auth/passkeys/${spareRow.body.id}`);
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    const proven = await deleteWithBody(ctx, client, `/v1/auth/passkeys/${spareRow.body.id}`, {
      passkeyAssertion: await stepUpAssertion(client, main, {
        operation: StepUpOperation.PASSKEY_REVOKE,
        resourceId: spareRow.body.id,
      }),
    });
    expect(proven.status, JSON.stringify(proven.body)).toBe(200);
    expect((await client.get('/v1/auth/passkeys')).body.items.map((p: any) => p.name)).toEqual([
      'Principale',
    ]);

    // Disable MFA with a passkey assertion: recovery codes go away with the secret.
    const disabled = await client.post('/v1/auth/mfa/disable', {
      passkeyAssertion: await stepUpAssertion(client, main, { operation: StepUpOperation.MFA_DISABLE }),
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(201);
    expect(disabled.body.enabled).toBe(false);
    expect(await ctx.prisma.mfaRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
    const audit = await ctx.prisma.auditLog.findFirst({
      where: { actorUserId: user.id, action: 'auth.mfa_disabled' },
    });
    expect((audit?.metadata as any).stepUp).toBe('passkey');
  });
});

describe('passkeys — step-up bound to the operation', () => {
  const GATE_PROGRESS = { status: 'IN_PROGRESS', note: 'Mandat signé', evidenceRef: 'VAULT-1' };
  const GATE_APPROVE = { note: 'Avis juridique archivé', evidenceRef: 'VAULT-2' };

  it('accepts an assertion only for the operation and resource it was issued for', async () => {
    const a = await createTransferActors(ctx);
    // The owner is also an ADMIN, so one session can try the same proof on a gate approval.
    await promote(ctx, 'xfer-owner@example.com', 'ADMIN');
    await fundWallet(ctx, a.orgId, 'CAD', '2000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const device = new SoftwareAuthenticator();
    expect((await registerPasskey(a.owner, device)).status).toBe(201);
    const { secret } = await enableMfa(a.owner);
    const { transfer: tA } = await quoteAndCreate(a.owner, beneficiary.id);
    const { transfer: tB } = await quoteAndCreate(a.owner, beneficiary.id, { amount: '50.00' });
    const forA = { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: tA.id };

    // The challenge records what it was issued for.
    const options = await stepUpOptions(a.owner, forA);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    const stored = await ctx.prisma.authChallenge.findUniqueOrThrow({
      where: { challenge: options.body.challenge },
    });
    expect(stored).toMatchObject({
      purpose: 'STEP_UP',
      operation: `transfer.authorize:${tA.id}`,
      userId: a.ownerUser.id,
    });

    // Issued for transfer A, presented for transfer B: refused, and the challenge stays burnt.
    const assertionA = device.getAssertion(options.body);
    const onB = await a.owner.post(`/v1/transfers/${tB.id}/authorize`, { passkeyAssertion: assertionA });
    expect(onB.status).toBe(403);
    expect(onB.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    expect((await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: tB.id } })).status).toBe(tB.status);
    const burnt = await ctx.prisma.authChallenge.findUniqueOrThrow({ where: { id: stored.id } });
    expect(burnt.usedAt).not.toBeNull();
    const retried = await a.owner.post(`/v1/transfers/${tA.id}/authorize`, { passkeyAssertion: assertionA });
    expect(retried.status).toBe(401);
    expect(retried.body.code).toBe('CHALLENGE_EXPIRED');
    const refusal = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: a.ownerUser.id, action: 'auth.passkey_step_up_failed' },
    });
    expect(refusal.metadata).toMatchObject({
      purpose: 'transfer.authorize',
      reason: 'operation_mismatch',
      expected: `transfer.authorize:${tB.id}`,
      issuedFor: `transfer.authorize:${tA.id}`,
    });
    // The refused proof had no effect on the credential (signature counter untouched).
    const credential = await ctx.prisma.webAuthnCredential.findUniqueOrThrow({
      where: { credentialId: device.id },
    });
    expect(credential.counter).toBe(0n);

    // Issued for transfer A, presented for a gate approval: refused, the gate does not move.
    expect((await a.owner.post('/v1/admin/gates/R1/progress', GATE_PROGRESS)).status).toBe(200);
    const onGate = await a.owner.post('/v1/admin/gates/R1/approve', {
      ...GATE_APPROVE,
      passkeyAssertion: await stepUpAssertion(a.owner, device, forA),
    });
    expect(onGate.status).toBe(403);
    expect(onGate.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    // Neither is a revocation proof for this gate, nor an approval proof for another gate.
    for (const binding of [
      { operation: StepUpOperation.GATE_REVOKE, resourceId: 'R1' },
      { operation: StepUpOperation.GATE_APPROVE, resourceId: 'R2' },
      { operation: StepUpOperation.GATE_APPROVE },
    ]) {
      const res = await a.owner.post('/v1/admin/gates/R1/approve', {
        ...GATE_APPROVE,
        passkeyAssertion: await stepUpAssertion(a.owner, device, binding),
      });
      expect(res.status, JSON.stringify(binding)).toBe(403);
      expect(res.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    }
    expect((await ctx.prisma.regulatoryGate.findUniqueOrThrow({ where: { code: 'R1' } })).status).toBe(
      'IN_PROGRESS',
    );
    // The gate code is matched as the API normalises it (upper case).
    const approved = await a.owner.post('/v1/admin/gates/r1/approve', {
      ...GATE_APPROVE,
      passkeyAssertion: await stepUpAssertion(a.owner, device, {
        operation: StepUpOperation.GATE_APPROVE,
        resourceId: 'R1',
      }),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('PENDING_SECOND_APPROVAL');

    // Issued for transfer A, used for transfer A: authorised.
    const ok = await a.owner.post(`/v1/transfers/${tA.id}/authorize`, {
      passkeyAssertion: await stepUpAssertion(a.owner, device, forA),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('PROCESSING');

    // Codes carry no binding (single use already): a TOTP code still authorises transfer B.
    await waitForFreshTotpStep();
    const viaTotp = await a.owner.post(`/v1/transfers/${tB.id}/authorize`, {
      mfaCode: authenticator.generate(secret),
    });
    expect(viaTotp.status, JSON.stringify(viaTotp.body)).toBe(200);
    expect(viaTotp.body.status).toBe('PROCESSING');
  });

  it('rejects step-up options without a valid operation and keeps pre-MFA sessions to the login step', async () => {
    const email = 'pk-bind-options@example.com';
    const { client, user } = await registerUser(ctx, email);
    const device = new SoftwareAuthenticator();
    await registerPasskey(client, device);

    for (const body of [
      {},
      { resourceId: 'R1' },
      { operation: 'transfer.anything' },
      { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: 'two words' },
      { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: '-' },
      { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: 'x'.repeat(65) },
      { operation: StepUpOperation.MFA_DISABLE, amount: '10.00' },
    ]) {
      const res = await client.post('/v1/auth/passkeys/step-up/options', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await ctx.prisma.authChallenge.count({ where: { purpose: 'STEP_UP' } })).toBe(0);
    const noResource = await stepUpOptions(client, { operation: StepUpOperation.MFA_DISABLE });
    expect(noResource.status).toBe(200);
    const row = await ctx.prisma.authChallenge.findUniqueOrThrow({
      where: { challenge: noResource.body.challenge },
    });
    expect(row.operation).toBe('mfa.disable:-');

    // Before the login MFA step, only the login operation can be asked for.
    await enableMfa(client);
    const { client: browser, mfaRequired } = await passwordLogin(email);
    expect(mfaRequired).toBe(true);
    const early = await stepUpOptions(browser, { operation: StepUpOperation.SECURITY_PREFERENCES_LOWER });
    expect(early.status).toBe(401);
    expect(early.body.code).toBe('MFA_REQUIRED');
    const login = await browser.post('/v1/auth/mfa/verify', {
      passkeyAssertion: await stepUpAssertion(browser, device, { operation: StepUpOperation.LOGIN_MFA }),
    });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    // A login proof does not disable MFA.
    const disable = await browser.post('/v1/auth/mfa/disable', {
      passkeyAssertion: await stepUpAssertion(browser, device, { operation: StepUpOperation.LOGIN_MFA }),
    });
    expect(disable.status).toBe(403);
    expect(disable.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabled).toBe(true);
  });

  it('refuses a challenge issued before the binding existed (operation null) on a bound endpoint', async () => {
    const a = await createTransferActors(ctx);
    await fundWallet(ctx, a.orgId, 'CAD', '2000.00');
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: a.orgId,
      createdByUserId: a.ownerUser.id,
    });
    const device = new SoftwareAuthenticator();
    expect((await registerPasskey(a.owner, device)).status).toBe(201);
    await enableMfa(a.owner);
    const { transfer } = await quoteAndCreate(a.owner, beneficiary.id);
    const forTransfer = { operation: StepUpOperation.TRANSFER_AUTHORIZE, resourceId: transfer.id };

    // A STEP_UP challenge issued by the previous API version stays valid for up to 5 minutes
    // after a deploy: it records no operation, so it answers no bound action — not even the one
    // the browser meant it for.
    const options = await stepUpOptions(a.owner, forTransfer);
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    await ctx.prisma.authChallenge.update({
      where: { challenge: options.body.challenge },
      data: { operation: null },
    });
    const legacy = device.getAssertion(options.body);
    const refused = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      passkeyAssertion: legacy,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    expect((await ctx.prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe(
      transfer.status,
    );
    const refusal = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: a.ownerUser.id, action: 'auth.passkey_step_up_failed' },
    });
    expect(refusal.metadata).toMatchObject({
      purpose: 'transfer.authorize',
      reason: 'operation_mismatch',
      expected: `transfer.authorize:${transfer.id}`,
      issuedFor: null,
    });
    // Burnt by the refusal: the same assertion is not given a second chance.
    const retried = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      passkeyAssertion: legacy,
    });
    expect(retried.status).toBe(401);
    expect(retried.body.code).toBe('CHALLENGE_EXPIRED');
    // A challenge asked for this very transfer from the current API authorises it.
    const ok = await a.owner.post(`/v1/transfers/${transfer.id}/authorize`, {
      passkeyAssertion: await stepUpAssertion(a.owner, device, forTransfer),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('PROCESSING');
  });

  it('treats a server-side resource id no client could request as a programming error', () => {
    const operation = StepUpOperation.TRANSFER_AUTHORIZE;
    expect(stepUpOperationKey({ operation })).toBe('transfer.authorize:-');
    expect(stepUpOperationKey({ operation, resourceId: 'R1' })).toBe('transfer.authorize:R1');
    expect(stepUpOperationKey({ operation, resourceId: 'kms-20260101-0abc12' })).toBe(
      'transfer.authorize:kms-20260101-0abc12',
    );
    // Ids outside stepUpResourceIdSchema would make every passkey confirmation of the action a
    // 403 for every user: the mismatch is caught where the endpoint binds, not at the user's expense.
    for (const resourceId of ['', '-', 'a:b', 'doc.pdf', 'two words', 'x'.repeat(65)]) {
      expect(() => stepUpOperationKey({ operation, resourceId }), JSON.stringify(resourceId)).toThrow(
        /stepUpResourceIdSchema/,
      );
    }
  });
});

describe('MFA hardening — TOTP anti-replay and recovery codes', () => {
  it('computes the accepted TOTP step with the configured window', () => {
    const secret = authenticator.generateSecret();
    const now = Date.now();
    const code = authenticator.clone({ epoch: now }).generate(secret);
    expect(acceptedTotpStep(secret, code, now)).toBe(BigInt(Math.floor(now / 30_000)));
    expect(acceptedTotpStep(secret, code === '000000' ? '111111' : '000000', now)).toBeNull();
    expect(acceptedTotpStep(secret, code, now + 5 * 60_000)).toBeNull();
    expect(generateRecoveryCode()).toMatch(RECOVERY_RE);
  });

  it('refuses a TOTP code used twice (MFA_CODE_REUSED), across login and step-up', async () => {
    const { client, user } = await registerUser(ctx, 'totp-replay@example.com');
    const { secret } = await enableMfa(client);
    await waitForFreshTotpStep();
    const code = authenticator.generate(secret);

    const first = await passwordLogin('totp-replay@example.com');
    const ok = await first.client.post('/v1/auth/mfa/verify', { code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.method).toBe('totp');
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaLastUsedStep).toBe(BigInt(Math.floor(Date.now() / 30_000)));

    const second = await passwordLogin('totp-replay@example.com');
    const replay = await second.client.post('/v1/auth/mfa/verify', { code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_CODE_REUSED');
    expect((await second.client.get('/v1/transactions')).status).toBe(401);

    // The same code cannot lower the security preferences either.
    const lowering = await put(ctx, client, '/v1/users/me/security-preferences', {
      requireMfaForTransfers: false,
      transferAlerts: true,
      dailyTransferLimit: null,
      mfaCode: code,
    });
    expect(lowering.status).toBe(401);
    expect(lowering.body.code).toBe('MFA_CODE_REUSED');

    // Concurrent use of a fresh code: exactly one request wins.
    await ctx.prisma.user.update({ where: { id: user.id }, data: { mfaLastUsedStep: null } });
    const third = await passwordLogin('totp-replay@example.com');
    const fourth = await passwordLogin('totp-replay@example.com');
    const results = await Promise.all([
      third.client.post('/v1/auth/mfa/verify', { code }),
      fourth.client.post('/v1/auth/mfa/verify', { code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(results.find((r) => r.status === 401)!.body.code).toBe('MFA_CODE_REUSED');
  });

  it('issues 10 single-use recovery codes, accepted at the login MFA step, and regenerates them', async () => {
    const { client, user } = await registerUser(ctx, 'recovery@example.com');
    const { recoveryCodes } = await enableMfa(client);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(RECOVERY_RE);
    const rows = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(10);
    expect(
      rows.some((r) =>
        recoveryCodes.some((c) => r.codeHash.includes(c) || r.codeHash.includes(c.replace(/-/g, ''))),
      ),
    ).toBe(false);
    const summary = await client.get('/v1/auth/mfa/recovery-codes');
    expect(summary.body).toMatchObject({ remaining: 10, total: 10, nextActions: ['REGENERATE'] });

    const first = await passwordLogin('recovery@example.com');
    const used = await first.client.post('/v1/auth/mfa/verify', { code: recoveryCodes[0] });
    expect(used.status, JSON.stringify(used.body)).toBe(200);
    expect(used.body.method).toBe('recovery_code');
    expect((await first.client.get('/v1/transactions')).status).toBe(200);
    expect((await client.get('/v1/auth/mfa/recovery-codes')).body.remaining).toBe(9);
    const notification = await ctx.prisma.notification.findFirst({
      where: { userId: user.id, type: 'auth.mfa_recovery_code_used' },
    });
    expect(notification?.body).toContain('9 code(s)');
    expect(
      await ctx.prisma.auditLog.count({
        where: { actorUserId: user.id, action: 'auth.mfa_recovery_code_used' },
      }),
    ).toBe(1);

    const second = await passwordLogin('recovery@example.com');
    const reused = await second.client.post('/v1/auth/mfa/verify', { code: recoveryCodes[0] });
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('RECOVERY_CODE_INVALID');
    const unknown = await second.client.post('/v1/auth/mfa/verify', { code: 'AAAA-BBBB-CC' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('RECOVERY_CODE_INVALID');
    const malformed = await second.client.post('/v1/auth/mfa/verify', { code: 'abc' });
    expect(malformed.status).toBe(400);

    // Regeneration needs a fresh proof and invalidates every previous code.
    const bare = await client.post('/v1/auth/mfa/recovery-codes/regenerate', {});
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    const regenerated = await client.post('/v1/auth/mfa/recovery-codes/regenerate', {
      mfaCode: recoveryCodes[1],
    });
    expect(regenerated.status, JSON.stringify(regenerated.body)).toBe(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    expect((await client.get('/v1/auth/mfa/recovery-codes')).body.remaining).toBe(10);
    const old = await second.client.post('/v1/auth/mfa/verify', { code: recoveryCodes[2] });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('RECOVERY_CODE_INVALID');
    const fresh = await second.client.post('/v1/auth/mfa/verify', {
      code: regenerated.body.recoveryCodes[0],
    });
    expect(fresh.status).toBe(200);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: user.id, type: 'auth.mfa_recovery_codes_regenerated' },
      }),
    ).toBe(1);
  });
});

describe('AUTH_CLEANUP maintenance job', () => {
  it('purges expired / used challenges and sessions ended more than 7 days ago, idempotently', async () => {
    const { user } = await registerUser(ctx, 'cleanup@example.com');
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    await ctx.prisma.authChallenge.createMany({
      data: [
        { purpose: 'AUTHENTICATION', challenge: 'expired', expiresAt: new Date(now - 1000) },
        {
          purpose: 'AUTHENTICATION',
          challenge: 'used',
          expiresAt: new Date(now + 60_000),
          usedAt: new Date(),
        },
        { purpose: 'AUTHENTICATION', challenge: 'fresh', expiresAt: new Date(now + 60_000) },
      ],
    });
    const session = (tokenHash: string, data: Record<string, Date | null>) =>
      ctx.prisma.session.create({
        data: { userId: user.id, tokenHash, expiresAt: new Date(now + day), ...data },
      });
    await session('old-revoked', { revokedAt: new Date(now - 8 * day) });
    await session('old-expired', { expiresAt: new Date(now - 8 * day) });
    await session('recent-revoked', { revokedAt: new Date(now - day) });
    await session('recent-expired', { expiresAt: new Date(now - day) });
    const before = await ctx.prisma.session.count();

    const registry = ctx.app.get(JobRegistry);
    expect(registry.has('AUTH_CLEANUP')).toBe(true);
    const first = await registry.get('AUTH_CLEANUP')!({ triggeredBy: 'test' });
    expect(first.summary).toMatchObject({ challengesPurged: 2, sessionsPurged: 2, truncated: false });
    expect((await ctx.prisma.authChallenge.findMany()).map((c) => c.challenge)).toEqual(['fresh']);
    expect(await ctx.prisma.session.count()).toBe(before - 2);
    expect(
      await ctx.prisma.session.count({ where: { tokenHash: { in: ['old-revoked', 'old-expired'] } } }),
    ).toBe(0);

    const second = await registry.get('AUTH_CLEANUP')!({ triggeredBy: 'test' });
    expect(second.summary).toMatchObject({ challengesPurged: 0, sessionsPurged: 0 });
  });
});
