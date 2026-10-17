import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { KeyPurpose } from '@dfn/shared';
import { createApp } from '../src/bootstrap';
import { encryptBuffer, sha256Hex } from '../src/common/crypto';
import { KeyRing, LEGACY_KEY_ID } from '../src/common/keyring';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  BlobStoreRegistry,
  LocalBlobStore,
  StorageError,
  assertValidStorageKey,
  maxSealedBytes,
  rotationTempKey,
  type BlobStore,
} from '../src/common/storage';
import type { Env } from '../src/config/env';
import { DocumentStorageService } from '../src/modules/documents/storage.service';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
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

const LEGACY_KEY = process.env.DOCUMENT_ENCRYPTION_KEY!;
const D1 = 'a1'.repeat(32);

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

/** Downloads raw bytes (supertest does not buffer binary bodies by default). */
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

/** Platform ADMIN (ADMIN_KEYS) logged in with a fresh session. */
async function adminClient(ctx: TestContext): Promise<Client> {
  const email = `admin-${randomUUID().slice(0, 8)}@example.com`;
  await registerUser(ctx, email);
  await promote(ctx, email, 'ADMIN');
  const client = new Client(ctx);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return client;
}

function expectStorageError(fn: () => unknown, reason: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).reason).toBe(reason);
    return;
  }
  throw new Error(`expected StorageError(${reason})`);
}

async function expectStorageRejection(promise: Promise<unknown>, reason: string, status = 503) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StorageError);
  expect((err as StorageError).reason).toBe(reason);
  expect((err as StorageError).status).toBe(status);
}

