import { definePart } from './define';

/**
 * Phase 7 — document antivirus verdicts, retention-aware purge and storage migration. Only the
 * `documentStorage` namespace lives here; FR defines the shape, EN mirrors it.
 */
export const documentStoragePart = definePart(
  {
    documentStorage: {
      scan: {
        column: 'Antivirus',
        NOT_SCANNED: 'Non analysé',
        CLEAN: 'Analysé — sain',
        INFECTED: 'Bloqué — menace détectée',
        SKIPPED: 'Analyse désactivée',
        simulated: 'simulation',
        blocked: 'Téléchargement bloqué',
        hint: {
          sandbox:
            'Analyse simulée : le scanner du bac à sable ne détecte que le fichier de test EICAR. Ce n’est pas une protection antivirus réelle.',
          clamd: 'Analysé par ClamAV (clamd) avant l’enregistrement.',
          NOT_SCANNED: 'Téléversé avant la mise en place de l’analyse antivirus.',
          SKIPPED: 'Aucun antivirus n’était configuré lors du téléversement.',
          INFECTED: 'Signalé par l’antivirus : ce fichier n’est jamais servi.',
        },
      },
      deletedDocument: 'Document supprimé — plus téléchargeable',
      deleted: {
        title: 'Documents supprimés',
        subtitle:
          'Le fichier chiffré est conservé pendant la durée de rétention, puis détruit. Un document supprimé n’est plus téléchargeable.',
        deletedAt: 'Supprimé le',
        file: 'Fichier chiffré',
      },
      purge: {
        RETAINED: 'Conservé jusqu’au {date}',
        PURGED: 'Détruit le {date}',
        held: 'Conservé : pièce d’un litige en cours ou d’un jalon',
      },
      errors: {
        DOCUMENT_INFECTED: 'L’antivirus a signalé ce fichier : il n’a pas été enregistré.',
        DOCUMENT_INFECTED_SIMULATED:
          'L’antivirus simulé du bac à sable (il ne reconnaît que le fichier de test EICAR) a signalé ce fichier : il n’a pas été enregistré. Ce n’est pas une protection antivirus réelle.',
        SCAN_UNAVAILABLE:
          'L’analyse antivirus est indisponible : le fichier n’a pas été enregistré. Réessayez plus tard.',
      },
    },
  },
  {
    documentStorage: {
      scan: {
        column: 'Antivirus',
        NOT_SCANNED: 'Not scanned',
        CLEAN: 'Scanned — clean',
        INFECTED: 'Blocked — threat detected',
        SKIPPED: 'Scanning disabled',
        simulated: 'simulated',
        blocked: 'Download blocked',
        hint: {
          sandbox:
            'Simulated scan: the sandbox scanner only detects the EICAR test file. It is not real antivirus protection.',
          clamd: 'Scanned by ClamAV (clamd) before being stored.',
          NOT_SCANNED: 'Uploaded before antivirus scanning was in place.',
          SKIPPED: 'No antivirus was configured at upload time.',
          INFECTED: 'Flagged by the antivirus: this file is never served.',
        },
      },
      deletedDocument: 'Deleted document — no longer downloadable',
      deleted: {
        title: 'Deleted documents',
        subtitle:
          'The encrypted file is kept for the retention period, then destroyed. A deleted document can no longer be downloaded.',
        deletedAt: 'Deleted on',
        file: 'Encrypted file',
      },
      purge: {
        RETAINED: 'Kept until {date}',
        PURGED: 'Destroyed on {date}',
        held: 'Kept: evidence of an open dispute or a milestone',
      },
      errors: {
        DOCUMENT_INFECTED: 'The antivirus flagged this file: it was not stored.',
        DOCUMENT_INFECTED_SIMULATED:
          'The simulated sandbox antivirus (it only recognises the EICAR test file) flagged this file: it was not stored. This is not real antivirus protection.',
        SCAN_UNAVAILABLE:
          'Antivirus scanning is unavailable: the file was not stored. Please try again later.',
      },
    },
  },
);
