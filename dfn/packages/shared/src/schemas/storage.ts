import { z } from 'zod';
import { KeyPurpose } from '../enums';

/**
 * Phase 6 — encrypted object storage & key rotation request schemas (zod).
 */

export const keyPurposeSchema = z.nativeEnum(KeyPurpose);

/** POST /v1/admin/keys/rotate — rotate one purpose, or every purpose when omitted. */
export const rotateKeysSchema = z
  .object({
    purpose: keyPurposeSchema.optional(),
  })
  .strict();
export type RotateKeysInput = z.infer<typeof rotateKeysSchema>;

/** Actions the key ring status may offer (server-driven). */
export const KeyRingAction = { ROTATE: 'ROTATE' } as const;
export type KeyRingAction = (typeof KeyRingAction)[keyof typeof KeyRingAction];
