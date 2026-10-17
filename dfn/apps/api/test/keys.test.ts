import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyPurpose } from '@dfn/shared';
import { createApp } from '../src/bootstrap';
import { KeyRing, keyRingFor, sealString } from '../src/common/keyring';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ENV, type Env } from '../src/config/env';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import {
  ROTATION_BATCH,
  WrappingCursor,
  purposeFromTrigger,
  rotationTrigger,
} from '../src/modules/keys/key-rotation.service';
import { ZERO_UUID } from '../src/modules/keys/sealed-columns';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  Client,
  PASSWORD,
  PDF_BYTES,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { createBeneficiary } from './helpers/transfers';

const HEX = {
  d1: 'd1'.repeat(32),
  d2: 'd2'.repeat(32),
  m1: 'a1'.repeat(32),
  m2: 'a2'.repeat(32),
  w1: 'b1'.repeat(32),
  b1: 'c1'.repeat(32),
};
const RING_1 = `documents:d1:${HEX.d1},mfa:m1:${HEX.m1},webhooks:w1:${HEX.w1},beneficiaries:b1:${HEX.b1}`;
const RING_2 =
  `documents:d2:${HEX.d2},documents:d1:${HEX.d1},mfa:m2:${HEX.m2},mfa:m1:${HEX.m1},` +
  `webhooks:w1:${HEX.w1},beneficiaries:b1:${HEX.b1}`;
const WEBHOOK_SECRET = 'whsec_sandbox_rotation_test_secret';
const IBAN = 'SN08SN0101520000001234567890';

async function bootWith(overrides: Partial<Record<keyof Env, string>>): Promise<TestContext> {
  const { app } = await createApp(overrides);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
    },
  };
}

async function login(ctx: TestContext, email: string): Promise<Client> {
  const client = new Client(ctx);
  const res = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return client;
}

