import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import {
  CreateKeyCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
  type KMSClientConfig,
} from '@aws-sdk/client-kms';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '@dfn/database';
import { ErrorCode, KeyPurpose, MANAGED_KEY_ID_PATTERN, StepUpOperation } from '@dfn/shared';
import { createApp } from '../src/bootstrap';
import { DomainError } from '../src/common/domain-error';
import { KeyRing, KeyRingError, LEGACY_KEY_ID, keyRingFor, sealString } from '../src/common/keyring';
import {
  AwsKmsProvider,
  LocalKmsProvider,
  awsKmsFailureReason,
  createKmsProvider,
  kmsUnavailable,
  type KmsProvider,
} from '../src/common/kms';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { ENV, type Env } from '../src/config/env';
import { RecoveryCodesService } from '../src/modules/auth/recovery-codes.service';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { KeysService } from '../src/modules/keys/keys.service';
import { ManagedKeysService } from '../src/modules/keys/managed-keys.service';
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
import { SoftwareAuthenticator, enableMfa, registerPasskey, stepUpAssertion } from './helpers/webauthn';

const LEGACY_HEX = '1'.repeat(64);
const A_HEX = 'a1'.repeat(32);
const DAY_MS = 24 * 3600_000;

async function caught(promise: Promise<unknown>): Promise<any> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

// ── KMS providers ──────────────────────────────────────────────────────────────────────────

describe('local KMS provider', () => {
  const master = randomBytes(32).toString('hex');
  const kms = new LocalKmsProvider(master);
  const context = { purpose: 'mfa', keyId: 'kms-20261012-abcdef' };

  it('wraps and unwraps a data key bound to its encryption context', async () => {
    const dataKey = randomBytes(32);
    const wrapped = await kms.wrap(dataKey, context);
    expect(wrapped.includes(dataKey)).toBe(false);
    expect((await kms.unwrap(wrapped, context)).equals(dataKey)).toBe(true);
    expect((await kms.unwrap(wrapped, context, kms.keyRef)).equals(dataKey)).toBe(true);
    // The key reference is a short fingerprint, never (part of) the master key.
    expect(kms.keyRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(master).not.toContain(kms.keyRef.slice('sha256:'.length));
    // Two wraps of the same key differ (random IV).
    expect((await kms.wrap(dataKey, context)).equals(wrapped)).toBe(false);
  });

  it('refuses another context, another master key and tampered bytes with 503 KMS_UNAVAILABLE', async () => {
    const wrapped = await kms.wrap(randomBytes(32), context);
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] ^= 0x01;
    const attempts: Array<[Promise<Buffer>, string]> = [
      [kms.unwrap(wrapped, { ...context, keyId: 'kms-20261012-000000' }), 'INVALID_CIPHERTEXT'],
      [kms.unwrap(wrapped, { ...context, purpose: 'webhooks' }), 'INVALID_CIPHERTEXT'],
      [new LocalKmsProvider(randomBytes(32).toString('hex')).unwrap(wrapped, context), 'INVALID_CIPHERTEXT'],
      [kms.unwrap(wrapped, context, 'sha256:0000000000000000'), 'MASTER_KEY_MISMATCH'],
      [kms.unwrap(tampered, context), 'INVALID_CIPHERTEXT'],
      [kms.unwrap(wrapped.subarray(0, 20), context), 'INVALID_CIPHERTEXT'],
      [kms.wrap(randomBytes(16), context), 'INVALID_KEY_LENGTH'],
    ];
    for (const [attempt, reason] of attempts) {
      const err = await caught(attempt);
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toMatchObject({ code: ErrorCode.KMS_UNAVAILABLE, status: 503, details: { reason } });
      expect(err.message).not.toContain(master);
    }
  });

  it('maps AWS errors to stable reasons and builds providers from the environment', () => {
    expect(awsKmsFailureReason({ name: 'AccessDeniedException' })).toBe('ACCESS_DENIED');
    expect(awsKmsFailureReason({ name: 'NotFoundException' })).toBe('KEY_NOT_FOUND');
    expect(awsKmsFailureReason({ name: 'InvalidCiphertextException' })).toBe('INVALID_CIPHERTEXT');
    // Decrypt pinned to KMS_KEY_ID, ciphertext of another key (KMS_KEY_ID changed): not corruption.
    expect(awsKmsFailureReason({ name: 'IncorrectKeyException' })).toBe('MASTER_KEY_MISMATCH');
    expect(awsKmsFailureReason({ name: 'KMSInvalidStateException' })).toBe('KEY_DISABLED');
    expect(awsKmsFailureReason({ code: 'ECONNREFUSED' })).toBe('UNREACHABLE');
    expect(awsKmsFailureReason({ $metadata: { httpStatusCode: 503 } })).toBe('UNREACHABLE');
    expect(awsKmsFailureReason(new Error('arn:aws:kms:eu-west-3:123456789012:key/x'))).toBe('ERROR');

    const base = {
      KMS_LOCAL_MASTER_KEY: undefined,
      KMS_KEY_ID: undefined,
      KMS_REGION: undefined,
      KMS_ENDPOINT: undefined,
    };
    expect(createKmsProvider({ ...base, KMS_PROVIDER: 'none' })).toBeNull();
    const local = createKmsProvider({ ...base, KMS_PROVIDER: 'local', KMS_LOCAL_MASTER_KEY: A_HEX });
    expect(local).toBeInstanceOf(LocalKmsProvider);
    expect(local?.name).toBe('local');
    const aws = createKmsProvider({
      ...base,
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'alias/dfn-sandbox',
      KMS_REGION: 'eu-west-3',
    });
    expect(aws).toBeInstanceOf(AwsKmsProvider);
    expect(aws?.keyRef).toBe('alias/dfn-sandbox');
  });
});

const KMS_TEST_ENDPOINT = process.env.KMS_TEST_ENDPOINT;
const describeLiveKms = KMS_TEST_ENDPOINT ? describe : describe.skip;

