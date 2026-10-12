import { z } from 'zod';

/**
 * Phase 7 — document antivirus verdicts, retention-aware purge and storage migration: shared
 * request / response schemas. Owned by the document storage work area.
 */
export const documentStorageSchemasVersion = z.literal(1);
