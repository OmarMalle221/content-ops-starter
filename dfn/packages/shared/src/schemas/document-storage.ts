import { z } from 'zod';

/**
 * Phase 7 — document antivirus verdicts, retention-aware purge and storage migration: shared
 * request / response schemas. Owned by the document storage work area.
 */
export const documentStorageSchemasVersion = z.literal(1);

/**
 * Antivirus verdict recorded on a document at upload (mirrors the DocumentScanStatus database
 * enum). INFECTED uploads are refused and never stored; a row can only carry INFECTED if it was
 * flagged afterwards, and such a document is never downloadable.
 */
export const DocumentScanStatus = {
  /** Stored before antivirus scanning existed. */
  NOT_SCANNED: 'NOT_SCANNED',
  CLEAN: 'CLEAN',
  INFECTED: 'INFECTED',
  /** ANTIVIRUS_PROVIDER=none: stored without scanning. */
  SKIPPED: 'SKIPPED',
} as const;
export type DocumentScanStatus = (typeof DocumentScanStatus)[keyof typeof DocumentScanStatus];
export const documentScanStatusSchema = z.nativeEnum(DocumentScanStatus);

/**
 * Engine name of the sandbox scanner: a SIMULATION that only recognises the EICAR test file. The
 * interface says so next to every verdict it produced — it is never presented as real protection.
 */
export const SANDBOX_SCAN_ENGINE = 'sandbox-eicar';

/** `scan` block of a document DTO. */
export interface DocumentScanDto {
  status: DocumentScanStatus;
  /** "sandbox-eicar", "clamd", or null (not scanned / scanning disabled). */
  engine: string | null;
  scannedAt: string | null;
}

/** Blob of a deleted document: kept until its purge date (retention), then purged. */
export const DocumentPurgeState = { RETAINED: 'RETAINED', PURGED: 'PURGED' } as const;
export type DocumentPurgeState = (typeof DocumentPurgeState)[keyof typeof DocumentPurgeState];

/** `purge` block of a deleted document (GET /v1/documents/deleted). */
export interface DocumentPurgeDto {
  state: DocumentPurgeState;
  deletedAt: string;
  /** max(deletedAt + DOCUMENT_PURGE_GRACE_DAYS, retentionUntil): earliest purge of the blob. */
  purgeAfter: string;
  /** Set once the encrypted blob has been destroyed (the metadata row stays). */
  purgedAt: string | null;
  /** The blob is still evidence in an open dispute (or a milestone): the purge waits for it. */
  heldAsEvidence: boolean;
}

/** POST /v1/admin/storage/migration — copy local blobs to S3 now, or only check them (dry run). */
export const storageMigrationRunSchema = z
  .object({
    /** true: read and verify every pending blob and report what would move, without writing. */
    dryRun: z.boolean(),
  })
  .strict();
export type StorageMigrationRunInput = z.infer<typeof storageMigrationRunSchema>;