describeLiveKms(
  KMS_TEST_ENDPOINT
    ? `AWS KMS provider (live, ${KMS_TEST_ENDPOINT})`
    : 'AWS KMS provider (live) — skipped: set KMS_TEST_ENDPOINT (e.g. http://127.0.0.1:5055 for moto) to run it',
  () => {
    let client: KMSClient;
    let keyId: string;

    /** Test client. moto answers with a duplicated Date header that breaks the SDK clock-skew correction. */
    function testClient(endpoint: string, extra: Partial<KMSClientConfig> = {}) {
      const kms = new KMSClient({
        region: process.env.KMS_TEST_REGION ?? 'us-east-1',
        endpoint,
        credentials: process.env.AWS_ACCESS_KEY_ID
          ? undefined
          : { accessKeyId: 'test', secretAccessKey: 'test' },
        systemClockOffset: 0,
        ...extra,
      });
      const strip = (response: unknown) => {
        const headers = (response as { headers?: Record<string, string> } | undefined)?.headers;
        for (const name of Object.keys(headers ?? {}))
          if (name.toLowerCase() === 'date') delete headers![name];
      };
      kms.middlewareStack.add(
        (next) => async (args) => {
          try {
            const result = await next(args);
            strip(result.response);
            return result;
          } catch (err) {
            strip((err as { $response?: unknown }).$response);
            throw err;
          }
        },
        { step: 'deserialize', name: 'testDropDateHeader', priority: 'low' },
      );
      return kms;
    }

    beforeAll(async () => {
      client = testClient(KMS_TEST_ENDPOINT!);
      const created = await client.send(new CreateKeyCommand({ Description: 'dfn kms.test.ts (sandbox)' }));
      keyId = created.KeyMetadata!.KeyId!;
    });
    afterAll(async () => {
      await client
        ?.send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }))
        .catch(() => undefined);
    });

    it('wraps with Encrypt and unwraps with Decrypt under the encryption context', async () => {
      const kms = new AwsKmsProvider({ client, keyId });
      expect(kms.name).toBe('aws');
      expect(kms.keyRef).toBe(keyId);
      const dataKey = randomBytes(32);
      const context = { purpose: 'documents', keyId: 'kms-20261012-0a0b0c' };
      const wrapped = await kms.wrap(dataKey, context);
      expect(wrapped.includes(dataKey)).toBe(false);
      expect((await kms.unwrap(wrapped, context)).equals(dataKey)).toBe(true);
      // Through the provider interface (the recorded reference is ignored: Decrypt is pinned).
      // moto does not enforce the KeyId of Decrypt (it opens a ciphertext of another key), so the
      // IncorrectKeyException → MASTER_KEY_MISMATCH mapping is pinned by the unit test above only.
      const asProvider: KmsProvider = kms;
      expect((await asProvider.unwrap(wrapped, context, 'alias/recorded-elsewhere')).equals(dataKey)).toBe(
        true,
      );

      // Another encryption context is refused by the KMS itself.
      const wrongContext = await caught(kms.unwrap(wrapped, { ...context, purpose: 'mfa' }));
      expect(wrongContext).toMatchObject({
        code: ErrorCode.KMS_UNAVAILABLE,
        status: 503,
        details: { provider: 'aws', operation: 'unwrap', reason: 'INVALID_CIPHERTEXT' },
      });
    });

    it('maps KMS failures without echoing provider messages (ARNs, account ids)', async () => {
      const missing = new AwsKmsProvider({ client, keyId: 'alias/dfn-does-not-exist' });
      const err = await caught(
        missing.wrap(randomBytes(32), { purpose: 'mfa', keyId: 'kms-20261012-000001' }),
      );
      expect(err).toMatchObject({ code: ErrorCode.KMS_UNAVAILABLE, details: { reason: 'KEY_NOT_FOUND' } });
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toMatch(/arn:|\d{12}/);

      const unreachable = new AwsKmsProvider({
        client: testClient('http://127.0.0.1:9', { maxAttempts: 1 }),
        keyId,
      });
      const down = await caught(
        unreachable.wrap(randomBytes(32), { purpose: 'mfa', keyId: 'kms-20261012-000002' }),
      );
      expect(down).toMatchObject({ code: ErrorCode.KMS_UNAVAILABLE, details: { reason: 'UNREACHABLE' } });
    });
  },
);

// ── Key ring: managed layer and legacy retirement ───────────────────────────────────────────

