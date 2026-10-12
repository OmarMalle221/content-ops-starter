import { definePart } from './define';

/**
 * Phase 7 — document antivirus verdicts, retention-aware purge and storage migration. Only the
 * `documentStorage` namespace lives here; FR defines the shape, EN mirrors it.
 */
export const documentStoragePart = definePart(
  {
    documentStorage: {
      scan: {
        NOT_SCANNED: 'Non analysé',
        CLEAN: 'Analysé — sain',
        INFECTED: 'Bloqué — menace détectée',
        SKIPPED: 'Analyse désactivée',
      },
    },
  },
  {
    documentStorage: {
      scan: {
        NOT_SCANNED: 'Not scanned',
        CLEAN: 'Scanned — clean',
        INFECTED: 'Blocked — threat detected',
        SKIPPED: 'Scanning disabled',
      },
    },
  },
);
