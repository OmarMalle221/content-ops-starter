import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlobStoreRegistry,
  LocalBlobStore,
  StorageError,
  maxSealedBytes,
  rotationTempKey,
  type StorageHealth,
} from '../src/common/storage';
import { AuditService } from '../src/modules/audit/audit.service';
import { DocumentPurgeService, purgeAfter } from '../src/modules/documents/document-purge.service';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  Client,
  PASSWORD,
  PDF_BYTES,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { VEHICLE_TX } from './helpers/protect';

const DAY = 86_400_000;
const GRACE_DAYS = 30;

/** Local store whose behaviour can be altered per call (failures, concurrent changes). */
class HookedStore extends LocalBlobStore {
  failDeleteOn: string | null = null;
  onExists: ((key: string) => Promise<void>) | null = null;
  onDelete: ((key: string) => Promise<void>) | null = null;
  /** Reported instead of the real probe when set (e.g. an unreachable backend). */
  health: StorageHealth | null = null;
  /** Keys passed to exists() and delete(). */
  touched: string[] = [];
  override async exists(key: string) {
    this.touched.push(key);
    if (this.onExists) await this.onExists(key);
    return super.exists(key);
  }
  override async delete(key: string) {
    this.touched.push(key);
    if (key === this.failDeleteOn) throw new StorageError('delete', 'IO_ERROR', 'local');
    await super.delete(key);
    if (this.onDelete) await this.onDelete(key);
  }
  override healthCheck() {
    return this.health ? Promise.resolve(this.health) : super.healthCheck();
  }
}