describe('KeyRing managed layer', () => {
  const k1 = 'kms-20261012-aaaaaa';
  const k2 = 'kms-20261013-bbbbbb';

  it('lets an ACTIVE managed key override the environment key; staged keys only open', () => {
    const ring = new KeyRing(LEGACY_HEX, `mfa:m1:${A_HEX}`);
    const sealedM1 = ring.sealString(KeyPurpose.MFA, 'one');
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);

    ring.setManagedKeys([{ purpose: KeyPurpose.MFA, keyId: k1, key: key1, active: false }]);
    expect(ring.activeKeyId(KeyPurpose.MFA)).toBe('m1');
    expect(ring.hasKey(KeyPurpose.MFA, k1)).toBe(true);
    expect(ring.hasKey(KeyPurpose.WEBHOOKS, k1)).toBe(false);

    ring.setManagedKeys([
      { purpose: KeyPurpose.MFA, keyId: k1, key: key1, active: true },
      { purpose: KeyPurpose.MFA, keyId: k2, key: key2, active: false },
    ]);
    expect(ring.activeKeyId(KeyPurpose.MFA)).toBe(k1);
    expect(ring.keyIds(KeyPurpose.MFA)).toEqual([k1, 'm1', k2, LEGACY_KEY_ID]);
    expect(ring.managedKeyIds(KeyPurpose.MFA).sort()).toEqual([k1, k2]);
    const sealedK1 = ring.sealString(KeyPurpose.MFA, 'two');
    expect(sealedK1.startsWith(`k2.mfa.${k1}.`)).toBe(true);
    expect(ring.openString(KeyPurpose.MFA, sealedM1)).toBe('one');
    expect(ring.openString(KeyPurpose.MFA, sealedK1)).toBe('two');
    expect(ring.needsRotation(KeyPurpose.MFA, 'm1')).toBe(true);
    // Other purposes are untouched.
    expect(ring.activeKeyId(KeyPurpose.WEBHOOKS)).toBe(LEGACY_KEY_ID);
    const blob = ring.sealBuffer(KeyPurpose.DOCUMENTS, Buffer.from('%PDF'));
    expect(blob.keyId).toBe(LEGACY_KEY_ID);

    // Invalid sets are refused as a whole: the ring keeps its previous managed keys.
    expect(() =>
      ring.setManagedKeys([{ purpose: KeyPurpose.MFA, keyId: 'm2', key: key1, active: false }]),
    ).toThrow(/invalid/);
    expect(() =>
      ring.setManagedKeys([{ purpose: KeyPurpose.MFA, keyId: k1, key: randomBytes(16), active: false }]),
    ).toThrow(/32 bytes/);
    expect(() =>
      ring.setManagedKeys([
        { purpose: KeyPurpose.MFA, keyId: k1, key: key1, active: true },
        { purpose: KeyPurpose.MFA, keyId: k2, key: key2, active: true },
      ]),
    ).toThrow(/Two active/);
    expect(ring.activeKeyId(KeyPurpose.MFA)).toBe(k1);

    // A retired key leaves the ring: what it sealed no longer opens.
    ring.setManagedKeys([]);
    expect(ring.activeKeyId(KeyPurpose.MFA)).toBe('m1');
    expect(() => ring.openString(KeyPurpose.MFA, sealedK1)).toThrow(KeyRingError);

    // The "kms-" prefix is reserved: ENCRYPTION_KEYRING cannot shadow a managed key.
    expect(() => new KeyRing(LEGACY_HEX, `mfa:kms-1:${A_HEX}`)).toThrow(/reserved/);
  });

  it('refuses legacy values once ENCRYPTION_LEGACY_DECRYPT=false', () => {
    const legacyRing = new KeyRing(LEGACY_HEX);
    const legacyValue = legacyRing.sealString(KeyPurpose.MFA, 'old');
    const legacyBlob = legacyRing.sealBuffer(KeyPurpose.DOCUMENTS, Buffer.from('%PDF')).sealed;
    const ring = new KeyRing(LEGACY_HEX, `mfa:m1:${A_HEX}`, { legacyDecrypt: false });
    expect(ring.legacyDecrypt).toBe(false);
    expect(() => ring.openString(KeyPurpose.MFA, legacyValue)).toThrow(KeyRingError);
    expect(() => ring.openBuffer(KeyPurpose.DOCUMENTS, legacyBlob, null)).toThrow(
      /ENCRYPTION_LEGACY_DECRYPT/,
    );
    expect(ring.hasKey(KeyPurpose.MFA, LEGACY_KEY_ID)).toBe(false);
    expect(ring.hasKey(KeyPurpose.MFA, null)).toBe(false);
    expect(ring.keyIds(KeyPurpose.MFA)).toEqual(['m1']);
    expect(ring.openString(KeyPurpose.MFA, ring.sealString(KeyPurpose.MFA, 'new'))).toBe('new');
    // Without an active key nothing can be sealed (the retired legacy key would make it unreadable).
    expect(() => ring.sealString(KeyPurpose.WEBHOOKS, 'x')).toThrow(/No active key/);
    expect(() => ring.sealBuffer(KeyPurpose.DOCUMENTS, Buffer.from('x'))).toThrow(KeyRingError);

    // keyRingFor reads the flag (absent = legacy decryption allowed, the phase 6 behaviour).
    expect(
      keyRingFor({
        DOCUMENT_ENCRYPTION_KEY: LEGACY_HEX,
        ENCRYPTION_KEYRING: undefined,
        ENCRYPTION_LEGACY_DECRYPT: false,
      }).legacyDecrypt,
    ).toBe(false);
    expect(
      keyRingFor({ DOCUMENT_ENCRYPTION_KEY: LEGACY_HEX, ENCRYPTION_KEYRING: undefined }).legacyDecrypt,
    ).toBe(true);
  });
});

// ── Managed keys end to end (local KMS, database dfn_test_kms) ───────────────────────────────

/** Removes managed keys left by an interrupted run: a boot with another master key would refuse them. */
async function dropManagedKeys() {
  const db = createPrismaClient({ url: process.env.DATABASE_URL });
  try {
    await db.encryptionKey.deleteMany();
  } finally {
    await db.$disconnect();
  }
}

