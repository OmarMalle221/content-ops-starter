import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
    // Soft delete removes the blob.
    expect(() => statSync(join(dir, doc.storageKey))).toThrow();
    expect((await owner.delete(`/v1/documents/${doc.id}`)).status).toBe(404);
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

      // C. Deleted during the swap: nothing is resurrected, every copy is removed.
      const c = await legacyDoc('C');
      faulty.afterPut = async (key) => {
        if (key !== c.storageKey) return;
        faulty.afterPut = null;
        await ctx.prisma.document.update({ where: { id: c.doc.id }, data: { deletedAt: new Date() } });
        await faulty.inner.delete(c.storageKey);
      };
      expect(await storage.reseal(c.doc)).toBe('current');
      expect(() => statSync(join(dir, c.storageKey))).toThrow();
      expect(() => statSync(c.tempPath)).toThrow();

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
