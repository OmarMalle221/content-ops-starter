import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../domain-error';

export type ScanVerdict = 'CLEAN' | 'INFECTED';

export interface ScanResult {
  verdict: ScanVerdict;
  /** Signature name reported by the engine (INFECTED only), sanitised — never file content. */
  signature?: string;
}

/**
 * Antivirus engine used on uploads, BEFORE anything is stored.
 *
 * Contract: `scan` resolves with a verdict, or rejects with a ScanUnavailableError (503
 * SCAN_UNAVAILABLE) — the caller then refuses the upload (fail closed). It never returns a
 * "clean" verdict it could not establish.
 */
export interface Scanner {
  /** Recorded on Document.scanEngine ("sandbox-eicar", "clamd"). */
  readonly engine: string;
  scan(bytes: Buffer): Promise<ScanResult>;
}

/** Every ScanFailureReason (bounded label values of dfn_document_scans_total). */
export const SCAN_FAILURE_REASONS = [
  'UNREACHABLE',
  'TIMEOUT',
  'SIZE_LIMIT',
  'ENGINE_ERROR',
  'CONNECTION_LOST',
  'PROTOCOL_ERROR',
] as const;

export type ScanFailureReason =
  /** Connection refused / host unknown. */
  | 'UNREACHABLE'
  /** No verdict within ANTIVIRUS_TIMEOUT_MS. */
  | 'TIMEOUT'
  /** The file is larger than the engine accepts (clamd StreamMaxLength). */
  | 'SIZE_LIMIT'
  /** The engine answered with an error. */
  | 'ENGINE_ERROR'
  /** The connection was closed or reset before a verdict. */
  | 'CONNECTION_LOST'
  /** The answer could not be understood. */
  | 'PROTOCOL_ERROR';

/** 503 SCAN_UNAVAILABLE: the upload is refused because no verdict could be obtained. */
export class ScanUnavailableError extends DomainError {
  constructor(
    public readonly engine: string,
    public readonly reason: ScanFailureReason,
  ) {
    super(
      ErrorCode.SCAN_UNAVAILABLE,
      `Antivirus scan unavailable (${reason.toLowerCase()}): the document was not stored`,
      HttpStatus.SERVICE_UNAVAILABLE,
      { engine, reason },
    );
    this.name = 'ScanUnavailableError';
  }
}

/** Signature names are printable identifiers ("Win.Test.EICAR_HDB-1"): anything else is dropped. */
export function sanitizeSignature(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:/+()-]/g, '').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'unknown';
}