async function boot(overrides: Partial<Record<keyof Env, string>>): Promise<TestContext> {
  const { app } = await createApp(overrides);
  await app.init();
  return {
    app,
    prisma: app.get(PrismaService),
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

const ringOf = (ctx: TestContext) => keyRingFor(ctx.app.get<Env>(ENV));
const purposeOf = (body: any, purpose: string) => body.purposes.find((p: any) => p.purpose === purpose);

async function runLifecycle(ctx: TestContext) {
  const run = await ctx.app.get(MaintenanceService).run('KEY_LIFECYCLE', 'scheduler');
  expect(run.status, JSON.stringify(run)).toBe('COMPLETED');
  return run.summary as any;
}

/** Skips the activation delay of the staged key of `purpose`. */
async function makeDue(ctx: TestContext, purpose: string) {
  await ctx.prisma.encryptionKey.updateMany({
    where: { purpose, status: 'STAGED' },
    data: { activateAfter: new Date(Date.now() - 1000) },
  });
}

describe('KMS-managed data keys (KMS_PROVIDER=local)', () => {
  const master = randomBytes(32).toString('hex');
  const keyRef = new LocalKmsProvider(master).keyRef;
  const kmsEnv = { KMS_PROVIDER: 'local', KMS_LOCAL_MASTER_KEY: master } as const;
  const tag = randomUUID().slice(0, 8);
  const emails = {
    admin: `kms-admin-${tag}@example.com`,
    admin2: `kms-admin2-${tag}@example.com`,
    admin3: `kms-admin3-${tag}@example.com`,
    compliance: `kms-compliance-${tag}@example.com`,
    owner: `kms-owner-${tag}@example.com`,
  };
  const MFA_SECRET = 'JBSWY3DPEHPK3PXP';
  let dir: string;
  let a: TestContext | null = null;
  let b: TestContext | null = null;
  let adminA: Client;
  let ownerId: string;
  let ownerClient: Client;
  let k1 = '';
  let k2 = '';
  let d1 = '';
  let staleK1Value = '';
  let deletedDocId = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-kms-test-'));
    await dropManagedKeys();
    a = await boot({ ...kmsEnv, STORAGE_DIR: dir, INSTANCE_ID: `kms-a-${tag}` });
    await resetDatabase(a.prisma);
    await a.app.get(ReferenceDataService).ensure();
    await registerUser(a, emails.admin);
    await promote(a, emails.admin, 'ADMIN');
    await registerUser(a, emails.compliance);
    await promote(a, emails.compliance, 'COMPLIANCE');
    const owner = await registerUser(a, emails.owner);
    ownerId = owner.user.id;
    ownerClient = owner.client;
    adminA = await login(a, emails.admin);
  });

  afterAll(async () => {
    await b?.close();
    await a?.close();
    await dropManagedKeys();
    rmSync(dir, { recursive: true, force: true });
  });

  it('generate → STAGED → KEY_LIFECYCLE → ACTIVE: new values are sealed with it, old ones still open', async () => {
    const ctx = a!;
    const envA = ctx.app.get<Env>(ENV);
    // Phase 0–6 data: a legacy-sealed secret and a legacy-sealed document.
    const legacySecret = sealString(envA, KeyPurpose.MFA, MFA_SECRET);
    await ctx.prisma.user.update({ where: { id: ownerId }, data: { mfaSecretEnc: legacySecret } });
    const upload = (title: string) =>
      ownerClient.upload(
        '/v1/documents',
        { kind: 'OTHER', title },
        { name: 'piece.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
      );
    const legacyDoc = await upload('Pièce fictive (legacy)');
    expect(legacyDoc.status, JSON.stringify(legacyDoc.body)).toBe(201);
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: legacyDoc.body.id } })).encryptionKeyId,
    ).toBeNull();

    const before = await adminA.get('/v1/admin/keys');
    expect(before.status).toBe(200);
    expect(before.body.kms).toMatchObject({
      provider: 'local',
      keyRef,
      activationDelaySeconds: 300,
      refreshSeconds: 60,
      rotationIntervalDays: 0,
      loadFailures: [],
    });
    expect(purposeOf(before.body, 'mfa')).toMatchObject({
      activeKeyId: 'legacy',
      managedKeys: [],
      legacy: { values: 1, deletedBlobs: 0 },
      nextActions: ['GENERATE'],
    });
    expect(before.body.legacy).toMatchObject({ decryptEnabled: true, values: 2, safeToDisable: false });

    // RBAC: admin:keys only.
    const compliance = await login(ctx, emails.compliance);
    expect((await compliance.post('/v1/admin/keys/mfa/generate', {})).status).toBe(403);
    expect((await ownerClient.post('/v1/admin/keys/mfa/generate', {})).status).toBe(403);
    expect((await adminA.post('/v1/admin/keys/secrets/generate', {})).status).toBe(400);
    expect((await adminA.post('/v1/admin/keys/mfa/generate', { extra: true })).status).toBe(400);

    const generated = await adminA.post('/v1/admin/keys/mfa/generate', {});
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    expect(generated.body).toMatchObject({
      purpose: 'mfa',
      status: 'STAGED',
      kmsProvider: 'local',
      kmsKeyRef: keyRef,
    });
    expect(generated.body.keyId).toMatch(MANAGED_KEY_ID_PATTERN);
    expect(generated.body).not.toHaveProperty('wrappedKey');
    expect(new Date(generated.body.activateAfter).getTime()).toBeGreaterThan(Date.now() + 250_000);
    k1 = generated.body.keyId;
    const docs = await adminA.post('/v1/admin/keys/documents/generate', {});
    expect(docs.status, JSON.stringify(docs.body)).toBe(201);
    d1 = docs.body.keyId;

    // Staged: loaded for decryption, not used to seal.
    expect(ringOf(ctx).activeKeyId(KeyPurpose.MFA)).toBe(LEGACY_KEY_ID);
    expect(ringOf(ctx).hasKey(KeyPurpose.MFA, k1)).toBe(true);
    const row = await ctx.prisma.encryptionKey.findFirstOrThrow({ where: { keyId: k1 } });
    expect(Buffer.from(row.wrappedKey).length).toBe(8 + 12 + 16 + 32);
    // One staged key at a time per purpose.
    const twice = await adminA.post('/v1/admin/keys/mfa/generate', {});
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({
      code: 'KEY_LIFECYCLE_CONFLICT',
      details: { reason: 'STAGED_KEY_EXISTS', keyId: k1 },
    });
    const staged = await adminA.get('/v1/admin/keys');
    expect(purposeOf(staged.body, 'mfa').nextActions).toEqual([]);
    expect(purposeOf(staged.body, 'mfa').managedKeys).toMatchObject([
      { keyId: k1, status: 'STAGED', loaded: true, count: 0, nextActions: [] },
    ]);
    expect(JSON.stringify(staged.body)).not.toContain(master);

    // Not due yet: the job leaves it staged.
    expect((await runLifecycle(ctx)).activated).toEqual([]);
    await makeDue(ctx, 'mfa');
    await makeDue(ctx, 'documents');
    const lifecycle = await runLifecycle(ctx);
    expect(lifecycle.activated).toEqual([
      { purpose: 'documents', keyId: d1, previousKeyId: 'legacy' },
      { purpose: 'mfa', keyId: k1, previousKeyId: 'legacy' },
    ]);
    expect(lifecycle.rotation).toMatchObject({ status: 'COMPLETED' });
    expect(ringOf(ctx).activeKeyId(KeyPurpose.MFA)).toBe(k1);

    // The rotation that followed moved the stored values to the new keys; they still open.
    const owner = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(owner.mfaSecretEnc!.startsWith(`k2.mfa.${k1}.`)).toBe(true);
    expect(ringOf(ctx).openString(KeyPurpose.MFA, owner.mfaSecretEnc!)).toBe(MFA_SECRET);
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: legacyDoc.body.id } })).encryptionKeyId,
    ).toBe(d1);
    const download = await ownerClient.get(`/v1/documents/${legacyDoc.body.id}/download`);
    expect(download.status).toBe(200);
    // New values are sealed with the managed key; values sealed before still open.
    expect(sealString(envA, KeyPurpose.MFA, 'fresh').startsWith(`k2.mfa.${k1}.`)).toBe(true);
    expect(ringOf(ctx).openString(KeyPurpose.MFA, legacySecret)).toBe(MFA_SECRET);
    const fresh = await upload('Pièce fictive (clé gérée)');
    expect(fresh.status).toBe(201);
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: fresh.body.id } })).encryptionKeyId,
    ).toBe(d1);
    staleK1Value = sealString(envA, KeyPurpose.MFA, MFA_SECRET);
    // A document deleted while d1 is active: its blob is retained until the purge.
    deletedDocId = (await upload('Pièce supprimée')).body.id;
    expect((await ownerClient.delete(`/v1/documents/${deletedDocId}`)).status).toBeLessThan(300);

    // Audited, ids only.
    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: { in: ['keys.generated', 'keys.activated'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((x) => x.action)).toEqual([
      'keys.generated',
      'keys.generated',
      'keys.activated',
      'keys.activated',
    ]);
    expect(audits[0]!.metadata).toMatchObject({
      purpose: 'mfa',
      keyId: k1,
      kmsProvider: 'local',
      trigger: 'manual',
    });
    expect(JSON.stringify(audits)).not.toContain(master);
  });

  it('a second replica opens values sealed with a new key once it has refreshed', async () => {
    b = await boot({
      ...kmsEnv,
      STORAGE_DIR: dir,
      INSTANCE_ID: `kms-b-${tag}`,
      KEY_ROTATION_INTERVAL_DAYS: '30',
    });
    // Replica B loaded every managed key at boot.
    expect(ringOf(b).activeKeyId(KeyPurpose.MFA)).toBe(k1);
    expect(ringOf(b).openString(KeyPurpose.MFA, staleK1Value)).toBe(MFA_SECRET);

    const generated = await adminA.post('/v1/admin/keys/mfa/generate', {});
    expect(generated.status).toBe(201);
    k2 = generated.body.keyId;
    expect(ringOf(b).hasKey(KeyPurpose.MFA, k2)).toBe(false);
    await makeDue(a!, 'mfa');
    const lifecycle = await runLifecycle(a!);
    expect(lifecycle.activated).toEqual([{ purpose: 'mfa', keyId: k2, previousKeyId: k1 }]);
    const sealedByA = sealString(a!.app.get<Env>(ENV), KeyPurpose.MFA, 'sealed-by-replica-a');
    expect(sealedByA.startsWith(`k2.mfa.${k2}.`)).toBe(true);

    // B has not refreshed yet: it does not know k2 (the activation delay normally covers this).
    expect(() => ringOf(b!).openString(KeyPurpose.MFA, sealedByA)).toThrow(KeyRingError);
    const state = await b.app.get(ManagedKeysService).refresh();
    expect(state).toMatchObject({ failures: [], error: null });
    expect(ringOf(b).openString(KeyPurpose.MFA, sealedByA)).toBe('sealed-by-replica-a');
    expect(ringOf(b).activeKeyId(KeyPurpose.MFA)).toBe(k2);
    // k1 is now decrypt-only, on both replicas.
    expect(ringOf(b).hasKey(KeyPurpose.MFA, k1)).toBe(true);
    expect((await a!.prisma.encryptionKey.findFirstOrThrow({ where: { keyId: k1 } })).status).toBe(
      'DECRYPT_ONLY',
    );
  });

  it('scheduled rotation stages a new key when the active one is older than the interval', async () => {
    const ctx = b!;
    // k2 has just been activated: nothing to do.
    expect((await runLifecycle(ctx)).staged).toEqual([]);
    await ctx.prisma.encryptionKey.updateMany({
      where: { purpose: 'mfa', status: 'ACTIVE' },
      data: { activatedAt: new Date(Date.now() - 31 * DAY_MS) },
    });
    const summary = await runLifecycle(ctx);
    expect(summary.staged).toEqual([
      {
        purpose: 'mfa',
        keyId: expect.stringMatching(MANAGED_KEY_ID_PATTERN),
        activateAfter: expect.any(String),
        reason: 'SCHEDULED',
      },
    ]);
    // Purposes without a managed key, or with a recent one, are left alone; nothing staged twice.
    expect((await runLifecycle(ctx)).staged).toEqual([]);
    const scheduled = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'keys.rotation_scheduled' },
    });
    expect(scheduled.actorUserId).toBeNull();
    expect(scheduled.metadata).toMatchObject({ purpose: 'mfa', replaces: k2, intervalDays: 30 });
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'keys.generated', metadata: { path: ['trigger'], equals: 'scheduled' } },
      }),
    ).toBe(1);
  });

  it('after boot, a key the KMS cannot unwrap is reported; loaded keys stay and its purpose is not rotated', async () => {
    const ctx = b!;
    // An ACTIVE key this replica cannot unwrap (as if the KMS refused it after boot).
    const planted = await ctx.prisma.encryptionKey.create({
      data: {
        purpose: 'beneficiaries',
        keyId: 'kms-20261012-ffffff',
        status: 'ACTIVE',
        wrappedKey: new Uint8Array(randomBytes(68)),
        kmsProvider: 'local',
        kmsKeyRef: keyRef,
        activatedAt: new Date(),
      },
    });
    try {
      const managed = ctx.app.get(ManagedKeysService);
      const state = await managed.refresh();
      expect(state.failures).toEqual([
        {
          purpose: 'beneficiaries',
          keyId: 'kms-20261012-ffffff',
          status: 'ACTIVE',
          reason: 'INVALID_CIPHERTEXT',
        },
      ]);
      // Keys loaded before stay in use; the purpose falls back to a key every replica holds.
      expect(ringOf(ctx).activeKeyId(KeyPurpose.MFA)).toBe(k2);
      expect(ringOf(ctx).activeKeyId(KeyPurpose.BENEFICIARIES)).toBe(LEGACY_KEY_ID);
      const status = await ctx.app.get(KeysService).status();
      expect(status.kms.loadFailures).toHaveLength(1);
      // The public health endpoint reports the failure as counts only: no key id, no purpose.
      const degraded = await ctx.http().get('/v1/health');
      expect(degraded.status).toBe(200);
      expect(degraded.body).toMatchObject({
        status: 'degraded',
        managedKeys: { failing: 1, refreshError: false },
      });
      expect(JSON.stringify(degraded.body)).not.toContain('kms-20261012-ffffff');
      expect(purposeOf(status, 'beneficiaries').managedKeys[0]).toMatchObject({
        status: 'ACTIVE',
        loaded: false,
      });
      // The rotation does not move values away from a key it cannot use.
      const run = await ctx.app.get(MaintenanceService).run('ENCRYPTION_KEY_ROTATION', 'scheduler');
      expect((run.summary as any).purposes.beneficiaries).toMatchObject({
        activeKeyId: 'kms-20261012-ffffff',
        rotated: 0,
        skipped: 'ACTIVE_KEY_NOT_LOADED',
      });
    } finally {
      await ctx.prisma.encryptionKey.delete({ where: { id: planted.id } });
    }
    expect((await ctx.app.get(ManagedKeysService).refresh()).failures).toEqual([]);
    const healthy = await ctx.http().get('/v1/health');
    expect(healthy.body).toMatchObject({ status: 'ok', managedKeys: { failing: 0, refreshError: false } });
    expect(healthy.body.managedKeys.loaded).toBeGreaterThan(0);
  });

  it('retires a decrypt-only key only once nothing references it any more', async () => {
    const ctx = a!;
    const retireK1 = `/v1/admin/keys/mfa/${k1}/retire`;
    // Every replica must have stopped sealing with it first.
    const early = await adminA.post(retireK1, {});
    expect(early.status).toBe(409);
    expect(early.body.details).toMatchObject({ reason: 'RECENTLY_DEACTIVATED' });
    await ctx.prisma.encryptionKey.updateMany({
      where: { keyId: k1 },
      data: { deactivatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    // A value still sealed with k1 (written by a replica that had not refreshed yet).
    await ctx.prisma.user.update({ where: { id: ownerId }, data: { mfaSecretEnc: staleK1Value } });
    const inUse = await adminA.post(retireK1, {});
    expect(inUse.status).toBe(409);
    expect(inUse.body).toMatchObject({
      code: 'KEY_LIFECYCLE_CONFLICT',
      details: {
        reason: 'KEY_IN_USE',
        references: { values: 1, deletedBlobs: 0, pendingDocuments: 0, total: 1 },
      },
    });
    const status = await adminA.get('/v1/admin/keys');
    const k1Dto = purposeOf(status.body, 'mfa').managedKeys.find((k: any) => k.keyId === k1);
    expect(k1Dto).toMatchObject({
      status: 'DECRYPT_ONLY',
      count: 1,
      nextActions: [],
      retireBlocker: { reason: 'KEY_IN_USE' },
    });

    // Re-encrypt, then retire.
    const rotated = await adminA.post('/v1/admin/keys/rotate', { purpose: 'mfa' });
    expect(rotated.body.summary.purposes.mfa).toMatchObject({ rotated: 1, remaining: 0 });
    const ready = await adminA.get('/v1/admin/keys');
    expect(purposeOf(ready.body, 'mfa').managedKeys.find((k: any) => k.keyId === k1).nextActions).toEqual([
      'RETIRE',
    ]);
    const retired = await adminA.post(retireK1, {});
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ keyId: k1, status: 'RETIRED' });
    expect(retired.body.retiredAt).toBeTruthy();
    // Retired keys are no longer loaded, on any replica.
    expect(ringOf(ctx).hasKey(KeyPurpose.MFA, k1)).toBe(false);
    await b!.app.get(ManagedKeysService).refresh();
    expect(ringOf(b!).hasKey(KeyPurpose.MFA, k1)).toBe(false);
    const owner = await ctx.prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    expect(ringOf(ctx).openString(KeyPurpose.MFA, owner.mfaSecretEnc!)).toBe(MFA_SECRET);
    expect((await adminA.post(retireK1, {})).body.details).toMatchObject({ reason: 'NOT_DECRYPT_ONLY' });
    expect((await adminA.post(`/v1/admin/keys/mfa/${k2}/retire`, {})).body.details).toMatchObject({
      reason: 'NOT_DECRYPT_ONLY',
      status: 'ACTIVE',
    });
    expect((await adminA.post('/v1/admin/keys/mfa/kms-20000101-000000/retire', {})).status).toBe(404);
    expect((await adminA.post('/v1/admin/keys/mfa/legacy/retire', {})).status).toBe(400);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'keys.retired' } });
    expect(audit.metadata).toMatchObject({ purpose: 'mfa', keyId: k1 });

    // Documents: a deleted document's blob is retained until the purge — it is rotated too.
    const d2 = await adminA.post('/v1/admin/keys/documents/generate', {});
    expect(d2.status).toBe(201);
    await makeDue(ctx, 'documents');
    const lifecycle = await runLifecycle(ctx);
    expect(lifecycle.activated).toEqual([{ purpose: 'documents', keyId: d2.body.keyId, previousKeyId: d1 }]);
    await ctx.prisma.encryptionKey.updateMany({
      where: { keyId: d1 },
      data: { deactivatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const deleted = await ctx.prisma.document.findUniqueOrThrow({ where: { id: deletedDocId } });
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.encryptionKeyId).toBe(d2.body.keyId);
    // Simulate a retained blob still sealed with d1 (e.g. its rotation failed): retirement waits.
    await ctx.prisma.document.update({ where: { id: deletedDocId }, data: { encryptionKeyId: d1 } });
    const blocked = await adminA.post(`/v1/admin/keys/documents/${d1}/retire`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.references).toMatchObject({ values: 1, deletedBlobs: 1, total: 1 });
    // Once DOCUMENT_PURGE has removed the blob, nothing needs d1 any more.
    await ctx.prisma.document.update({ where: { id: deletedDocId }, data: { blobPurgedAt: new Date() } });
    const ready2 = await adminA.get('/v1/admin/keys');
    expect(
      purposeOf(ready2.body, 'documents').managedKeys.find((k: any) => k.keyId === d1).nextActions,
    ).toEqual(['RETIRE']);
  });

  it('requires a fresh second factor from an admin who has one (generate and retire)', async () => {
    const ctx = a!;
    const admin2 = await registerUser(ctx, emails.admin2);
    await promote(ctx, emails.admin2, 'ADMIN');
    const client = await login(ctx, emails.admin2);
    const { recoveryCodes } = await enableMfa(client);

    const bare = await client.post('/v1/admin/keys/webhooks/generate', {});
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    expect(await ctx.prisma.encryptionKey.count({ where: { purpose: 'webhooks' } })).toBe(0);
    const unusedCodes = () =>
      ctx.prisma.mfaRecoveryCode.count({ where: { userId: admin2.user.id, usedAt: null } });
    expect(await unusedCodes()).toBe(recoveryCodes.length);

    // The KMS round trip comes before the second factor: an outage burns no single-use code.
    const provider = ctx.app.get(ManagedKeysService).provider!;
    const outage = vi
      .spyOn(provider, 'wrap')
      .mockRejectedValueOnce(kmsUnavailable('local', 'wrap', 'UNREACHABLE'));
    try {
      const down = await client.post('/v1/admin/keys/webhooks/generate', { mfaCode: recoveryCodes[0] });
      expect(down.status, JSON.stringify(down.body)).toBe(503);
      expect(down.body).toMatchObject({ code: 'KMS_UNAVAILABLE', details: { reason: 'UNREACHABLE' } });
    } finally {
      outage.mockRestore();
    }
    expect(await ctx.prisma.encryptionKey.count({ where: { purpose: 'webhooks' } })).toBe(0);
    expect(await unusedCodes()).toBe(recoveryCodes.length);

    // Once the KMS answers, the very same code is still good.
    const generated = await client.post('/v1/admin/keys/webhooks/generate', { mfaCode: recoveryCodes[0] });
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    expect(generated.body.createdByUserId).toBe(admin2.user.id);
    expect(await unusedCodes()).toBe(recoveryCodes.length - 1);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'keys.generated', actorUserId: admin2.user.id },
    });
    expect(audit.metadata).toMatchObject({ purpose: 'webhooks', stepUp: 'recovery_code' });

    const retireD1 = `/v1/admin/keys/documents/${d1}/retire`;
    const bareRetire = await client.post(retireD1, {});
    expect(bareRetire.status).toBe(401);
    expect(bareRetire.body.code).toBe('STEP_UP_REQUIRED');
    const reused = await client.post(retireD1, { mfaCode: recoveryCodes[0] });
    expect(reused.body.code).toBe('RECOVERY_CODE_INVALID');
    const retired = await client.post(retireD1, { mfaCode: recoveryCodes[1] });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.status).toBe('RETIRED');
  });

  it('accepts a passkey proof only when issued for keys.manage on this purpose (generate) or this key id (retire)', async () => {
    const ctx = a!;
    // A passkey as the only second factor: the proof is required, and bound like the console binds it.
    const admin3 = await registerUser(ctx, emails.admin3);
    await promote(ctx, emails.admin3, 'ADMIN');
    const client = await login(ctx, emails.admin3);
    const device = new SoftwareAuthenticator();
    expect((await registerPasskey(client, device)).status).toBe(201);
    const keyManage = (resourceId?: string) => ({
      operation: StepUpOperation.KEY_MANAGE,
      ...(resourceId ? { resourceId } : {}),
    });
    const generateBeneficiaries = '/v1/admin/keys/beneficiaries/generate';

    const bare = await client.post(generateBeneficiaries, {});
    expect(bare.status).toBe(401);
    expect(bare.body.code).toBe('STEP_UP_REQUIRED');
    // Issued for another purpose, another operation, or no resource at all: refused, nothing staged.
    for (const binding of [
      keyManage('documents'),
      { operation: StepUpOperation.GATE_APPROVE, resourceId: 'R1' },
      keyManage(),
    ]) {
      const res = await client.post(generateBeneficiaries, {
        passkeyAssertion: await stepUpAssertion(client, device, binding),
      });
      expect(res.status, JSON.stringify(binding)).toBe(403);
      expect(res.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    }
    expect(await ctx.prisma.encryptionKey.count({ where: { purpose: 'beneficiaries' } })).toBe(0);
    const refusal = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: admin3.user.id, action: 'auth.passkey_step_up_failed' },
      orderBy: { createdAt: 'asc' },
    });
    expect(refusal.metadata).toMatchObject({
      purpose: 'keys.manage',
      reason: 'operation_mismatch',
      expected: 'keys.manage:beneficiaries',
      issuedFor: 'keys.manage:documents',
    });
    // Issued for this purpose (what the console requests): accepted.
    const generated = await client.post(generateBeneficiaries, {
      passkeyAssertion: await stepUpAssertion(client, device, keyManage('beneficiaries')),
    });
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    expect(generated.body).toMatchObject({ purpose: 'beneficiaries', status: 'STAGED' });
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'keys.generated', actorUserId: admin3.user.id },
    });
    expect(audit.metadata).toMatchObject({ purpose: 'beneficiaries', stepUp: 'passkey' });

    // Retire: the resource is the key id. The scheduled mfa key takes over so k2 becomes decrypt-only.
    await makeDue(ctx, 'mfa');
    const lifecycle = await runLifecycle(ctx);
    expect(lifecycle.activated).toMatchObject([{ purpose: 'mfa', previousKeyId: k2 }]);
    expect(lifecycle.rotation).toMatchObject({ status: 'COMPLETED' });
    await ctx.prisma.encryptionKey.updateMany({
      where: { keyId: k2 },
      data: { deactivatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    const retireK2 = `/v1/admin/keys/mfa/${k2}/retire`;
    // A proof for the purpose (what generating uses) does not retire one of its keys.
    const wrongResource = await client.post(retireK2, {
      passkeyAssertion: await stepUpAssertion(client, device, keyManage('mfa')),
    });
    expect(wrongResource.status).toBe(403);
    expect(wrongResource.body.code).toBe('STEP_UP_OPERATION_MISMATCH');
    expect((await ctx.prisma.encryptionKey.findFirstOrThrow({ where: { keyId: k2 } })).status).toBe(
      'DECRYPT_ONLY',
    );
    const retired = await client.post(retireK2, {
      passkeyAssertion: await stepUpAssertion(client, device, keyManage(k2)),
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ keyId: k2, status: 'RETIRED' });
    const retiredAudit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'keys.retired', actorUserId: admin3.user.id },
    });
    expect(retiredAudit.metadata).toMatchObject({ purpose: 'mfa', keyId: k2, stepUp: 'passkey' });
  });

  it('ENCRYPTION_LEGACY_DECRYPT=false: boots with a warning, refuses legacy values, reports what still uses them', async () => {
    const ctx = a!;
    const orgId = (await ctx.prisma.organizationMember.findFirstOrThrow({ where: { userId: ownerId } }))
      .organizationId;
    // Values sealed with DOCUMENT_ENCRYPTION_KEY of the test environment (the legacy key).
    const legacyRing = new KeyRing(process.env.DOCUMENT_ENCRYPTION_KEY!);
    await ctx.prisma.webhookSubscription.create({
      data: {
        organizationId: orgId,
        createdByUserId: ownerId,
        url: 'https://hooks.example.com/dfn',
        secretEnc: legacyRing.sealString(KeyPurpose.WEBHOOKS, 'whsec_legacy_sandbox'),
        events: ['transaction.created'],
      },
    });
    await ctx.prisma.user.update({
      where: { email: emails.compliance },
      data: { mfaSecretEnc: legacyRing.sealString(KeyPurpose.MFA, MFA_SECRET) },
    });

    const warn = vi.spyOn(Logger.prototype, 'warn');
    const strict = await boot({
      ...kmsEnv,
      STORAGE_DIR: dir,
      INSTANCE_ID: `kms-l-${tag}`,
      ENCRYPTION_LEGACY_DECRYPT: 'false',
    });
    try {
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(
        warnings.some((w) => w.includes('ENCRYPTION_LEGACY_DECRYPT=false but legacy-sealed values remain')),
      ).toBe(true);
      expect(warnings.some((w) => /no active key for: .*beneficiaries/.test(w))).toBe(true);
      const ring = ringOf(strict);
      const hook = await strict.prisma.webhookSubscription.findFirstOrThrow({
        where: { organizationId: orgId },
      });
      expect(() => ring.openString(KeyPurpose.WEBHOOKS, hook.secretEnc)).toThrow(KeyRingError);
      expect(() => ring.sealString(KeyPurpose.BENEFICIARIES, 'SN08')).toThrow(/No active key/);
      // Managed keys keep working.
      expect(ring.openString(KeyPurpose.MFA, ring.sealString(KeyPurpose.MFA, 'ok'))).toBe('ok');

      const status = await strict.app.get(KeysService).status();
      expect(status.legacy).toEqual({
        decryptEnabled: false,
        values: 2,
        deletedBlobs: 0,
        safeToDisable: false,
      });
      expect(purposeOf(status, 'webhooks')).toMatchObject({ legacy: { values: 1 }, unreadable: 1 });
      expect(purposeOf(status, 'mfa')).toMatchObject({ legacy: { values: 1 }, unreadable: 1 });
      expect(purposeOf(status, 'mfa').configuredKeyIds).not.toContain('legacy');
      // The rotation job cannot open legacy values either (reported, never blocks the rest).
      const run = await strict.app.get(MaintenanceService).run('ENCRYPTION_KEY_ROTATION', 'scheduler');
      expect((run.summary as any).purposes.mfa).toMatchObject({ failed: 1, errors: { KEY_NOT_FOUND: 1 } });
    } finally {
      warn.mockRestore();
      await strict.close();
    }
  });

  it('refuses to boot when a managed key cannot be unwrapped (KMS down, wrong master key, KMS_PROVIDER=none)', async () => {
    for (const overrides of [
      { KMS_PROVIDER: 'local', KMS_LOCAL_MASTER_KEY: randomBytes(32).toString('hex') },
      { KMS_PROVIDER: 'none' },
    ] as const) {
      const { app } = await createApp({ ...overrides, STORAGE_DIR: dir, INSTANCE_ID: `kms-x-${tag}` });
      const err = (await caught(app.init())) as Error | null;
      await app.close().catch(() => undefined);
      expect(err?.message).toMatch(/managed data key\(s\) cannot be loaded — refusing to start/);
      expect(err?.message).toMatch(/MASTER_KEY_MISMATCH|KMS_NOT_CONFIGURED/);
      expect(err?.message).not.toContain(master);
    }
  });
});