function downloadBytes(ctx: TestContext, client: Client, documentId: string) {
  return ctx
    .http()
    .get(`/v1/documents/${documentId}/download`)
    .set('Cookie', (client as unknown as { cookie: string }).cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

function purposeStatus(body: any, purpose: string) {
  return body.purposes.find((p: any) => p.purpose === purpose);
}

describe('rotation trigger encoding', () => {
  it('carries an optional purpose through triggeredBy', () => {
    const id = randomUUID();
    expect(rotationTrigger(id)).toBe(`manual:${id}`);
    expect(rotationTrigger(id, KeyPurpose.MFA)).toBe(`manual:${id}:purpose=mfa`);
    expect(purposeFromTrigger(`manual:${id}:purpose=mfa`)).toBe('mfa');
    expect(purposeFromTrigger('scheduler')).toBeNull();
    expect(purposeFromTrigger(`manual:${id}`)).toBeNull();
    expect(purposeFromTrigger(`manual:${id}:purpose=nope`)).toBeNull();
  });

  it('refuses to start with a malformed key ring, without echoing key material', async () => {
    const leaked = 'ab'.repeat(32);
    const { app } = await createApp({ ENCRYPTION_KEYRING: `mfa:${leaked}` });
    const err = await app.init().then(
      () => null,
      (e: unknown) => e as Error,
    );
    await app.close().catch(() => undefined);
    expect(err?.message).toMatch(/^ENCRYPTION_KEYRING is invalid: /);
    expect(err?.message).not.toContain(leaked.slice(0, 8));
  });
});

describe('key rotation (ENCRYPTION_KEY_ROTATION, /v1/admin/keys)', () => {
  let dir: string;
  let ctx: TestContext | null = null;
  const emails = {
    admin: `admin-${randomUUID().slice(0, 8)}@example.com`,
    compliance: `compliance-${randomUUID().slice(0, 8)}@example.com`,
    owner: `owner-${randomUUID().slice(0, 8)}@example.com`,
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-keys-test-'));
  });
  afterAll(async () => {
    await ctx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-seals legacy secrets and documents, keeps them readable, is idempotent and ADMIN-only', async () => {
    // ── Phase A: legacy-only key ring (phases 0–5 data) ────────────────────────────────
    ctx = await bootWith({ STORAGE_DIR: dir, ENCRYPTION_KEYRING: '' });
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const admin = await registerUser(ctx, emails.admin);
    await promote(ctx, emails.admin, 'ADMIN');
    await registerUser(ctx, emails.compliance);
    await promote(ctx, emails.compliance, 'COMPLIANCE');
    const owner = await registerUser(ctx, emails.owner);
    const orgId = owner.user.organizations[0].id as string;
    const legacyEnv = ctx.app.get<Env>(ENV);

    const mfaSecret = authenticator.generateSecret();
    await ctx.prisma.user.update({
      where: { id: owner.user.id },
      data: { mfaSecretEnc: sealString(legacyEnv, KeyPurpose.MFA, mfaSecret) },
    });
    const webhook = await ctx.prisma.webhookSubscription.create({
      data: {
        organizationId: orgId,
        createdByUserId: owner.user.id,
        url: 'https://hooks.example.com/dfn',
        secretEnc: sealString(legacyEnv, KeyPurpose.WEBHOOKS, WEBHOOK_SECRET),
        events: ['transaction.created'],
      },
    });
    const beneficiary = await createBeneficiary(ctx, {
      organizationId: orgId,
      createdByUserId: owner.user.id,
      accountIdentifier: IBAN,
    });
    const uploaded = await owner.client.upload(
      '/v1/documents',
      { kind: 'OTHER', title: 'Pièce fictive' },
      { name: 'piece.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
    );
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(201);
    const docId = uploaded.body.id as string;
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: docId } })).encryptionKeyId,
    ).toBeNull();

    let adminClient = await login(ctx, emails.admin);
    const legacyStatus = await adminClient.get('/v1/admin/keys');
    expect(legacyStatus.status).toBe(200);
    expect(legacyStatus.body.totals).toEqual({ values: 4, pendingRotation: 0, unreadable: 0 });
    for (const p of legacyStatus.body.purposes) {
      expect(p.activeKeyId).toBe('legacy');
      expect(p.keys).toEqual([{ keyId: 'legacy', active: true, configured: true, legacy: true, count: 1 }]);
    }
    expect(legacyStatus.body.nextActions).toEqual([]);
    // KMS_PROVIDER=none (phase 6 behaviour): no managed keys, nothing to generate.
    expect(legacyStatus.body.kms).toMatchObject({ provider: 'none', keyRef: null, loadFailures: [] });
    expect(legacyStatus.body.legacy).toEqual({
      decryptEnabled: true,
      values: 4,
      deletedBlobs: 0,
      safeToDisable: false,
    });
    expect(legacyStatus.body.recoveryCodes).toEqual({ secret: 'SESSION_SECRET', sessionSecretBound: 0 });
    for (const p of legacyStatus.body.purposes) {
      expect(p).toMatchObject({ managedKeys: [], legacy: { values: 1, deletedBlobs: 0 }, nextActions: [] });
    }
    const noKms = await adminClient.post('/v1/admin/keys/mfa/generate', {});
    expect(noKms.status).toBe(409);
    expect(noKms.body).toMatchObject({
      code: 'KEY_LIFECYCLE_CONFLICT',
      details: { reason: 'KMS_NOT_CONFIGURED' },
    });
    const lifecycle = await ctx.app.get(MaintenanceService).run('KEY_LIFECYCLE', 'scheduler');
    expect(lifecycle.status).toBe('COMPLETED');
    expect(lifecycle.summary).toMatchObject({ kmsProvider: 'none', activated: [], staged: [] });
    await ctx.prisma.maintenanceRun.deleteMany({ where: { jobName: 'KEY_LIFECYCLE' } }); // run counts below
    await ctx.close();
    ctx = null;

    // ── Phase B: a new active key per purpose ───────────────────────────────────────────
    ctx = await bootWith({ STORAGE_DIR: dir, ENCRYPTION_KEYRING: RING_1 });
    adminClient = await login(ctx, emails.admin);
    const compliance = await login(ctx, emails.compliance);
    const ownerClient = await login(ctx, emails.owner);

    const before = await adminClient.get('/v1/admin/keys');
    expect(before.status).toBe(200);
    expect(before.body.sandbox).toBe(true);
    expect(before.body.storage).toEqual({
      activeDriver: 'local',
      documentsByDriver: [{ driver: 'local', count: 1 }],
    });
    expect(before.body.totals).toEqual({ values: 4, pendingRotation: 4, unreadable: 0 });
    expect(before.body.nextActions).toEqual(['ROTATE']);
    expect(purposeStatus(before.body, 'documents')).toMatchObject({
      activeKeyId: 'd1',
      configuredKeyIds: ['d1', 'legacy'],
      keys: [
        { keyId: 'd1', active: true, configured: true, legacy: false, count: 0 },
        { keyId: 'legacy', active: false, configured: true, legacy: true, count: 1 },
      ],
      pendingRotation: 1,
      sources: ['document.encryptionKeyId'],
      nextActions: ['ROTATE'],
    });
    expect(purposeStatus(before.body, 'mfa')).toMatchObject({ activeKeyId: 'm1', pendingRotation: 1 });
    expect(purposeStatus(before.body, 'webhooks').sources).toEqual(['webhookSubscription.secretEnc']);
    expect(JSON.stringify(before.body)).not.toContain(HEX.d1);

    // RBAC: ADMIN only (COMPLIANCE and plain users get 403, anonymous 401)
    expect((await compliance.get('/v1/admin/keys')).status).toBe(403);
    expect((await compliance.post('/v1/admin/keys/rotate', {})).status).toBe(403);
    expect((await ownerClient.get('/v1/admin/keys')).status).toBe(403);
    expect((await ownerClient.post('/v1/admin/keys/rotate', {})).status).toBe(403);
    expect((await new Client(ctx).get('/v1/admin/keys')).status).toBe(401);
    // …nor through the generic jobs console (COMPLIANCE holds ADMIN_JOBS, not ADMIN_KEYS).
    expect((await compliance.post('/v1/admin/jobs/ENCRYPTION_KEY_ROTATION/run', {})).status).toBe(403);
    expect((await compliance.get('/v1/admin/jobs/runs?jobName=ENCRYPTION_KEY_ROTATION')).status).toBe(403);
    const complianceJobs = await compliance.get('/v1/admin/jobs');
    expect(complianceJobs.status).toBe(200);
    expect(complianceJobs.body.jobs.map((j: { name: string }) => j.name)).not.toContain(
      'ENCRYPTION_KEY_ROTATION',
    );
    expect(await ctx.prisma.maintenanceRun.count()).toBe(0);
    expect((await adminClient.post('/v1/admin/keys/rotate', { purpose: 'secrets' })).status).toBe(400);

    const beneficiaryBefore = await ctx.prisma.beneficiary.findUniqueOrThrow({
      where: { id: beneficiary.id },
    });
    const run = await adminClient.post('/v1/admin/keys/rotate', {});
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.jobName).toBe('ENCRYPTION_KEY_ROTATION');
    const runNames = async (client: Client) =>
      ((await client.get('/v1/admin/jobs/runs')).body.items as Array<{ jobName: string }>).map(
        (r) => r.jobName,
      );
    expect(await runNames(adminClient)).toContain('ENCRYPTION_KEY_ROTATION');
    expect(await runNames(compliance)).not.toContain('ENCRYPTION_KEY_ROTATION');
    expect(run.body.status).toBe('COMPLETED');
    expect(run.body.triggeredBy).toBe(`manual:${admin.user.id}`);
    expect(run.body.summary).toMatchObject({
      purpose: 'all',
      scanned: 4,
      rotated: 4,
      failed: 0,
      remaining: 0,
    });
    expect(run.body.summary.purposes).toEqual({
      documents: { activeKeyId: 'd1', scanned: 1, rotated: 1, failed: 0, remaining: 0, repaired: 0 },
      mfa: { activeKeyId: 'm1', scanned: 1, rotated: 1, failed: 0, remaining: 0 },
      webhooks: { activeKeyId: 'w1', scanned: 1, rotated: 1, failed: 0, remaining: 0 },
      beneficiaries: { activeKeyId: 'b1', scanned: 1, rotated: 1, failed: 0, remaining: 0 },
    });
    const serialized = JSON.stringify(run.body);
    for (const secret of [mfaSecret, WEBHOOK_SECRET, IBAN, HEX.m1]) expect(serialized).not.toContain(secret);

    // Everything is now sealed with the new keys and still opens to the same plaintext.
    const ring1 = keyRingFor(ctx.app.get<Env>(ENV));
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    expect(user.mfaSecretEnc).toMatch(/^k2\.mfa\.m1\./);
    const openedSecret = ring1.openString(KeyPurpose.MFA, user.mfaSecretEnc!);
    expect(openedSecret).toBe(mfaSecret);
    expect(authenticator.check(authenticator.generate(openedSecret), mfaSecret)).toBe(true);
    const hook = await ctx.prisma.webhookSubscription.findUniqueOrThrow({ where: { id: webhook.id } });
    expect(hook.secretEnc).toMatch(/^k2\.webhooks\.w1\./);
    expect(ring1.openString(KeyPurpose.WEBHOOKS, hook.secretEnc)).toBe(WEBHOOK_SECRET);
    const ben = await ctx.prisma.beneficiary.findUniqueOrThrow({ where: { id: beneficiary.id } });
    expect(ben.accountIdentifierEnc).toMatch(/^k2\.beneficiaries\.b1\./);
    expect(ring1.openString(KeyPurpose.BENEFICIARIES, ben.accountIdentifierEnc)).toBe(IBAN);
    expect(ben.updatedAt.getTime()).toBe(beneficiaryBefore.updatedAt.getTime());
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(doc.encryptionKeyId).toBe('d1');
    expect(readFileSync(join(dir, doc.storageKey)).subarray(0, 5).toString('ascii')).toBe('DFNK2');
    const download = await downloadBytes(ctx, ownerClient, docId);
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(PDF_BYTES)).toBe(true);
    expect(readdirSync(join(dir, 'rotation-tmp'))).toEqual([]);

    // A second run has nothing left to do.
    const again = await adminClient.post('/v1/admin/keys/rotate', {});
    expect(again.status).toBe(200);
    expect(again.body.summary).toMatchObject({ scanned: 0, rotated: 0, failed: 0, remaining: 0 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } })).mfaSecretEnc).toBe(
      user.mfaSecretEnc,
    );
    const after = await adminClient.get('/v1/admin/keys');
    expect(after.body.totals).toEqual({ values: 4, pendingRotation: 0, unreadable: 0 });
    expect(after.body.nextActions).toEqual([]);
    expect(after.body.lastRun).toMatchObject({ id: again.body.id, status: 'COMPLETED' });

    // Every run is audited (the job run, and the admin request).
    const runs = await ctx.prisma.auditLog.findMany({ where: { action: 'keys.rotation_run' } });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.actorUserId === admin.user.id)).toBe(true);
    expect(JSON.stringify(runs.map((r) => r.metadata))).not.toContain(mfaSecret);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.keys_rotate' } })).toBe(2);
    await ctx.close();
    ctx = null;

    // ── Phase C: rotate again (d1 → d2, m1 → m2), per purpose and via the jobs console ──
    ctx = await bootWith({ STORAGE_DIR: dir, ENCRYPTION_KEYRING: RING_2 });
    adminClient = await login(ctx, emails.admin);
    const ownerC = await login(ctx, emails.owner);
    // A value sealed with a key that is not in the ring is reported and never blocks the others.
    const stray = await registerUser(ctx, `stray-${randomUUID().slice(0, 8)}@example.com`);
    await ctx.prisma.user.update({
      where: { id: stray.user.id },
      data: { mfaSecretEnc: 'k2.mfa.zz.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
    });
    const statusC = await adminClient.get('/v1/admin/keys');
    expect(purposeStatus(statusC.body, 'mfa')).toMatchObject({
      activeKeyId: 'm2',
      configuredKeyIds: ['m2', 'm1', 'legacy'],
      pendingRotation: 2,
      unreadable: 1,
    });
    expect(purposeStatus(statusC.body, 'mfa').keys).toContainEqual({
      keyId: 'zz',
      active: false,
      configured: false,
      legacy: false,
      count: 1,
    });
    expect(purposeStatus(statusC.body, 'documents').pendingRotation).toBe(1);

    const mfaOnly = await adminClient.post('/v1/admin/keys/rotate', { purpose: 'mfa' });
    expect(mfaOnly.status).toBe(200);
    expect(mfaOnly.body.status).toBe('COMPLETED');
    expect(mfaOnly.body.triggeredBy).toBe(`manual:${admin.user.id}:purpose=mfa`);
    expect(mfaOnly.body.summary.purpose).toBe('mfa');
    expect(Object.keys(mfaOnly.body.summary.purposes)).toEqual(['mfa']);
    expect(mfaOnly.body.summary.purposes.mfa).toEqual({
      activeKeyId: 'm2',
      scanned: 2,
      rotated: 1,
      failed: 1,
      remaining: 1,
      errors: { KEY_NOT_FOUND: 1 },
    });
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id: docId } })).encryptionKeyId).toBe(
      'd1',
    );
    const ring2 = keyRingFor(ctx.app.get<Env>(ENV));
    const rotatedTwice = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } }))
      .mfaSecretEnc!;
    expect(rotatedTwice).toMatch(/^k2\.mfa\.m2\./);
    expect(ring2.openString(KeyPurpose.MFA, rotatedTwice)).toBe(mfaSecret);

    // The jobs console runs the same handler over every purpose (locking and history apply).
    const viaJobs = await adminClient.post('/v1/admin/jobs/ENCRYPTION_KEY_ROTATION/run');
    expect(viaJobs.status, JSON.stringify(viaJobs.body)).toBe(200);
    expect(viaJobs.body.summary.purposes.documents).toMatchObject({
      activeKeyId: 'd2',
      rotated: 1,
      remaining: 0,
    });
    expect(viaJobs.body.summary.purposes.mfa).toMatchObject({ rotated: 0, failed: 1, remaining: 1 });
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id: docId } })).encryptionKeyId).toBe(
      'd2',
    );
    const downloadC = await downloadBytes(ctx, ownerC, docId);
    expect(downloadC.status).toBe(200);
    expect((downloadC.body as Buffer).equals(PDF_BYTES)).toBe(true);

    // Crash between "swap" and "record key id": the blob is d2, the row still says d1.
    await ctx.prisma.document.update({ where: { id: docId }, data: { encryptionKeyId: 'd1' } });
    const repair = await adminClient.post('/v1/admin/keys/rotate', { purpose: 'documents' });
    expect(repair.body.summary.purposes.documents).toEqual({
      activeKeyId: 'd2',
      scanned: 1,
      rotated: 1,
      failed: 0,
      remaining: 0,
      repaired: 1,
    });
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id: docId } })).encryptionKeyId).toBe(
      'd2',
    );
    expect(
      await ctx.prisma.maintenanceRun.count({
        where: { jobName: 'ENCRYPTION_KEY_ROTATION', status: 'COMPLETED' },
      }),
    ).toBe(5);
  });

  it('works in bounded batches that resume where the previous run stopped', async () => {
    ctx ??= await bootWith({ STORAGE_DIR: dir, ENCRYPTION_KEYRING: RING_2 });
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const owner = await registerUser(ctx, `batch-${randomUUID().slice(0, 8)}@example.com`);
    const orgId = owner.user.organizations[0].id as string;
    const legacyRing = new KeyRing(process.env.DOCUMENT_ENCRYPTION_KEY!);
    const total = ROTATION_BATCH.beneficiaries + 5;
    await ctx.prisma.beneficiary.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        organizationId: orgId,
        createdByUserId: owner.user.id,
        name: `Bénéficiaire ${i}`,
        country: 'SN',
        currencyCode: 'XOF',
        method: 'MOBILE_MONEY' as const,
        accountIdentifierEnc: legacyRing.sealString(
          KeyPurpose.BENEFICIARIES,
          `+22177${String(i).padStart(7, '0')}`,
        ),
        accountIdentifierMasked: '••••0000',
      })),
    });
    const maintenance = ctx.app.get(MaintenanceService);
    const first = await maintenance.run('ENCRYPTION_KEY_ROTATION', 'scheduler');
    expect(first.status).toBe('COMPLETED');
    expect((first.summary as any).purposes.beneficiaries).toEqual({
      activeKeyId: 'b1',
      scanned: ROTATION_BATCH.beneficiaries,
      rotated: ROTATION_BATCH.beneficiaries,
      failed: 0,
      remaining: 5,
    });
    const second = await maintenance.run('ENCRYPTION_KEY_ROTATION', 'scheduler');
    expect((second.summary as any).purposes.beneficiaries).toMatchObject({ rotated: 5, remaining: 0 });
    const third = await maintenance.run('ENCRYPTION_KEY_ROTATION', 'scheduler');
    expect(third.summary).toMatchObject({ scanned: 0, rotated: 0, failed: 0, remaining: 0 });

    const ring = keyRingFor(ctx.app.get<Env>(ENV));
    const rows = await ctx.prisma.beneficiary.findMany({ orderBy: { name: 'asc' } });
    expect(rows).toHaveLength(total);
    for (const row of rows) {
      expect(row.accountIdentifierEnc.startsWith('k2.beneficiaries.b1.')).toBe(true);
      expect(ring.openString(KeyPurpose.BENEFICIARIES, row.accountIdentifierEnc)).toMatch(/^\+22177\d{7}$/);
    }
    // Scheduler runs are audited too, without an actor.
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'keys.rotation_run' } });
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actorUserId === null)).toBe(true);
  });
});

describe('rotation scan cursor', () => {
  it('starts at a random point, runs to the end, then wraps once up to its start', () => {
    const start = '80000000-0000-4000-8000-000000000000';
    const cursor = new WrappingCursor(start);
    expect(cursor.after).toBe(start);
    expect(cursor.until).toBeUndefined();
    expect(cursor.wrap()).toBe(true);
    expect(cursor.after).toBe(ZERO_UUID);
    expect(cursor.until).toBe(start);
    expect(cursor.wrap()).toBe(false);
    // Rows that keep failing cannot pin every run to the same window.
    const starts = new Set(Array.from({ length: 5 }, () => new WrappingCursor().after));
    expect(starts.size).toBe(5);
  });
});
