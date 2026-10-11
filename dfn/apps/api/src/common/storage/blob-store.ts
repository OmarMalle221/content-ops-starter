import { HttpStatus } from '@nestjs/common';
import { ErrorCode, type StorageDriver } from '@dfn/shared';
import { DomainError } from '../domain-error';

/**
 * Object storage abstraction for encrypted blobs (documents today).
 *
 * Contract:
 *  - keys are generated server-side and must match STORAGE_KEY_RE (no dots, no uppercase, no
 *    leading/trailing or doubled slashes) — a key can therefore never escape the storage root;
 *  - bytes handed to `put` are ALREADY sealed with the key ring: no driver relies on server-side
 *    encryption and no driver ever sees plaintext;
 *  - `put` replaces an existing object atomically (readers see the old or the new bytes, never a
 *    mix), which is what the key-rotation swap relies on;
 *  - every failure surfaces as a StorageError (DomainError STORAGE_UNAVAILABLE, HTTP 503) that
 *    carries an operation and a reason, never a credential or a raw provider message.
 */
export interface BlobStore {
  readonly driver: StorageDriver;
  put(key: string, bytes: Buffer, meta?: BlobMeta): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Never throws: reports whether the backend is reachable and writable/readable. */
  healthCheck(): Promise<StorageHealth>;
}

export interface BlobMeta {
  /** Content type recorded with the object (sealed blobs are always application/octet-stream). */
  contentType?: string;
}

export interface StorageHealth {
  driver: StorageDriver;
  ok: boolean;
  latencyMs: number;
  /** Where blobs live, without any credential (directory, or bucket @ endpoint host). */
  location: string;
  /** Failure reason when ok is false. */
  reason?: StorageFailureReason;
}

export type StorageOperation = 'put' | 'get' | 'delete' | 'exists' | 'health' | 'resolve';

export type StorageFailureReason =
  | 'INVALID_KEY'
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'CHECKSUM_MISMATCH'
  | 'ACCESS_DENIED'
  | 'MISCONFIGURED'
  | 'UNREACHABLE'
  | 'IO_ERROR';

/** Lowercase letters, digits, "/" and "-" only (UUID-based keys such as `<orgId>/<uuid>`). */
export const STORAGE_KEY_RE = /^[a-z0-9/-]+$/;
export const STORAGE_KEY_MAX_LENGTH = 512;

/** Bytes added by the key ring around a document (header + IV + GCM tag), with margin. */
export const SEALED_OVERHEAD_BYTES = 4096;

/** Storage failure: STORAGE_UNAVAILABLE (503), or VALIDATION_FAILED (400) for a malformed key. */
export class StorageError extends DomainError {
  constructor(
    public readonly operation: StorageOperation,
    public readonly reason: StorageFailureReason,
    public readonly driver?: StorageDriver,
  ) {
    super(
      reason === 'INVALID_KEY' ? ErrorCode.VALIDATION_FAILED : ErrorCode.STORAGE_UNAVAILABLE,
      reason === 'INVALID_KEY'
        ? 'Invalid storage key'
        : `Document storage is unavailable (${operation}: ${reason.toLowerCase()})`,
      reason === 'INVALID_KEY' ? HttpStatus.BAD_REQUEST : HttpStatus.SERVICE_UNAVAILABLE,
      { operation, reason, ...(driver ? { driver } : {}) },
    );
    this.name = 'StorageError';
  }
}

export function isStorageError(err: unknown, reason?: StorageFailureReason): err is StorageError {
  return err instanceof StorageError && (reason === undefined || err.reason === reason);
}

/** Throws StorageError(INVALID_KEY) unless `key` is a well-formed server-generated storage key. */
export function assertValidStorageKey(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > STORAGE_KEY_MAX_LENGTH ||
    !STORAGE_KEY_RE.test(key) ||
    key.startsWith('/') ||
    key.endsWith('/') ||
    key.includes('//')
  ) {
    throw new StorageError('resolve', 'INVALID_KEY');
  }
}

/** Upper bound of a sealed document blob for a given MAX_UPLOAD_MB. */
export function maxSealedBytes(maxUploadMb: number): number {
  return maxUploadMb * 1024 * 1024 + SEALED_OVERHEAD_BYTES;
}

/** Temporary key used while a document blob is re-sealed (key rotation), unique per document. */
export function rotationTempKey(documentId: string): string {
  const key = `rotation-tmp/${documentId.toLowerCase()}`;
  assertValidStorageKey(key);
  return key;
}
