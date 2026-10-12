import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ErrorCode, KeyPurpose, type StorageDriver } from '@dfn/shared';
import { sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { LEGACY_KEY_ID, keyRingFor, type KeyRing } from '../../common/keyring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BlobStoreRegistry } from '../../common/storage/blob-store.registry';
import { isStorageError, rotationTempKey } from '../../common/storage/blob-store';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';

/** Columns of a Document row needed to locate, open and verify its blob. */
export interface StoredDocumentRef {
  id: string;
  organizationId: string;
  storageKey: string;
  storageDriver: string;
  encryptionKeyId: string | null;
  sha256: string;
}

export type IntegrityFailureReason =
  | 'DECRYPT_FAILED'
  | 'SHA256_MISMATCH'
  | 'ROTATION_VERIFY_FAILED'
  | 'ROTATION_SWAP_FAILED';

export type ResealOutcome = 'rotated' | 'repaired' | 'current';

/** Document.encryptionKeyId stores null for the legacy layout. */
export function recordedKeyId(keyId: string): string | null {
  return keyId === LEGACY_KEY_ID ? null : keyId;
}

/**
 * Encrypted document blobs: sealing with the key ring, storage through the BlobStore of the
 * document's driver, and integrity verification on every read.
 *
 * Reading never returns bytes that do not decrypt with an authenticated key AND hash to the
 * SHA-256 recorded at upload: any failure is audited (`document.integrity_failed`) and refused
 * with 409 — corrupted or substituted content is never served.
 *
 * The key id recorded on the row is a hint: blobs written by the key ring carry their key id in
 * their header, so a row left behind by an interrupted rotation (new blob, old key id) is still
 * readable and is repaired on the spot (`document.key_id_repaired`).
 */
@Injectable()
export class DocumentStorageService {
  private readonly logger = new Logger(DocumentStorageService.name);

  constructor(
    private readonly stores: BlobStoreRegistry,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get ring(): KeyRing {
    return keyRingFor(this.env);
  }

  /** Driver new documents are written to. */
  get activeDriver(): StorageDriver {
    return this.stores.activeDriver;
  }

  /** Seals `plaintext` with the active documents key and stores it under `key` (active driver). */
  async put(
    key: string,
    plaintext: Buffer,
  ): Promise<{ storageDriver: StorageDriver; encryptionKeyId: string | null }> {
    const { sealed, keyId } = this.ring.sealBuffer(KeyPurpose.DOCUMENTS, plaintext);
    const store = this.stores.active;
    await store.put(key, sealed, { contentType: 'application/octet-stream' });
    return { storageDriver: store.driver, encryptionKeyId: recordedKeyId(keyId) };
  }

  /**
   * Best-effort removal of a blob (soft delete, failed upload): failures are logged, not thrown.
   * With the document id, a leftover key-rotation copy (`rotation-tmp/<id>`) is removed too.
   */
  async remove(ref: { id?: string; storageKey: string; storageDriver: string }): Promise<boolean> {
    try {
      const store = this.stores.forDriver(ref.storageDriver);
      await store.delete(ref.storageKey);
      if (ref.id) await store.delete(rotationTempKey(ref.id)).catch(() => undefined);
      return true;
    } catch (err) {
      this.logger.warn(
        `blob removal failed (driver=${ref.storageDriver}): ${isStorageError(err) ? err.reason : 'error'}`,
      );
      return false;
    }
  }

  /**
   * Decrypted, integrity-checked content of a document. Repairs a stale encryptionKeyId when the
   * blob header proves another (configured) key sealed it.
   */
  async read(doc: StoredDocumentRef, actorUserId: string | null): Promise<Buffer> {
    const { plaintext, keyId } = await this.openVerified(doc, actorUserId);
    if (recordedKeyId(keyId) !== doc.encryptionKeyId) await this.repairKeyId(doc, keyId, actorUserId);
    return plaintext;
  }

  /**
   * Reads and opens a blob, trying the recorded key id first and then the id named in the blob
   * header. Throws KEY_NOT_FOUND (503) when the only candidate key is missing from the ring, and
   * an audited integrity error (409) when the blob does not authenticate or its hash differs.
   */
  async openVerified(
    doc: StoredDocumentRef,
    actorUserId: string | null,
  ): Promise<{ plaintext: Buffer; keyId: string; sealed: Buffer }> {
    const sealed = await this.stores.forDriver(doc.storageDriver).get(doc.storageKey);
    const recorded = doc.encryptionKeyId ?? LEGACY_KEY_ID;
    const candidates = [recorded];
    const fromHeader = this.ring.keyIdOfBuffer(sealed);
    if (fromHeader !== recorded) candidates.push(fromHeader);

    let missingKey: string | null = null;
    let decryptFailed = false;
    for (const keyId of candidates) {
      if (!this.ring.hasKey(KeyPurpose.DOCUMENTS, keyId)) {
        missingKey ??= keyId;
        continue;
      }
      let plaintext: Buffer;
      try {
        plaintext = this.ring.openBuffer(KeyPurpose.DOCUMENTS, sealed, keyId);
      } catch {
        decryptFailed = true;
        continue;
      }
      if (sha256Hex(plaintext) !== doc.sha256) {
        throw await this.integrityFailure(doc, 'SHA256_MISMATCH', actorUserId, keyId);
      }
      return { plaintext, keyId, sealed };
    }
    if (missingKey && !decryptFailed) {
      await this.auditFailure({
        actorUserId,
        organizationId: doc.organizationId,
        action: 'document.key_unavailable',
        entityType: 'Document',
        entityId: doc.id,
        metadata: { keyId: missingKey, storageDriver: doc.storageDriver },
      });
      throw new DomainError(
        ErrorCode.KEY_NOT_FOUND,
        'The encryption key of this document is not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
        { documentId: doc.id, keyId: missingKey },
      );
    }
    throw await this.integrityFailure(doc, 'DECRYPT_FAILED', actorUserId, recorded);
  }

  /** Audits an integrity failure and returns the error to throw (409, content withheld). */
  private async integrityFailure(
    doc: StoredDocumentRef,
    reason: IntegrityFailureReason,
    actorUserId: string | null,
    keyId: string,
  ): Promise<DomainError> {
    this.logger.error(`document ${doc.id} failed its integrity check (${reason}, key ${keyId})`);
    await this.auditFailure({
      actorUserId,
      organizationId: doc.organizationId,
      action: 'document.integrity_failed',
      entityType: 'Document',
      entityId: doc.id,
      metadata: { reason, keyId, storageDriver: doc.storageDriver },
    });
    return new DomainError(
      ErrorCode.DOCUMENT_INTEGRITY_FAILED,
      'Document integrity check failed — the content is withheld',
      HttpStatus.CONFLICT,
      { documentId: doc.id, reason },
    );
  }

  /**
   * Audits a read failure. Failures met by the key-rotation job (no actor) are audited once a day
   * per document and action — the job retries every interval and its run summary counts them.
   */
  private async auditFailure(entry: Parameters<AuditService['log']>[0] & { entityId: string }) {
    if (!entry.actorUserId) {
      const recent = await this.prisma.auditLog.findFirst({
        where: {
          action: entry.action,
          entityType: 'Document',
          entityId: entry.entityId,
          createdAt: { gt: new Date(Date.now() - 24 * 3600_000) },
        },
        select: { id: true },
      });
      if (recent) return;
    }
    await this.audit.log(entry);
  }

  /** Aligns Document.encryptionKeyId with the key that actually sealed the blob (compare-and-set). */
  private async repairKeyId(doc: StoredDocumentRef, keyId: string, actorUserId: string | null) {
    const { count } = await this.prisma.document.updateMany({
      where: { id: doc.id, encryptionKeyId: doc.encryptionKeyId },
      data: { encryptionKeyId: recordedKeyId(keyId) },
    });
    if (count === 0) return false;
    await this.audit.log({
      actorUserId,
      organizationId: doc.organizationId,
      action: 'document.key_id_repaired',
      entityType: 'Document',
      entityId: doc.id,
      metadata: { from: doc.encryptionKeyId ?? LEGACY_KEY_ID, to: keyId },
    });
    return true;
  }

  /**
   * Key rotation of one document, crash-safe:
   *  1. open and verify the current blob (recorded key, then header key);
   *  2. seal the plaintext with the active key, write it under a temporary key and read it back —
   *     it must be byte-identical, decrypt, and hash to Document.sha256;
   *  3. swap: overwrite the original key (atomic per object on every driver) and verify it. On a
   *     failure the outcome is settled from what storage actually holds (`settleFailedSwap`) —
   *     the old-key blob is never written back blindly: a concurrent download may already have
   *     moved the row to the new key id, and a concurrent deletion must not be undone;
   *  4. delete the temporary copy, then record the new key id (compare-and-set on the old one).
   * A crash between 3 and 4 leaves a new blob with the old key id: reads and the next rotation
   * recognise the blob header and only fix the row ("repaired"). Never deletes the only copy.
   */
  async reseal(doc: StoredDocumentRef): Promise<ResealOutcome> {
    const active = this.ring.activeKeyId(KeyPurpose.DOCUMENTS);
    const store = this.stores.forDriver(doc.storageDriver);
    const tempKey = rotationTempKey(doc.id);
    const { plaintext, keyId: currentKeyId, sealed: original } = await this.openVerified(doc, null);
    if (currentKeyId === active) {
      // A copy left by a run that crashed after its swap is no longer needed.
      await store.delete(tempKey).catch(() => undefined);
      if (recordedKeyId(currentKeyId) === doc.encryptionKeyId) return 'current';
      return (await this.repairKeyId(doc, currentKeyId, null)) ? 'repaired' : 'current';
    }

    const { sealed, keyId } = this.ring.sealBuffer(KeyPurpose.DOCUMENTS, plaintext);
    await store.put(tempKey, sealed, { contentType: 'application/octet-stream' });
    const copy = await store.get(tempKey);
    let verified = copy.equals(sealed);
    if (verified) {
      try {
        verified = sha256Hex(this.ring.openBuffer(KeyPurpose.DOCUMENTS, copy, keyId)) === doc.sha256;
      } catch {
        verified = false;
      }
    }
    if (!verified) {
      await store.delete(tempKey).catch(() => undefined);
      throw await this.integrityFailure(doc, 'ROTATION_VERIFY_FAILED', null, keyId);
    }

    let swapError: unknown = null;
    try {
      await store.put(doc.storageKey, sealed, { contentType: 'application/octet-stream' });
      if (!(await store.get(doc.storageKey)).equals(sealed))
        swapError = new Error('swap verification failed');
    } catch (err) {
      swapError = err;
    }
    if (swapError) {
      const settled = await this.settleFailedSwap(doc, tempKey, sealed, original, currentKeyId, keyId);
      if (settled === 'deleted') return 'current';
      if (settled !== 'swapped') {
        if (swapError instanceof DomainError) throw swapError;
        throw await this.integrityFailure(doc, 'ROTATION_SWAP_FAILED', null, keyId);
      }
    }
    await store.delete(tempKey).catch(() => undefined);

    const { count } = await this.prisma.document.updateMany({
      where: { id: doc.id, encryptionKeyId: doc.encryptionKeyId, deletedAt: null },
      data: { encryptionKeyId: recordedKeyId(keyId) },
    });
    if (count === 0) {
      // Soft-deleted while we were rotating: its blob must not be resurrected.
      const row = await this.prisma.document.findUnique({
        where: { id: doc.id },
        select: { deletedAt: true },
      });
      if (!row || row.deletedAt) await this.remove(doc);
    }
    return 'rotated';
  }

  /**
   * Decides what a failed swap left behind, from storage itself:
   * - the document was deleted meanwhile → every copy is removed ('deleted');
   * - the main object holds the new blob (the verification read failed) → 'swapped';
   * - it still holds the old blob → the temp copy is dropped and the row is moved back to the
   *   old key id if a concurrent download had already repaired it to the new one ('kept');
   * - it is missing or unknown → the VERIFIED new blob is written back (never the old one) and
   *   checked; if even that fails, the temp copy is kept so a good copy exists ('unresolved').
   */
  private async settleFailedSwap(
    doc: StoredDocumentRef,
    tempKey: string,
    sealed: Buffer,
    original: Buffer,
    oldKeyId: string,
    newKeyId: string,
  ): Promise<'deleted' | 'swapped' | 'kept' | 'unresolved'> {
    const store = this.stores.forDriver(doc.storageDriver);
    const row = await this.prisma.document.findUnique({
      where: { id: doc.id },
      select: { deletedAt: true },
    });
    if (!row || row.deletedAt) {
      await this.remove(doc);
      return 'deleted';
    }
    const current = await store.get(doc.storageKey).catch(() => null);
    if (current?.equals(sealed)) return 'swapped';
    if (current?.equals(original)) {
      await store.delete(tempKey).catch(() => undefined);
      await this.prisma.document.updateMany({
        where: { id: doc.id, encryptionKeyId: recordedKeyId(newKeyId) },
        data: { encryptionKeyId: recordedKeyId(oldKeyId) },
      });
      return 'kept';
    }
    try {
      await store.put(doc.storageKey, sealed, { contentType: 'application/octet-stream' });
      if ((await store.get(doc.storageKey)).equals(sealed)) return 'swapped';
    } catch {
      // fall through: the verified copy stays at tempKey
    }
    this.logger.error(`document ${doc.id}: rotation swap failed; verified copy kept at ${tempKey}`);
    return 'unresolved';
  }
}