// ── Recovery codes and MFA_RECOVERY_SECRET ─────────────────────────────────────────────────

describe('MFA recovery codes keyed with MFA_RECOVERY_SECRET', () => {
  const S1 = `session-secret-one-${randomUUID()}`;
  const S2 = `session-secret-two-${randomUUID()}`;
  const RECOVERY = `recovery-secret-${randomUUID()}`;
  let ctx: TestContext | null = null;

  afterAll(async () => {
    await ctx?.close();
  });

  it('survive a SESSION_SECRET change; older codes keep working until then', async () => {
    await dropManagedKeys();
    ctx = await boot({ SESSION_SECRET: S1 });
    await resetDatabase(ctx.prisma);
    const before = await registerUser(ctx, `rc-before-${randomUUID().slice(0, 8)}@example.com`);
    const after = await registerUser(ctx, `rc-after-${randomUUID().slice(0, 8)}@example.com`);
    const codesV1 = await ctx.app.get(RecoveryCodesService).replaceAll(before.user.id);
    const v1Rows = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: before.user.id } });
    expect(v1Rows.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash))).toBe(true);
    await ctx.close();

    // MFA_RECOVERY_SECRET set: older codes still verify (SESSION_SECRET form), new ones use it.
    ctx = await boot({ SESSION_SECRET: S1, MFA_RECOVERY_SECRET: RECOVERY });
    let codes = ctx.app.get(RecoveryCodesService);
    expect(await codes.consume(before.user.id, codesV1[0]!, 'test')).toEqual({ remaining: 9 });
    const codesV2 = await codes.replaceAll(after.user.id);
    const v2Rows = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: after.user.id } });
    expect(v2Rows.every((r) => /^r2:[0-9a-f]{64}$/.test(r.codeHash))).toBe(true);
    expect(v2Rows.some((r) => r.codeHash.includes(codesV2[0]!))).toBe(false);
    const status = await ctx.app.get(KeysService).status();
    expect(status.recoveryCodes).toEqual({ secret: 'MFA_RECOVERY_SECRET', sessionSecretBound: 9 });
    await ctx.close();

    // SESSION_SECRET rotated: codes created under MFA_RECOVERY_SECRET survive, older ones do not.
    ctx = await boot({ SESSION_SECRET: S2, MFA_RECOVERY_SECRET: RECOVERY });
    codes = ctx.app.get(RecoveryCodesService);
    expect(await codes.consume(after.user.id, codesV2[0]!, 'test')).toEqual({ remaining: 9 });
    const reused = await caught(codes.consume(after.user.id, codesV2[0]!, 'test'));
    expect(reused).toMatchObject({ code: ErrorCode.RECOVERY_CODE_INVALID });
    const stale = await caught(codes.consume(before.user.id, codesV1[1]!, 'test'));
    expect(stale).toMatchObject({ code: ErrorCode.RECOVERY_CODE_INVALID });
    // Lower-case and unformatted input is normalised as before.
    expect(await codes.consume(after.user.id, codesV2[1]!.replace(/-/g, '').toLowerCase(), 'test')).toEqual({
      remaining: 8,
    });
  });
});
