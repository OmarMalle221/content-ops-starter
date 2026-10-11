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

  /** Best-effort removal of a blob (soft delete, failed upload): failures are logged, not thrown. */
  async remove(ref: { storageKey: string; storageDriver: string }): Promise<boolean> {
    try {
      await this.stores.forDriver(ref.storageDriver).delete(ref.storageKey);
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
      await this.audit.log({
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
    await this.audit.log({
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
   *  3. swap: overwrite the original key (atomic per object on every driver) and verify it;
   *     on failure the original bytes are written back (the verified temp copy is kept if even
   *     that fails, so a good copy always exists);
   *  4. delete the temporary copy, then record the new key id (compare-and-set on the old one).
   * A crash between 3 and 4 leaves a new blob with the old key id: reads and the next rotation
   * recognise the blob header and only fix the row ("repaired"). Never deletes the only copy.
   */
  async reseal(doc: StoredDocumentRef): Promise<ResealOutcome> {
    const active = this.ring.activeKeyId(KeyPurpose.DOCUMENTS);
    const store = this.stores.forDriver(doc.storageDriver);
    const { plaintext, keyId: currentKeyId, sealed: original } = await this.openVerified(doc, null);
    if (currentKeyId === active) {
      if (recordedKeyId(currentKeyId) === doc.encryptionKeyId) return 'current';
      return (await this.repairKeyId(doc, currentKeyId, null)) ? 'repaired' : 'current';
    }

    const { sealed, keyId } = this.ring.sealBuffer(KeyPurpose.DOCUMENTS, plaintext);
    const tempKey = rotationTempKey(doc.id);
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

    try {
      await store.put(doc.storageKey, sealed, { contentType: 'application/octet-stream' });
      if (!(await store.get(doc.storageKey)).equals(sealed)) throw new Error('swap verification failed');
    } catch (err) {
      try {
        await store.put(doc.storageKey, original, { contentType: 'application/octet-stream' });
        await store.delete(tempKey);
      } catch {
        this.logger.error(`document ${doc.id}: rotation swap failed; verified copy kept at ${tempKey}`);
      }
      if (err instanceof DomainError) throw err;
      throw await this.integrityFailure(doc, 'ROTATION_SWAP_FAILED', null, keyId);
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
}
