import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../domain-error';

/**
 * Encryption context of a wrapped data key. It is authenticated by the KMS (AWS
 * EncryptionContext, GCM additional data for the local KMS): a wrapped key copied onto another
 * row (another purpose or key id) does not unwrap.
 */
export interface KmsContext {
  purpose: string;
  keyId: string;
}

export type KmsProviderName = 'local' | 'aws';
export type KmsOperation = 'wrap' | 'unwrap';

/**
 * Stable, identifier-free failure labels. Provider messages are never surfaced: AWS errors may
 * quote key ARNs, account ids or request ids.
 */
export type KmsFailureReason =
  | 'ACCESS_DENIED'
  | 'NO_CREDENTIALS'
  | 'KEY_NOT_FOUND'
  | 'KEY_DISABLED'
  | 'INVALID_CIPHERTEXT'
  | 'MASTER_KEY_MISMATCH'
  | 'INVALID_KEY_LENGTH'
  | 'THROTTLED'
  | 'UNREACHABLE'
  | 'ERROR';

/**
 * Key management service holding the master key that wraps the key ring's data keys (envelope
 * encryption, ADR-0014). Data keys only ever exist in clear in the memory of the API replicas.
 */
export interface KmsProvider {
  readonly name: KmsProviderName;
  /**
   * Reference of the master key new data keys are wrapped with (stored as EncryptionKey.kmsKeyRef):
   * a short fingerprint for the local KMS, the configured key id / ARN / alias for AWS. Never the
   * key itself.
   */
  readonly keyRef: string;
  wrap(dataKey: Buffer, context: KmsContext): Promise<Buffer>;
  /**
   * Unwraps a data key, always with the configured master key: a wrapped key planted in the
   * database under any other master key is refused. `keyRef` is the reference recorded when the key
   * was wrapped; a provider that can tell (local fingerprint) refuses a mismatch up front with
   * MASTER_KEY_MISMATCH. AWS cannot tell from the reference (alias and ARN of one key differ) and
   * relies on KMS, whose IncorrectKeyException maps to the same reason.
   */
  unwrap(wrapped: Buffer, context: KmsContext, keyRef?: string): Promise<Buffer>;
}

/** The single error every KMS failure maps to: 503 KMS_UNAVAILABLE with a stable reason. */
export function kmsUnavailable(
  provider: KmsProviderName,
  operation: KmsOperation,
  reason: KmsFailureReason,
): DomainError {
  return new DomainError(
    ErrorCode.KMS_UNAVAILABLE,
    `The key management service could not ${operation} the data key (${reason})`,
    HttpStatus.SERVICE_UNAVAILABLE,
    { provider, operation, reason },
  );
}

/** Reason carried by a KMS_UNAVAILABLE error (or "ERROR" for anything else). */
export function kmsFailureReason(err: unknown): string {
  if (err instanceof DomainError && err.code === ErrorCode.KMS_UNAVAILABLE) {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === 'string') return reason;
  }
  return 'ERROR';
}