describe('deferred, retention-aware purge of deleted documents (DOCUMENT_PURGE)', () => {
  let ctx: TestContext;
  let dir: string;
  let owner: Client;
  let ownerId: string;
  let orgId: string;
  let store: HookedStore;
  let purge: DocumentPurgeService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dfn-purge-test-'));
    ctx = await bootTestApp({ STORAGE_DIR: dir, DOCUMENT_PURGE_GRACE_DAYS: String(GRACE_DAYS) });
    purge = ctx.app.get(DocumentPurgeService);
  });
  afterAll(async () => {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.app.get(ReferenceDataService).ensure();
    const reg = await registerUser(ctx, `purge-${randomUUID().slice(0, 8)}@example.com`);
    owner = reg.client;
    ownerId = reg.user.id;
    orgId = reg.user.organizations[0].id;
    store = new HookedStore(dir, maxSealedBytes(15));
    ctx.app.get(BlobStoreRegistry).override('local', store);
  });

  async function upload(title = 'Facture fictive') {
    const res = await owner.upload(
      '/v1/documents',
      { kind: 'INVOICE', title },
      { name: 'facture.pdf', buffer: PDF_BYTES, type: 'application/pdf' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const doc = await ctx.prisma.document.findUniqueOrThrow({ where: { id: res.body.id } });
    return { doc, path: join(dir, doc.storageKey) };
  }
  /** Uploaded, then deleted at `deletedAt` with the given retention date. */
  async function deletedDoc(deletedAt: Date, retentionUntil: Date | null, title?: string) {
    const item = await upload(title);
    await ctx.prisma.document.update({ where: { id: item.doc.id }, data: { deletedAt, retentionUntil } });
    return item;
  }
  /** Deleted through the API (its audit promises retention), then backdated so it is eligible. */
  async function retainedDoc(deletedAt: Date, retentionUntil: Date | null, title?: string) {
    const item = await upload(title);
    expect((await owner.delete(`/v1/documents/${item.doc.id}`)).status).toBe(200);
    await ctx.prisma.document.update({ where: { id: item.doc.id }, data: { deletedAt, retentionUntil } });
    return item;
  }
  const row = (id: string) => ctx.prisma.document.findUniqueOrThrow({ where: { id } });
  const runAt = (now: Date, extra: Partial<Parameters<DocumentPurgeService['run']>[0]> = {}) =>
    purge.run({ triggeredBy: 'scheduler', ...extra }, now);

  it('keeps the blob of a deleted document and lists it with its purge date', async () => {
    const { doc, path } = await upload();
    const res = await owner.delete(`/v1/documents/${doc.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, purgeAfter: doc.retentionUntil!.toISOString() });
    expect(existsSync(path)).toBe(true);
    expect((await owner.get('/v1/documents')).body).toEqual([]);

    const deleted = await owner.get('/v1/documents/deleted');
    expect(deleted.status).toBe(200);
    expect(deleted.body).toHaveLength(1);
    expect(deleted.body[0]).toMatchObject({
      id: doc.id,
      title: 'Facture fictive',
      purge: {
        state: 'RETAINED',
        purgeAfter: doc.retentionUntil!.toISOString(),
        purgedAt: null,
        heldAsEvidence: false,
      },
    });
    expect(deleted.body[0].downloadUrl).toBeUndefined();
    expect((await owner.get(`/v1/documents/${doc.id}/download`)).status).toBe(404);

    // Same scope as the live list: a stranger sees nothing, and cannot list another organisation.
    const stranger = await registerUser(ctx, `stranger-${randomUUID().slice(0, 8)}@example.com`);
    expect((await stranger.client.get('/v1/documents/deleted')).body).toEqual([]);
    expect((await stranger.client.get(`/v1/documents/deleted?organizationId=${orgId}`)).status).toBe(404);

    // Purge date = max(deletedAt + grace, retentionUntil).
    const at = new Date('2026-01-01T00:00:00Z');
    expect(purgeAfter({ deletedAt: at, retentionUntil: null }, 30).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z',
    );
    expect(
      purgeAfter({ deletedAt: at, retentionUntil: new Date('2026-06-01T00:00:00Z') }, 30).toISOString(),
    ).toBe('2026-06-01T00:00:00.000Z');
  });

  it('purges once max(deletedAt + grace, retentionUntil) has passed, stamps the row, audits per organisation', async () => {
    const now = new Date();
    const inGrace = await deletedDoc(now, new Date(now.getTime() - DAY), 'A');
    const retained = await deletedDoc(
      new Date(now.getTime() - 40 * DAY),
      new Date(now.getTime() + 10 * DAY),
      'B',
    );
    const live = await upload('C');
    await ctx.prisma.document.update({
      where: { id: live.doc.id },
      data: { retentionUntil: new Date(now.getTime() - DAY) },
    });

    const first = await runAt(now);
    expect(first.summary).toMatchObject({ graceDays: GRACE_DAYS, scanned: 0, purged: 0, remaining: 0 });

    const second = await runAt(new Date(now.getTime() + 11 * DAY));
    expect(second.summary).toMatchObject({ scanned: 1, purged: 1, missing: 0, failed: 0, remaining: 0 });
    expect(existsSync(retained.path)).toBe(false);
    expect((await row(retained.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    expect(existsSync(inGrace.path)).toBe(true);

    const third = await runAt(new Date(now.getTime() + 31 * DAY));
    expect(third.summary).toMatchObject({ purged: 1, remaining: 0 });
    expect(existsSync(inGrace.path)).toBe(false);
    // The live document is never touched, whatever its retention date.
    expect(existsSync(live.path)).toBe(true);
    expect((await row(live.doc.id)).blobPurgedAt).toBeNull();

    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'document.blobs_purged' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.organizationId === orgId && a.actorUserId === null)).toBe(true);
    expect(audits.map((a) => (a.metadata as { documentIds: string[] }).documentIds)).toEqual([
      [retained.doc.id],
      [inGrace.doc.id],
    ]);

    const listed = await owner.get('/v1/documents/deleted');
    expect(listed.body.map((d: { purge: { state: string } }) => d.purge.state)).toEqual(['PURGED', 'PURGED']);
    expect(listed.body.every((d: { purge: { purgedAt: string | null } }) => d.purge.purgedAt)).toBe(true);

    // Idempotent: nothing left to do.
    const again = await runAt(new Date(now.getTime() + 60 * DAY));
    expect(again.summary).toMatchObject({ scanned: 0, purged: 0, remaining: 0 });
  });

  it('never purges a blob still held as evidence of an open dispute or a milestone', async () => {
    const created = await owner.post('/v1/transactions', VEHICLE_TX);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const txId = created.body.id as string;
    const party = await ctx.prisma.transactionParty.findFirstOrThrow({
      where: { transactionId: txId, userId: ownerId },
    });
    const milestone = await ctx.prisma.milestone.findFirstOrThrow({ where: { transactionId: txId } });
    const dispute = await ctx.prisma.dispute.create({
      data: { transactionId: txId, openedByPartyId: party.id, reason: 'OTHER', description: 'Litige fictif' },
    });
    const past = new Date(Date.now() - 400 * DAY);
    const asDisputeEvidence = await deletedDoc(past, past, 'dispute-evidence');
    const asDisputeMessage = await deletedDoc(past, past, 'dispute-message');
    const asMilestoneEvidence = await deletedDoc(past, past, 'milestone-evidence');
    const free = await deletedDoc(past, past, 'free');
    await ctx.prisma.evidence.create({
      data: { disputeId: dispute.id, documentId: asDisputeEvidence.doc.id, submittedByUserId: ownerId },
    });
    await ctx.prisma.disputeMessage.create({
      data: {
        disputeId: dispute.id,
        authorUserId: ownerId,
        body: 'Pièce jointe',
        documentId: asDisputeMessage.doc.id,
      },
    });
    await ctx.prisma.evidence.create({
      data: { milestoneId: milestone.id, documentId: asMilestoneEvidence.doc.id, submittedByUserId: ownerId },
    });

    const first = await runAt(new Date());
    expect(first.summary).toMatchObject({ purged: 1, remaining: 0 });
    expect(existsSync(free.path)).toBe(false);
    for (const held of [asDisputeEvidence, asDisputeMessage, asMilestoneEvidence]) {
      expect(existsSync(held.path)).toBe(true);
      expect((await row(held.doc.id)).blobPurgedAt).toBeNull();
    }
    const listed = await owner.get('/v1/documents/deleted');
    const heldIds = listed.body
      .filter((d: { purge: { heldAsEvidence: boolean } }) => d.purge.heldAsEvidence)
      .map((d: { id: string }) => d.id)
      .sort();
    expect(heldIds).toEqual(
      [asDisputeEvidence.doc.id, asDisputeMessage.doc.id, asMilestoneEvidence.doc.id].sort(),
    );

    // Once the dispute is closed, its attachments follow the normal retention; milestone evidence stays.
    await ctx.prisma.dispute.update({
      where: { id: dispute.id },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    const second = await runAt(new Date());
    expect(second.summary).toMatchObject({ purged: 2 });
    expect(existsSync(asDisputeEvidence.path)).toBe(false);
    expect(existsSync(asDisputeMessage.path)).toBe(false);
    expect(existsSync(asMilestoneEvidence.path)).toBe(true);
  });

  it('records a legacy missing blob, reports a retained one, retries failures, yields to moves and resumes after a stop', async () => {
    const past = new Date(Date.now() - 400 * DAY);
    // Deleted before the purge was deferred (audit without `blobRetained`): its blob went with it.
    const legacyGone = await deletedDoc(past, past, 'legacy-gone');
    await ctx.prisma.auditLog.create({
      data: {
        action: 'document.deleted',
        entityType: 'Document',
        entityId: legacyGone.doc.id,
        actorUserId: ownerId,
      },
    });
    rmSync(legacyGone.path);
    // Deleted through the API, so its blob should still be there: an anomaly, never stamped.
    const vanished = await retainedDoc(past, past, 'vanished');
    rmSync(vanished.path);
    const failing = await deletedDoc(past, past, 'failing');
    store.failDeleteOn = failing.doc.storageKey;
    const moved = await deletedDoc(past, past, 'moved');
    store.onExists = async (key) => {
      if (key !== moved.doc.storageKey) return;
      // The storage migration switches the row while the purge is working on it.
      await ctx.prisma.document.update({ where: { id: moved.doc.id }, data: { storageDriver: 's3' } });
    };

    const first = await runAt(new Date());
    expect(first.summary).toMatchObject({
      scanned: 4,
      purged: 0,
      missing: 1,
      raced: 1,
      failed: 2,
      remaining: 3,
      errors: { STORAGE_IO_ERROR: 1, STORAGE_NOT_FOUND: 1 },
    });
    expect((await row(legacyGone.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'document.blob_missing', entityId: legacyGone.doc.id },
      }),
    ).toBe(1);
    expect((await row(vanished.doc.id)).blobPurgedAt).toBeNull();
    expect(
      await ctx.prisma.auditLog.count({
        where: { action: 'document.blob_missing', entityId: vanished.doc.id },
      }),
    ).toBe(0);
    expect((await row(failing.doc.id)).blobPurgedAt).toBeNull();
    expect(existsSync(failing.path)).toBe(true);
    expect((await row(moved.doc.id)).blobPurgedAt).toBeNull();
    // Audited per page (the scan starts at a random id and may wrap): aggregate the records.
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'document.blobs_purged' } });
    const metadata = audits.map(
      (a) => a.metadata as { documentIds: string[]; missingDocumentIds: string[]; failed: number },
    );
    expect(metadata.flatMap((m) => m.documentIds)).toEqual([]);
    expect(metadata.flatMap((m) => m.missingDocumentIds)).toEqual([legacyGone.doc.id]);
    expect(metadata.reduce((n, m) => n + m.failed, 0)).toBe(2);

    // Healthy store with every blob back in place (the vanished one restored from a backup): the
    // failures are retried. A stop request (lost lease) ends the run after the current document;
    // the next run resumes with the rest.
    store.failDeleteOn = null;
    store.onExists = null;
    // (Test reset: the row goes back to the local driver with a blob, as if it had never moved.)
    await ctx.prisma.document.update({ where: { id: moved.doc.id }, data: { storageDriver: 'local' } });
    writeFileSync(moved.path, 'sealed-bytes', { mode: 0o600 });
    writeFileSync(vanished.path, 'sealed-bytes', { mode: 0o600 });
    const extra = await deletedDoc(past, past, 'extra');
    const controller = new AbortController();
    store.onDelete = async () => controller.abort();
    const stopped = await runAt(new Date(), { signal: controller.signal });
    expect(stopped.summary).toMatchObject({ scanned: 1, purged: 1, remaining: 3 });
    store.onDelete = null;
    const resumed = await runAt(new Date());
    expect(resumed.summary).toMatchObject({ purged: 3, failed: 0, remaining: 0 });
    for (const item of [failing, moved, vanished, extra]) {
      expect(existsSync(item.path)).toBe(false);
      expect((await row(item.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    }
  });

  it('completes a purge interrupted between its delete and its stamp, never one whose delete failed', async () => {
    const past = new Date(Date.now() - 400 * DAY);
    const crashed = await retainedDoc(past, past, 'crashed');
    const appliedAnyway = await retainedDoc(past, past, 'delete-reported-failure-but-applied');
    const failedDelete = await retainedDoc(past, past, 'delete-really-failed');
    const intents = (id: string) =>
      ctx.prisma.auditLog.findMany({
        where: {
          entityId: id,
          action: { in: ['document.blob_purge_started', 'document.blob_purge_aborted'] },
        },
        orderBy: { createdAt: 'asc' },
      });

    // Run 1: the blob of `crashed` is destroyed, then the database refuses the stamp (a trigger
    // stands in for a crash or a failover); the store reports a failure for `appliedAnyway`
    // although it removed the blob (a timed-out S3 DeleteObject, for instance); the delete of
    // `failedDelete` really fails (the blob stays).
    await ctx.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION dfn_test_refuse_stamp() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${crashed.doc.id}' AND NEW."blobPurgedAt" IS NOT NULL THEN
          RAISE EXCEPTION 'connection terminated';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await ctx.prisma.$executeRawUnsafe(
      'CREATE TRIGGER dfn_test_refuse_stamp BEFORE UPDATE ON "Document" FOR EACH ROW EXECUTE FUNCTION dfn_test_refuse_stamp()',
    );
    store.onDelete = async (key) => {
      if (key === appliedAnyway.doc.storageKey) throw new StorageError('delete', 'UNREACHABLE', 'local');
    };
    store.failDeleteOn = failedDelete.doc.storageKey;
    try {
      const first = await runAt(new Date());
      expect(first.summary).toMatchObject({ scanned: 3, purged: 1, failed: 2, remaining: 2 });
    } finally {
      await ctx.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS dfn_test_refuse_stamp ON "Document"');
      await ctx.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS dfn_test_refuse_stamp()');
      store.onDelete = null;
      store.failDeleteOn = null;
    }
    // A delete reported failed but applied is a purge like any other.
    expect(existsSync(appliedAnyway.path)).toBe(false);
    expect((await row(appliedAnyway.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    expect((await intents(appliedAnyway.doc.id)).map((a) => a.action)).toEqual([
      'document.blob_purge_started',
    ]);
    // The crashed one: blob gone, row not stamped, intent bound to its location.
    expect(existsSync(crashed.path)).toBe(false);
    expect((await row(crashed.doc.id)).blobPurgedAt).toBeNull();
    const crashedIntents = await intents(crashed.doc.id);
    expect(crashedIntents.map((a) => a.action)).toEqual(['document.blob_purge_started']);
    expect(crashedIntents[0]!.metadata).toMatchObject({
      storageDriver: 'local',
      storageKey: crashed.doc.storageKey,
    });
    // The failed delete withdrew its intent; its blob is still there.
    expect(existsSync(failedDelete.path)).toBe(true);
    expect((await intents(failedDelete.doc.id)).map((a) => a.action)).toEqual([
      'document.blob_purge_started',
      'document.blob_purge_aborted',
    ]);

    // Then the blob of `failedDelete` disappears for another reason (a wrong volume, say): it is
    // never assumed destroyed by the purge. The interrupted purge is completed and audited.
    rmSync(failedDelete.path);
    const second = await runAt(new Date());
    expect(second.summary).toMatchObject({
      purged: 1,
      failed: 1,
      errors: { STORAGE_NOT_FOUND: 1 },
      remaining: 1,
    });
    expect((await row(crashed.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    expect((await row(failedDelete.doc.id)).blobPurgedAt).toBeNull();
    const purgedIds = (
      await ctx.prisma.auditLog.findMany({ where: { action: 'document.blobs_purged' } })
    ).flatMap((a) => (a.metadata as { documentIds: string[] }).documentIds);
    expect(purgedIds.sort()).toEqual([appliedAnyway.doc.id, crashed.doc.id].sort());
    const listed = await owner.get('/v1/documents/deleted');
    const state = (id: string) =>
      listed.body.find((d: { id: string; purge: { state: string } }) => d.id === id)?.purge.state;
    expect(state(crashed.doc.id)).toBe('PURGED');
    expect(state(failedDelete.doc.id)).toBe('RETAINED');

    // An intent recorded for another location (another driver, or another key on the same
    // driver: the document moved since) proves nothing.
    const movedDriver = await retainedDoc(past, past, 'moved-driver-after-intent');
    const movedKey = await retainedDoc(past, past, 'moved-key-after-intent');
    for (const [item, location] of [
      [movedDriver, { storageDriver: 's3', storageKey: movedDriver.doc.storageKey }],
      [movedKey, { storageDriver: 'local', storageKey: `${movedKey.doc.storageKey}.old` }],
    ] as const) {
      await ctx.prisma.auditLog.create({
        data: {
          action: 'document.blob_purge_started',
          entityType: 'Document',
          entityId: item.doc.id,
          metadata: location,
        },
      });
      rmSync(item.path);
    }
    const third = await runAt(new Date());
    expect(third.summary).toMatchObject({ purged: 0, failed: 3, errors: { STORAGE_NOT_FOUND: 3 } });
    expect((await row(movedDriver.doc.id)).blobPurgedAt).toBeNull();
    expect((await row(movedKey.doc.id)).blobPurgedAt).toBeNull();
  });

  it('never deletes a blob whose purge intent could not be recorded', async () => {
    const past = new Date(Date.now() - 400 * DAY);
    const item = await retainedDoc(past, past, 'intent-refused');
    const audit = ctx.app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = vi
      .spyOn(audit, 'log')
      .mockImplementation((input, db) =>
        input.action === 'document.blob_purge_started'
          ? Promise.reject(new Error('database unavailable'))
          : original(input, db),
      );
    const deletes: string[] = [];
    store.onDelete = async (key) => {
      deletes.push(key);
    };
    try {
      const run = await runAt(new Date());
      expect(run.summary).toMatchObject({ purged: 0, failed: 1, remaining: 1 });
    } finally {
      spy.mockRestore();
      store.onDelete = null;
    }
    expect(deletes).not.toContain(item.doc.storageKey);
    expect(existsSync(item.path)).toBe(true);
    expect((await row(item.doc.id)).blobPurgedAt).toBeNull();
    // Once the database takes the intent again, the purge proceeds normally.
    expect((await runAt(new Date())).summary).toMatchObject({ purged: 1, failed: 0, remaining: 0 });
    expect(existsSync(item.path)).toBe(false);
  });

  it('stamps nothing while the store is unhealthy, nor for a retained blob that is merely missing', async () => {
    const past = new Date(Date.now() - 400 * DAY);
    const docs = [
      await retainedDoc(past, past, 'A'),
      await retainedDoc(past, past, 'B'),
      await retainedDoc(past, past, 'C'),
    ];
    const untouched = async () => {
      for (const item of docs) expect((await row(item.doc.id)).blobPurgedAt).toBeNull();
    };
    const registry = ctx.app.get(BlobStoreRegistry);

    // STORAGE_DIR under a regular file: the volume is not there (mkdir fails with ENOTDIR), so the
    // health probe fails before any blob is looked up — nothing is counted missing, nothing stamped.
    writeFileSync(join(dir, 'not-a-dir'), '');
    const unmounted = new HookedStore(join(dir, 'not-a-dir', 'storage'), maxSealedBytes(15));
    registry.override('local', unmounted);
    const first = await runAt(new Date());
    expect(first.summary).toMatchObject({
      scanned: 3,
      purged: 0,
      missing: 0,
      failed: 3,
      remaining: 3,
      errors: { STORAGE_IO_ERROR: 3 },
    });
    expect(unmounted.touched).toEqual([]);
    await untouched();
    for (const item of docs) expect(existsSync(item.path)).toBe(true);

    // A backend that reports itself unreachable (S3 endpoint down): same, with its own reason.
    store.health = { driver: 'local', ok: false, latencyMs: 0, location: dir, reason: 'UNREACHABLE' };
    registry.override('local', store);
    const down = await runAt(new Date());
    expect(down.summary).toMatchObject({ failed: 3, remaining: 3, errors: { STORAGE_UNREACHABLE: 3 } });
    expect(store.touched).toEqual([]);
    await untouched();
    store.health = null;

    // Healthy store whose retained blobs are gone (wrong bucket, volume swapped): reported as
    // STORAGE_NOT_FOUND and retried, never recorded as purged — the erasure has not happened.
    for (const item of docs) rmSync(item.path);
    const gone = await runAt(new Date());
    expect(gone.summary).toMatchObject({
      scanned: 3,
      purged: 0,
      missing: 0,
      failed: 3,
      remaining: 3,
      errors: { STORAGE_NOT_FOUND: 3 },
    });
    await untouched();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'document.blob_missing' } })).toBe(0);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'document.blobs_purged' } });
    const metadata = audits.map((a) => a.metadata as { missingDocumentIds: string[]; failed: number });
    expect(metadata.flatMap((m) => m.missingDocumentIds)).toEqual([]);
    expect(metadata.reduce((n, m) => n + m.failed, 0)).toBe(9);

    // Blobs restored from the backup: purged as usual.
    for (const item of docs) writeFileSync(item.path, 'sealed-bytes', { mode: 0o600 });
    expect((await runAt(new Date())).summary).toMatchObject({ purged: 3, failed: 0, remaining: 0 });
    for (const item of docs) {
      expect(existsSync(item.path)).toBe(false);
      expect((await row(item.doc.id)).blobPurgedAt).toBeInstanceOf(Date);
    }
  });

  it('deletes once more the location of rows purged since the previous run (rotation replica crashed after its swap)', async () => {
    const past = new Date(Date.now() - 400 * DAY);
    const maintenance = ctx.app.get(MaintenanceService);
    const item = await deletedDoc(past, past, 'swapped');
    const first = await maintenance.run('DOCUMENT_PURGE', 'scheduler');
    expect(first.status).toBe('COMPLETED');
    expect(first.summary).toMatchObject({ purged: 1, reswept: 0 });
    expect(existsSync(item.path)).toBe(false);

    // A rotation replica re-sealing this blob wrote its swap after the purge's second delete and
    // crashed before its compare-and-set: its copies survive behind the purged row.
    writeFileSync(item.path, 'resealed-bytes', { mode: 0o600 });
    const temp = join(dir, rotationTempKey(item.doc.id));
    mkdirSync(dirname(temp), { recursive: true });
    writeFileSync(temp, 'temp-bytes', { mode: 0o600 });
    const second = await maintenance.run('DOCUMENT_PURGE', 'scheduler');
    expect(second.summary).toMatchObject({ scanned: 0, purged: 0, reswept: 1, remaining: 0 });
    expect(existsSync(item.path)).toBe(false);
    expect(existsSync(temp)).toBe(false);
    expect((await row(item.doc.id)).blobPurgedAt).toBeInstanceOf(Date);

    // Bounded: a row purged before the previous run started is not revisited.
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(item.path, 'resealed-bytes', { mode: 0o600 });
    const third = await maintenance.run('DOCUMENT_PURGE', 'scheduler');
    expect(third.summary).toMatchObject({ reswept: 0 });
    expect(existsSync(item.path)).toBe(true);
    rmSync(item.path);
  });

  it('runs as the DOCUMENT_PURGE maintenance job, reserved to admin:keys on the jobs console', async () => {
    const run = await ctx.app.get(MaintenanceService).run('DOCUMENT_PURGE', 'scheduler');
    expect(run.status).toBe('COMPLETED');
    expect(run.summary).toMatchObject({ graceDays: GRACE_DAYS, scanned: 0, purged: 0, remaining: 0 });

    const login = async (role: 'ADMIN' | 'COMPLIANCE') => {
      const email = `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`;
      await registerUser(ctx, email);
      await promote(ctx, email, role);
      const client = new Client(ctx);
      expect((await client.post('/v1/auth/login', { email, password: PASSWORD })).status).toBe(200);
      return client;
    };
    expect((await (await login('COMPLIANCE')).post('/v1/admin/jobs/DOCUMENT_PURGE/run')).status).toBe(403);
    const byAdmin = await (await login('ADMIN')).post('/v1/admin/jobs/DOCUMENT_PURGE/run');
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body.status).toBe('COMPLETED');
  });
});