describe('LocalBlobStore', () => {
  let dir: string;
  let store: LocalBlobStore;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-blob-unit-'));
    store = new LocalBlobStore(dir, 4 * 1024 * 1024);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes blobs with mode 0600 at <root>/<key>, leaving no temp file behind', async () => {
    const key = `org-${randomUUID()}/${randomUUID()}`;
    await store.put(key, Buffer.from('sealed-bytes'));
    const path = join(dir, key);
    expect(readFileSync(path).toString()).toBe('sealed-bytes');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.put(key, Buffer.from('replaced'));
    expect(readFileSync(path).toString()).toBe('replaced');
    expect(readdirSync(join(dir, key.split('/')[0]!))).toEqual([key.split('/')[1]]);
    expect(await store.exists(key)).toBe(true);
    expect((await store.get(key)).toString()).toBe('replaced');
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    await store.delete(key); // idempotent
  });

  it('replaces blobs atomically: concurrent readers only ever see a complete version', async () => {
    const key = `atomic/${randomUUID()}`;
    const a = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const b = Buffer.alloc(2 * 1024 * 1024, 0x62);
    await store.put(key, a);
    const writes = Array.from({ length: 12 }, (_, i) => store.put(key, i % 2 ? a : b));
    const reads = Array.from({ length: 40 }, () => store.get(key));
    const [, results] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
    for (const r of results) expect(r.equals(a) || r.equals(b)).toBe(true);
    const leftovers = readdirSync(join(dir, 'atomic')).filter((f) => f.includes('.'));
    expect(leftovers).toEqual([]);
  });

  it('rejects every key that is not server-generated (no traversal possible)', async () => {
    const bad = [
      '../etc/passwd',
      'a/../../b',
      '..',
      '/abs/path',
      'A/B',
      'a//b',
      'a/',
      '',
      'a\\b',
      'a/b.txt',
      'a/%2e%2e/b',
      'a b',
      'x'.repeat(513),
    ];
    for (const key of bad) {
      expectStorageError(() => assertValidStorageKey(key), 'INVALID_KEY');
      expectStorageError(() => store.pathFor(key), 'INVALID_KEY');
      await expectStorageRejection(store.put(key, Buffer.from('x')), 'INVALID_KEY', 400);
      await expectStorageRejection(store.get(key), 'INVALID_KEY', 400);
      await expectStorageRejection(store.delete(key), 'INVALID_KEY', 400);
    }
    expect(store.pathFor('org/doc-1')).toBe(join(dir, 'org', 'doc-1'));
    expect(rotationTempKey('3F2B1C4D-1111-2222-3333-444444444444')).toBe(
      'rotation-tmp/3f2b1c4d-1111-2222-3333-444444444444',
    );
  });

  it('maps missing and oversized blobs to STORAGE_UNAVAILABLE', async () => {
    await expectStorageRejection(store.get(`missing/${randomUUID()}`), 'NOT_FOUND');
    const small = new LocalBlobStore(dir, 8);
    const key = `big/${randomUUID()}`;
    await small.put(key, Buffer.alloc(16, 1));
    await expectStorageRejection(small.get(key), 'TOO_LARGE');
    const err = await small.get(key).catch((e: StorageError) => e);
    expect((err as StorageError).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('reports its health without throwing', async () => {
    const health = await store.healthCheck();
    expect(health).toMatchObject({ driver: 'local', ok: true, location: dir });
    const broken = new LocalBlobStore(join(dir, 'file-not-dir'), 1024);
    writeFileSync(join(dir, 'file-not-dir'), 'x');
    const down = await broken.healthCheck();
    expect(down.ok).toBe(false);
    expect(down.reason).toBeDefined();
  });
});

describe('key ring helpers used by the blob store', () => {
  it('reads the key id from a sealed buffer header and knows which keys it holds', () => {
    const ring = new KeyRing(LEGACY_KEY, `documents:d1:${D1}`);
    const { sealed } = ring.sealBuffer(KeyPurpose.DOCUMENTS, PDF_BYTES);
    expect(ring.keyIdOfBuffer(sealed)).toBe('d1');
    expect(ring.keyIdOfBuffer(encryptBuffer(LEGACY_KEY, PDF_BYTES))).toBe(LEGACY_KEY_ID);
    expect(ring.keyIdOfBuffer(Buffer.from('DFNK2'))).toBe(LEGACY_KEY_ID);
    expect(ring.hasKey(KeyPurpose.DOCUMENTS, 'd1')).toBe(true);
    expect(ring.hasKey(KeyPurpose.DOCUMENTS, null)).toBe(true);
    expect(ring.hasKey(KeyPurpose.MFA, 'd1')).toBe(false);
    expect(ring.hasKey(KeyPurpose.DOCUMENTS, 'gone')).toBe(false);
  });
});

/** Delegating store whose behaviour can be broken per call, to exercise the rotation's failure paths. */
class FaultyStore implements BlobStore {
  readonly driver = 'local' as const;
  failPutOn: string | null = null;
  /** How many puts on `failPutOn` fail (Infinity = the key is persistently unwritable). */
  failPutTimes = 0;
  corruptGetOn: string | null = null;
  failGetOn: string | null = null;
  failGetTimes = 0;
  /** Runs right after a successful put (simulates what happens concurrently). */
  afterPut: ((key: string) => Promise<void>) | null = null;
  constructor(readonly inner: LocalBlobStore) {}
  async put(key: string, bytes: Buffer) {
    if (key === this.failPutOn && this.failPutTimes > 0) {
      this.failPutTimes -= 1;
      throw new StorageError('put', 'IO_ERROR', 'local');
    }
    const meta = await this.inner.put(key, bytes);
    if (this.afterPut) await this.afterPut(key);
    return meta;
  }
  async get(key: string) {
    if (key === this.failGetOn && this.failGetTimes > 0) {
      this.failGetTimes -= 1;
      throw new StorageError('get', 'IO_ERROR', 'local');
    }
    const bytes = await this.inner.get(key);
    if (key !== this.corruptGetOn) return bytes;
    const copy = Buffer.from(bytes);
    copy[copy.length - 1]! ^= 0xff;
    return copy;
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  exists(key: string) {
    return this.inner.exists(key);
  }
  healthCheck() {
    return this.inner.healthCheck();
  }
}

describe('documents on the encrypted blob store', () => {
  let ctx: TestContext;
  let dir: string;
  let owner: Client;
  let ownerId: string;
  let orgId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-storage-test-'));
    ctx = await bootWith({ STORAGE_DIR: dir, ENCRYPTION_KEYRING: `documents:d1:${D1}` });
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const reg = await registerUser(ctx, `owner-${randomUUID().slice(0, 8)}@example.com`);
    owner = reg.client;
    ownerId = reg.user.id;
    orgId = reg.user.organizations[0].id;
  });

  async function upload() {
    const res = await owner.upload(
      '/v1/documents',
      { kind: 'OTHER', title: 'Facture fictive' },
      { name: 'facture.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return ctx.prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
  }

  it('seals new uploads with the active key and records the key id and driver', async () => {
    const doc = await upload();
    expect(doc.storageDriver).toBe('local');
    expect(doc.encryptionKeyId).toBe('d1');
    expect(doc.storageKey).toMatch(/^[a-z0-9/-]+$/);
    const raw = readFileSync(join(dir, doc.storageKey));
    expect(raw.subarray(0, 5).toString('ascii')).toBe('DFNK2');
    expect(raw.includes(Buffer.from('%PDF'))).toBe(false);
    expect(statSync(join(dir, doc.storageKey)).mode & 0o777).toBe(0o600);

    const download = await downloadBytes(ctx, owner, doc.id);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect((download.body as Buffer).equals(PDF_BYTES)).toBe(true);

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'document.uploaded', entityId: doc.id },
    });
    expect(audit.metadata).toMatchObject({ storageDriver: 'local', encryptionKeyId: 'd1' });

    // Access control is unchanged: a stranger gets 404.
    const stranger = await registerUser(ctx, `stranger-${randomUUID().slice(0, 8)}@example.com`);
    expect((await stranger.client.get(`/v1/documents/${doc.id}/download`)).status).toBe(404);
    // …and the same 404 as an unknown id when trying to delete it (no existence oracle).
    const strangerDelete = await stranger.client.delete(`/v1/documents/${doc.id}`);
    expect(strangerDelete.status).toBe(404);
    expect((await stranger.client.delete(`/v1/documents/${randomUUID()}`)).status).toBe(404);

    // Staff: COMPLIANCE never deletes; an ADMIN needs a support reason, audited before the deletion.
    const staffDelete = async (role: 'ADMIN' | 'COMPLIANCE', reason?: string) => {
      const email = `staff-del-${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`;
      await registerUser(ctx, email);
      await promote(ctx, email, role);
      const login = await ctx.http().post('/v1/auth/login').send({ email, password: PASSWORD });
      const cookie = (login.headers['set-cookie'] as unknown as string[])
        .map((c) => c.split(';')[0])
        .join('; ');
      let r = ctx.http().delete(`/v1/documents/${doc.id}`).set('Cookie', cookie);
      if (reason) r = r.set('X-Support-Reason', reason);
      return r;
    };
    expect((await staffDelete('COMPLIANCE', 'Demande du client (ticket SUP-9)')).status).toBe(403);
    const noReason = await staffDelete('ADMIN');
    expect(noReason.status).toBe(400);
    expect(noReason.body.details).toEqual({ header: 'x-support-reason' });
    expect(statSync(join(dir, doc.storageKey)).isFile()).toBe(true);
    const supported = await staffDelete('ADMIN', 'Demande du client (ticket SUP-9)');
    expect(supported.status, JSON.stringify(supported.body)).toBe(200);
    const supportAudit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'support.write' } });
    expect(supportAudit.metadata).toMatchObject({ permission: 'document:delete', support: true });
    // Soft delete keeps the blob for the retention period (DOCUMENT_PURGE destroys it later).
    expect(supported.body.purgeAfter).toBe(doc.retentionUntil!.toISOString());
    expect(statSync(join(dir, doc.storageKey)).isFile()).toBe(true);
    const deleted = await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.blobPurgedAt).toBeNull();
    const deleteAudit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'document.deleted', entityId: doc.id },
    });
    expect(deleteAudit.metadata).toEqual({ blobRetained: true, purgeAfter: supported.body.purgeAfter });
    expect((await owner.delete(`/v1/documents/${doc.id}`)).status).toBe(404);
    expect((await owner.get(`/v1/documents/${doc.id}/download`)).status).toBe(404);
  });

  it('keeps serving documents written in the legacy layout (no key ring header)', async () => {
    const storageKey = `${orgId}/${randomUUID()}`;
    mkdirSync(join(dir, orgId), { recursive: true });
    writeFileSync(join(dir, storageKey), encryptBuffer(LEGACY_KEY, PDF_BYTES), { mode: 0o600 });
    const legacy = await ctx.prisma.document.create({
      data: {
        organizationId: orgId,
        uploadedByUserId: ownerId,
        title: 'Ancien document',
        fileName: 'ancien.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        sha256: sha256Hex(PDF_BYTES),
        storageKey,
      },
    });
    expect(legacy.encryptionKeyId).toBeNull();
    expect(legacy.storageDriver).toBe('local');
    const download = await downloadBytes(ctx, owner, legacy.id);
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(PDF_BYTES)).toBe(true);
    // The row is left as is (legacy until the rotation job re-seals it).
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: legacy.id } })).encryptionKeyId,
    ).toBeNull();
  });

  it('refuses content whose SHA-256 or GCM tag does not verify, and audits it', async () => {
    const doc = await upload();
    await ctx.prisma.document.update({ where: { id: doc.id }, data: { sha256: 'f'.repeat(64) } });
    const mismatch = await owner.get(`/v1/documents/${doc.id}/download`);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('DOCUMENT_INTEGRITY_FAILED');
    expect(mismatch.body.details).toMatchObject({ documentId: doc.id, reason: 'SHA256_MISMATCH' });
    expect(JSON.stringify(mismatch.body)).not.toContain('%PDF');

    await ctx.prisma.document.update({ where: { id: doc.id }, data: { sha256: doc.sha256 } });
    const path = join(dir, doc.storageKey);
    const tampered = readFileSync(path);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(path, tampered);
    const corrupted = await owner.get(`/v1/documents/${doc.id}/download`);
    expect(corrupted.status).toBe(409);
    expect(corrupted.body.details.reason).toBe('DECRYPT_FAILED');

    const failures = await ctx.prisma.auditLog.findMany({
      where: { action: 'document.integrity_failed', entityId: doc.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(failures.map((f) => (f.metadata as { reason: string }).reason)).toEqual([
      'SHA256_MISMATCH',
      'DECRYPT_FAILED',
    ]);
    expect(failures[0]!.actorUserId).toBe(ownerId);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'document.downloaded', entityId: doc.id } }),
    ).toBe(0);
  });

  it('answers 503 when the blob or its key is unavailable', async () => {
    const doc = await upload();
    // Blob missing from the store.
    rmSync(join(dir, doc.storageKey));
    const missing = await owner.get(`/v1/documents/${doc.id}/download`);
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe('STORAGE_UNAVAILABLE');
    expect(missing.body.details).toMatchObject({ operation: 'get', reason: 'NOT_FOUND' });

    // Recorded on a driver that is not configured here (s3 without bucket).
    const other = await upload();
    await ctx.prisma.document.update({ where: { id: other.id }, data: { storageDriver: 's3' } });
    const s3 = await owner.get(`/v1/documents/${other.id}/download`);
    expect(s3.status).toBe(503);
    expect(s3.body.code).toBe('STORAGE_UNAVAILABLE');

    // Sealed with a key that is no longer in the ring.
    const retired = new KeyRing(LEGACY_KEY, `documents:old1:${'b2'.repeat(32)}`);
    const { sealed } = retired.sealBuffer(KeyPurpose.DOCUMENTS, PDF_BYTES);
    const third = await upload();
    writeFileSync(join(dir, third.storageKey), sealed);
    await ctx.prisma.document.update({ where: { id: third.id }, data: { encryptionKeyId: 'old1' } });
    const noKey = await owner.get(`/v1/documents/${third.id}/download`);
    expect(noKey.status).toBe(503);
    expect(noKey.body.code).toBe('KEY_NOT_FOUND');
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'document.key_unavailable', entityId: third.id } }),
    ).toBe(1);
  });

  it('repairs the key id of a row left behind by an interrupted rotation', async () => {
    const doc = await upload();
    // Blob already re-sealed with d1, row still says "legacy" (crash between swap and update).
    await ctx.prisma.document.update({ where: { id: doc.id }, data: { encryptionKeyId: null } });
    const download = await downloadBytes(ctx, owner, doc.id);
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(PDF_BYTES)).toBe(true);
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).encryptionKeyId).toBe(
      'd1',
    );
    const repaired = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'document.key_id_repaired', entityId: doc.id },
    });
    expect(repaired.metadata).toEqual({ from: 'legacy', to: 'd1' });
  });

  it('re-seals a blob crash-safely: verified temp copy, atomic swap, original restored on failure', async () => {
    const storageKey = `${orgId}/${randomUUID()}`;
    mkdirSync(join(dir, orgId), { recursive: true });
    const original = encryptBuffer(LEGACY_KEY, PDF_BYTES);
    writeFileSync(join(dir, storageKey), original, { mode: 0o600 });
    const doc = await ctx.prisma.document.create({
      data: {
        organizationId: orgId,
        uploadedByUserId: ownerId,
        title: 'À faire tourner',
        fileName: 'rotation.pdf',
        mimeType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        sha256: sha256Hex(PDF_BYTES),
        storageKey,
      },
    });
    const registry = ctx.app.get(BlobStoreRegistry);
    const faulty = new FaultyStore(new LocalBlobStore(dir, maxSealedBytes(15)));
    registry.override('local', faulty);
    const storage = ctx.app.get(DocumentStorageService);
    const tempPath = join(dir, rotationTempKey(doc.id));
    try {
      // 1. The temporary copy does not read back intact: nothing is swapped.
      faulty.corruptGetOn = rotationTempKey(doc.id);
      const verify = await storage.reseal(doc).catch((e: unknown) => e as StorageError);
      expect((verify as StorageError).status).toBe(409);
      expect((verify as StorageError).details).toMatchObject({ reason: 'ROTATION_VERIFY_FAILED' });
      expect(readFileSync(join(dir, storageKey)).equals(original)).toBe(true);
      expect(() => statSync(tempPath)).toThrow();

      // 2. The swap fails once: the original is written back, the temp copy removed, the row unchanged.
      faulty.corruptGetOn = null;
      faulty.failPutOn = storageKey;
      faulty.failPutTimes = 1;
      const swap = await storage.reseal(doc).catch((e: unknown) => e as StorageError);
      expect(swap).toBeInstanceOf(StorageError);
      expect(readFileSync(join(dir, storageKey)).equals(original)).toBe(true);
      expect(() => statSync(tempPath)).toThrow();
      expect(
        (await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).encryptionKeyId,
      ).toBeNull();

      // 2b. The original key stays unwritable: the original is untouched (it is the good copy) and
      //     the temp copy is dropped — the old blob is never written back over anything.
      faulty.failPutTimes = Infinity;
      expect(await storage.reseal(doc).catch((e: unknown) => e)).toBeInstanceOf(StorageError);
      expect(readFileSync(join(dir, storageKey)).equals(original)).toBe(true);
      expect(() => statSync(tempPath)).toThrow();
      expect(
        (await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).encryptionKeyId,
      ).toBeNull();

      // 3. Healthy store: rotated, temp copy removed, row records the new key.
      faulty.failPutOn = null;
      faulty.failPutTimes = 0;
      expect(await storage.reseal(doc)).toBe('rotated');
      expect(readFileSync(join(dir, storageKey)).subarray(0, 5).toString('ascii')).toBe('DFNK2');
      expect(() => statSync(tempPath)).toThrow();
      const rotated = await ctx.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(rotated.encryptionKeyId).toBe('d1');
      expect((await storage.read(rotated, null)).equals(PDF_BYTES)).toBe(true);
      expect(await storage.reseal(rotated)).toBe('current');
    } finally {
      registry.override('local', new LocalBlobStore(dir, maxSealedBytes(15)));
    }
  });

  it('settles a failed swap from what storage holds (concurrent repair, rollback, deletion)', async () => {
    const registry = ctx.app.get(BlobStoreRegistry);
    const faulty = new FaultyStore(new LocalBlobStore(dir, maxSealedBytes(15)));
    registry.override('local', faulty);
    const storage = ctx.app.get(DocumentStorageService);
    const legacyDoc = async (title: string) => {
      const storageKey = `${orgId}/${randomUUID()}`;
      mkdirSync(join(dir, orgId), { recursive: true });
      const original = encryptBuffer(LEGACY_KEY, PDF_BYTES);
      writeFileSync(join(dir, storageKey), original, { mode: 0o600 });
      const doc = await ctx.prisma.document.create({
        data: {
          organizationId: orgId,
          uploadedByUserId: ownerId,
          title,
          fileName: 'rotation.pdf',
          mimeType: 'application/pdf',
          sizeBytes: PDF_BYTES.length,
          sha256: sha256Hex(PDF_BYTES),
          storageKey,
        },
      });
      return { doc, storageKey, original, tempPath: join(dir, rotationTempKey(doc.id)) };
    };
    const keyIdOf = async (id: string) =>
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id } })).encryptionKeyId;
    try {
      // A. A download repairs the row to the new key right after the swap, then the verification
      //    read fails: storage holds the new blob, so the rotation completes (no blind rollback).
      const a = await legacyDoc('A');
      faulty.afterPut = async (key) => {
        if (key !== a.storageKey) return;
        faulty.afterPut = null;
        const row = await ctx.prisma.document.findUniqueOrThrow({ where: { id: a.doc.id } });
        expect((await storage.read(row, ownerId)).equals(PDF_BYTES)).toBe(true);
        faulty.failGetOn = a.storageKey;
        faulty.failGetTimes = 1;
      };
      expect(await storage.reseal(a.doc)).toBe('rotated');
      expect(await keyIdOf(a.doc.id)).toBe('d1');
      expect(readFileSync(join(dir, a.storageKey)).subarray(0, 5).toString('ascii')).toBe('DFNK2');
      expect(() => statSync(a.tempPath)).toThrow();

      // B. Another writer put the old blob back after a download had repaired the row: the old
      //    blob stays, the row is moved back to the key that really sealed it, the temp copy goes.
      const b = await legacyDoc('B');
      faulty.afterPut = async (key) => {
        if (key !== b.storageKey) return;
        faulty.afterPut = null;
        await ctx.prisma.document.update({ where: { id: b.doc.id }, data: { encryptionKeyId: 'd1' } });
        await faulty.inner.put(b.storageKey, b.original);
      };
      const kept = await storage.reseal(b.doc).catch((e: unknown) => e as StorageError);
      expect((kept as StorageError).details).toMatchObject({ reason: 'ROTATION_SWAP_FAILED' });
      expect(await keyIdOf(b.doc.id)).toBeNull();
      expect(readFileSync(join(dir, b.storageKey)).equals(b.original)).toBe(true);
      expect(() => statSync(b.tempPath)).toThrow();
      const bRow = await ctx.prisma.document.findUniqueOrThrow({ where: { id: b.doc.id } });
      expect((await storage.read(bRow, ownerId)).equals(PDF_BYTES)).toBe(true);

      // C. Purged during the swap: nothing is resurrected, every copy is removed.
      const c = await legacyDoc('C');
      faulty.afterPut = async (key) => {
        if (key !== c.storageKey) return;
        faulty.afterPut = null;
        await ctx.prisma.document.update({
          where: { id: c.doc.id },
          data: { deletedAt: new Date(), blobPurgedAt: new Date() },
        });
        await faulty.inner.delete(c.storageKey);
      };
      expect(await storage.reseal(c.doc)).toBe('current');
      expect(() => statSync(join(dir, c.storageKey))).toThrow();
      expect(() => statSync(c.tempPath)).toThrow();

      // C2. Merely soft-deleted during the rotation: the blob is retained (purged later), rotated,
      //     and the row records its new key.
      const c2 = await legacyDoc('C2');
      faulty.afterPut = async (key) => {
        if (key !== c2.storageKey) return;
        faulty.afterPut = null;
        await ctx.prisma.document.update({ where: { id: c2.doc.id }, data: { deletedAt: new Date() } });
      };
      expect(await storage.reseal(c2.doc)).toBe('rotated');
      expect(readFileSync(join(dir, c2.storageKey)).subarray(0, 5).toString('ascii')).toBe('DFNK2');
      expect(await keyIdOf(c2.doc.id)).toBe('d1');
      expect(() => statSync(c2.tempPath)).toThrow();

      // C3. Moved to another driver by the storage migration during the rotation: the copy written
      //     at the old location is removed and the row is left to the migration.
      const c3 = await legacyDoc('C3');
      faulty.afterPut = async (key) => {
        if (key !== c3.storageKey) return;
        faulty.afterPut = null;
        await ctx.prisma.document.update({ where: { id: c3.doc.id }, data: { storageDriver: 's3' } });
      };
      expect(await storage.reseal(c3.doc)).toBe('current');
      expect(() => statSync(join(dir, c3.storageKey))).toThrow();
      expect(await keyIdOf(c3.doc.id)).toBeNull();

      // D. A copy left behind by a crashed run is removed when the row is repaired, and by remove().
      const d = await legacyDoc('D');
      const sealedD1 = readFileSync(join(dir, a.storageKey));
      writeFileSync(join(dir, d.storageKey), sealedD1, { mode: 0o600 });
      await ctx.prisma.document.update({ where: { id: d.doc.id }, data: { sha256: a.doc.sha256 } });
      mkdirSync(join(dir, 'rotation-tmp'), { recursive: true });
      writeFileSync(d.tempPath, sealedD1, { mode: 0o600 });
      expect(await storage.reseal({ ...d.doc, sha256: a.doc.sha256 })).toBe('repaired');
      expect(() => statSync(d.tempPath)).toThrow();
      writeFileSync(d.tempPath, sealedD1, { mode: 0o600 });
      expect(await storage.remove(d.doc)).toBe(true);
      expect(() => statSync(d.tempPath)).toThrow();
      expect(() => statSync(join(dir, d.storageKey))).toThrow();
    } finally {
      registry.override('local', new LocalBlobStore(dir, maxSealedBytes(15)));
    }
  });

  it('records the missing blob of a deleted document as purged instead of failing every rotation', async () => {
    const storage = ctx.app.get(DocumentStorageService);
    const live = await upload();
    rmSync(join(dir, live.storageKey));
    const liveErr = await storage.reseal(live).catch((e: unknown) => e);
    expect((liveErr as StorageError).reason).toBe('NOT_FOUND');
    expect((await ctx.prisma.document.findUniqueOrThrow({ where: { id: live.id } })).blobPurgedAt).toBeNull();

    // Deleted through the API since the purge is deferred: the blob should still be there, so its
    // absence is reported (not recorded as purged).
    const retained = await upload();
    expect((await owner.delete(`/v1/documents/${retained.id}`)).status).toBe(200);
    rmSync(join(dir, retained.storageKey));
    const retainedErr = await storage.reseal(retained).catch((e: unknown) => e);
    expect((retainedErr as StorageError).reason).toBe('NOT_FOUND');
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: retained.id } })).blobPurgedAt,
    ).toBeNull();

    // Deleted before the purge was deferred (audit without `blobRetained`): the blob went with it.
    const gone = await upload();
    await ctx.prisma.document.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await ctx.prisma.auditLog.create({
      data: { action: 'document.deleted', entityType: 'Document', entityId: gone.id, actorUserId: ownerId },
    });
    rmSync(join(dir, gone.storageKey));
    expect(await storage.reseal(gone)).toBe('current');
    expect(
      (await ctx.prisma.document.findUniqueOrThrow({ where: { id: gone.id } })).blobPurgedAt,
    ).toBeInstanceOf(Date);
    const audit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'document.blob_missing', entityId: gone.id },
    });
    expect(audit.metadata).toEqual({ storageDriver: 'local', recordedAsPurged: true });
  });

  it('refuses the storage migration unless STORAGE_DRIVER=s3', async () => {
    const maintenance = ctx.app.get(MaintenanceService);
    const scheduled = await maintenance.run('STORAGE_MIGRATION', 'scheduler');
    expect(scheduled.status).toBe('COMPLETED');
    expect(scheduled.summary).toEqual({ skipped: 'STORAGE_DRIVER_NOT_S3', activeDriver: 'local' });
    const manual = await maintenance.run('STORAGE_MIGRATION', `manual:${ownerId}`);
    expect(manual.status).toBe('FAILED');
    expect(manual.error).toContain('STORAGE_DRIVER=s3');

    const admin = await adminClient(ctx);
    const res = await admin.post('/v1/admin/storage/migration', { dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AVAILABLE');
    const status = await admin.get('/v1/admin/storage');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      sandbox: true,
      activeDriver: 'local',
      antivirus: { provider: 'sandbox', engine: 'sandbox-eicar', simulation: true },
      migration: { ready: false },
    });
    // Tenants never reach the storage console.
    expect((await owner.post('/v1/admin/storage/migration', { dryRun: true })).status).toBe(403);
    expect((await owner.get('/v1/admin/storage')).status).toBe(403);
  });

  it('keeps the upload validation rules (MIME allowlist and magic bytes)', async () => {
    const fake = await owner.upload(
      '/v1/documents',
      { kind: 'OTHER' },
      { name: 'facture.pdf', buffer: Buffer.from('MZ\x90\x00 not a pdf'), type: 'application/pdf' },
    );
    expect(fake.status).toBe(415);
    expect(fake.body.code).toBe('UNSUPPORTED_FILE');
    expect(await ctx.prisma.document.count()).toBe(0);
  });
});

