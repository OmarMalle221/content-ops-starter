import { z } from 'zod';

/**
 * Phase 7 — KMS-managed data keys (envelope encryption): request schemas of the key management
 * endpoints. Owned by the key management work area.
 */
export const kmsSchemasVersion = z.literal(1);
