import { z } from 'zod';
import { mfaProofShape } from './passkeys';

/**
 * Phase 7 — KMS-managed data keys (envelope encryption, ADR-0014): request schemas and shared
 * constants of the key management endpoints.
 */

/** Key ids of managed data keys: `kms-YYYYMMDD-xxxxxx` (the "kms-" prefix is reserved). */
export const MANAGED_KEY_ID_PATTERN = /^kms-\d{8}-[0-9a-f]{6}$/;
export const managedKeyIdSchema = z.string().regex(MANAGED_KEY_ID_PATTERN, 'Unknown managed key id');

/** Lifecycle of a managed data key (mirrors the EncryptionKeyStatus database enum). */
export const ManagedKeyStatus = {
  /** Loaded by every replica for decryption; becomes ACTIVE once its activation delay has elapsed. */
  STAGED: 'STAGED',
  /** Seals the new values of its purpose (one per purpose). */
  ACTIVE: 'ACTIVE',
  /** Former active key: still opens the values sealed with it until they are re-encrypted. */
  DECRYPT_ONLY: 'DECRYPT_ONLY',
  /** No value references it any more: no longer loaded (its wrapped form is kept for the record). */
  RETIRED: 'RETIRED',
} as const;
export type ManagedKeyStatus = (typeof ManagedKeyStatus)[keyof typeof ManagedKeyStatus];

/** Server-driven actions of the managed keys console. */
export const ManagedKeyAction = {
  /** POST /v1/admin/keys/:purpose/generate (offered per purpose). */
  GENERATE: 'GENERATE',
  /** POST /v1/admin/keys/:purpose/:keyId/retire (offered per DECRYPT_ONLY key). */
  RETIRE: 'RETIRE',
} as const;
export type ManagedKeyAction = (typeof ManagedKeyAction)[keyof typeof ManagedKeyAction];

/**
 * POST /v1/admin/keys/:purpose/generate — stages a new data key. A fresh second factor is
 * required when the acting admin has MFA or a passkey (step-up operation "keys.manage").
 */
export const generateManagedKeySchema = z.object({ ...mfaProofShape }).strict();
export type GenerateManagedKeyInput = z.infer<typeof generateManagedKeySchema>;

/**
 * POST /v1/admin/keys/:purpose/:keyId/retire — DECRYPT_ONLY → RETIRED, refused (409
 * KEY_LIFECYCLE_CONFLICT, with the counts) while a sealed value or a document blob still uses it.
 */
export const retireManagedKeySchema = z.object({ ...mfaProofShape }).strict();
export type RetireManagedKeyInput = z.infer<typeof retireManagedKeySchema>;