/** In-memory stand-in for the S3 store (the live suite in s3-store.test.ts uses a real endpoint). */
class MemoryS3Store implements BlobStore {
  readonly driver = 's3' as const;
  readonly objects = new Map<string, Buffer>();
  healthy = true;
  corruptGetOn: string | null = null;
  /** Runs right after a successful put (simulates what happens concurrently). */
  afterPut: ((key: string) => Promise<void>) | null = null;

  async put(key: string, bytes: Buffer) {
    assertValidStorageKey(key);
    this.objects.set(key, Buffer.from(bytes));
    if (this.afterPut) await this.afterPut(key);
  }
  async get(key: string) {
    assertValidStorageKey(key);
    const bytes = this.objects.get(key);
    if (!bytes) throw new StorageError('get', 'NOT_FOUND', 's3');
    const copy = Buffer.from(bytes);
    if (key === this.corruptGetOn) copy[copy.length - 1]! ^= 0xff;
    return copy;
  }
  async delete(key: string) {
    assertValidStorageKey(key);
    this.objects.delete(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async healthCheck() {
    return {
      driver: 's3' as const,
      ok: this.healthy,
      latencyMs: 0,
      location: 'memory@test',
      ...(this.healthy ? {} : { reason: 'UNREACHABLE' as const }),
    };
  }
}

describe('STORAGE_MIGRATION (local → S3)', () => {
  let ctx: TestContext;
  let dir: string;
  let owner: Client;
  let ownerId: string;
  let orgId: string;
  let mem: MemoryS3Store;
  const ring = new KeyRing(LEGACY_KEY, `documents:d1:${D1}`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-migration-test-'));
    ctx = await bootWith({
      STORAGE_DIR: dir,
      ENCRYPTION_KEYRING: `documents:d1:${D1}`,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'dfn-memory',
      S3_ENDPOINT: 'http://127.0.0.1:9',
    });
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const reg = await registerUser(ctx, `mig-${randomUUID().slice(0, 8)}@example.com`);
    owner = reg.client;
    ownerId = reg.user.id;
    orgId = reg.user.organizations[0].id;
    mem = new MemoryS3Store();
    const registry = ctx.app.get(BlobStoreRegistry);
    registry.override('s3', mem);
    registry.override('local', new LocalBlobStore(dir, maxSealedBytes(15)));
  });

  /** A document whose blob was written on the local driver (before STORAGE_DRIVER=s3). */
  async function localDoc(opts: { deleted?: boolean; purged?: boolean } = {}) {
    const content = Buffer.concat([PDF_BYTES, Buffer.from(`% ${randomUUID()}\n`)]);
    const storageKey = `${orgId}/${randomUUID()}`;
    const { sealed } = ring.sealBuffer(KeyPurpose.DOCUMENTS, content);
    const path = join(dir, storageKey);
    mkdirSync(join(dir, orgId), { recursive: true });
    if (!opts.purged) writeFileSync(path, sealed, { mode: 0o600 });
    const doc = await ctx.prisma.document.create({
      data: {
        organizationId: orgId,
        uploadedByUserId: ownerId,
        title: 'Document local',
        fileName: 'local.pdf',
        mimeType: 'application/pdf',
        sizeBytes: content.length,
        sha256: sha256Hex(content),
        storageKey,
        storageDriver: 'local',
        encryptionKeyId: 'd1',
        deletedAt: opts.deleted || opts.purged ? new Date() : null,
        blobPurgedAt: opts.purged ? new Date() : null,
      },
    });
    return { doc, sealed, content, path };
  }
  const run = (triggeredBy = 'scheduler') =>
    ctx.app.get(MaintenanceService).run('STORAGE_MIGRATION', triggeredBy);
  const row = (id: string) => ctx.prisma.document.findUniqueOrThrow({ where: { id } });

  it('copies verified blobs to S3, switches the row, then removes the local copy (dry run first)', async () => {
    const live = await localDoc();
    const retained = await localDoc({ deleted: true });
    await localDoc({ purged: true });
    const vanished = await localDoc({ deleted: true });
    rmSync(vanished.path);
    // Deleted before the purge was deferred (audit without `blobRetained`): its blob went with it.
    const legacyGone = await localDoc({ deleted: true });
    rmSync(legacyGone.path);
    await ctx.prisma.auditLog.create({
      data: { action: 'document.deleted', entityType: 'Document', entityId: legacyGone.doc.id },
    });
    // New uploads already go to the active driver.
    const fresh = await owner.upload(
      '/v1/documents',
      { kind: 'OTHER' },
      { name: 'nouveau.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
    );
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    expect((await row(fresh.body.id)).storageDriver).toBe('s3');
    expect(mem.objects.size).toBe(1);

    const admin = await adminClient(ctx);
    expect((await admin.post('/v1/admin/storage/migration', {})).status).toBe(400);
    const before = await admin.get('/v1/admin/storage');
    expect(before.body.migration).toEqual({
      ready: true,
      pending: 4,
      pendingBytes:
        live.content.length + retained.content.length + vanished.content.length + legacyGone.content.length,
    });

    const dry = await admin.post('/v1/admin/storage/migration', { dryRun: true });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.status).toBe('COMPLETED');
    expect(dry.body.summary).toMatchObject({
      dryRun: true,
      scanned: 4,
      migrated: 2,
      bytes: live.sealed.length + retained.sealed.length,
      missing: 2,
      failed: 0,
      remaining: 4,
    });
    expect(mem.objects.size).toBe(1);
    expect(existsSync(live.path)).toBe(true);
    expect((await row(live.doc.id)).storageDriver).toBe('local');

    const real = await admin.post('/v1/admin/storage/migration', { dryRun: false });
    expect(real.body.status).toBe('COMPLETED');
    expect(real.body.summary).toMatchObject({
      dryRun: false,
      migrated: 2,
      missing: 2,
      raced: 0,
      failed: 0,
      localCleanupFailed: 0,
      remaining: 1,
    });
    // Nothing left to move for the pre-phase-7 deletion; the other vanished blob is an anomaly
    // (its deletion promised retention) and stays reported.
    expect((await row(legacyGone.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    expect((await row(vanished.doc.id)).blobPurgedAt).toBeNull();
    for (const item of [live, retained]) {
      expect((await row(item.doc.id)).storageDriver).toBe('s3');
      expect(mem.objects.get(item.doc.storageKey)!.equals(item.sealed)).toBe(true);
      expect(existsSync(item.path)).toBe(false);
    }
    // Readable from S3, with the same integrity checks.
    const download = await downloadBytes(ctx, owner, live.doc.id);
    expect(download.status).toBe(200);
    expect((download.body as Buffer).equals(live.content)).toBe(true);

    // Audited per page and organisation (the scan starts at a random id and may wrap around).
    const migratedAudits = await ctx.prisma.auditLog.findMany({
      where: { action: 'document.blobs_migrated' },
    });
    expect(migratedAudits.every((a) => a.organizationId === orgId)).toBe(true);
    expect(
      migratedAudits.flatMap((a) => (a.metadata as { documentIds: string[] }).documentIds).sort(),
    ).toEqual([live.doc.id, retained.doc.id].sort());
    expect(await ctx.prisma.auditLog.count({ where: { action: 'storage.migration_run' } })).toBe(2);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'admin.storage_migration' } })).toBe(2);

    // Idempotent: the next run has nothing left but the vanished blob of a deleted document.
    const again = await run();
    expect(again.summary).toMatchObject({ scanned: 1, migrated: 0, missing: 1, remaining: 1 });
  });

  it('never carries content that does not verify, and drops copies that do not read back', async () => {
    const tampered = await localDoc();
    const bytes = readFileSync(tampered.path);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(tampered.path, bytes);
    const badCopy = await localDoc();
    mem.corruptGetOn = badCopy.doc.storageKey;

    const result = await run();
    expect(result.status).toBe('COMPLETED');
    expect(result.summary).toMatchObject({
      migrated: 0,
      failed: 2,
      remaining: 2,
      errors: { DECRYPT_FAILED: 1, COPY_VERIFY_FAILED: 1 },
    });
    for (const item of [tampered, badCopy]) {
      expect((await row(item.doc.id)).storageDriver).toBe('local');
      expect(existsSync(item.path)).toBe(true);
      expect(mem.objects.has(item.doc.storageKey)).toBe(false);
    }
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'document.integrity_failed', entityId: tampered.doc.id },
      }),
    ).toBe(1);

    // Destination down: the run fails before reading or moving anything.
    mem.corruptGetOn = null;
    mem.healthy = false;
    const down = await run();
    expect(down.status).toBe('FAILED');
    expect(down.error).toContain('unreachable');
    expect((await row(badCopy.doc.id)).storageDriver).toBe('local');
  });

  it('drops its copy when a key rotation or a purge changes the row during the copy', async () => {
    const rotated = await localDoc();
    const purged = await localDoc({ deleted: true });
    mem.afterPut = async (key) => {
      if (key === rotated.doc.storageKey) {
        await ctx.prisma.document.update({ where: { id: rotated.doc.id }, data: { encryptionKeyId: null } });
      }
      if (key === purged.doc.storageKey) {
        await ctx.prisma.document.update({
          where: { id: purged.doc.id },
          data: { blobPurgedAt: new Date() },
        });
      }
    };
    const result = await run();
    expect(result.summary).toMatchObject({ migrated: 0, raced: 2, failed: 0 });
    expect(mem.objects.size).toBe(0);
    expect((await row(rotated.doc.id)).storageDriver).toBe('local');
    expect(existsSync(rotated.path)).toBe(true);

    // Next run (no interference): the rotated row is migrated, the purged one is not touched.
    mem.afterPut = null;
    await ctx.prisma.document.update({ where: { id: rotated.doc.id }, data: { encryptionKeyId: 'd1' } });
    const next = await run();
    expect(next.summary).toMatchObject({ migrated: 1, remaining: 0 });
    expect(mem.objects.has(purged.doc.storageKey)).toBe(false);
  });

  it('is re-swept by the purge on both drivers when a replica crashed between its S3 copy and its switch', async () => {
    const maintenance = ctx.app.get(MaintenanceService);
    const item = await localDoc({ deleted: true });
    await ctx.prisma.document.update({
      where: { id: item.doc.id },
      data: { deletedAt: new Date(0), retentionUntil: new Date(0) },
    });
    const purge = await maintenance.run('DOCUMENT_PURGE', 'scheduler');
    expect(purge.summary).toMatchObject({ purged: 1, reswept: 0 });
    expect(existsSync(item.path)).toBe(false);

    // The migration copied the blob to S3 just before the purge stamped the row, then crashed
    // before its switch (which would have failed and removed the copy): the next purge run deletes
    // the location on both drivers.
    mem.objects.set(item.doc.storageKey, item.sealed);
    writeFileSync(item.path, item.sealed, { mode: 0o600 });
    const next = await maintenance.run('DOCUMENT_PURGE', 'scheduler');
    expect(next.summary).toMatchObject({ scanned: 0, reswept: 1 });
    expect(existsSync(item.path)).toBe(false);
    expect(mem.objects.has(item.doc.storageKey)).toBe(false);
    expect((await row(item.doc.id)).storageDriver).toBe('local');
  });

  it('lets a download that read the row before the move follow the document to S3', async () => {
    const item = await localDoc();
    const stale = await row(item.doc.id);
    expect((await run()).summary).toMatchObject({ migrated: 1 });
    const storage = ctx.app.get(DocumentStorageService);
    expect((await storage.read(stale, ownerId)).equals(item.content)).toBe(true);
  });
});
