import { definePart } from './define';

/** Phase 6 — key ring & storage. Only the `keysAdmin` namespace lives here; FR defines the shape, EN mirrors it. */
export const keysAdminPart = definePart(
  {
    keysAdmin: {
      title: 'Clés de chiffrement et stockage',
      subtitle:
        'Trousseau de clés par usage, valeurs scellées par clé et rotation — données fictives du bac à sable.',
      noSecret: 'Aucune clé n’est jamais affichée : seuls les identifiants de clés et les décomptes le sont.',
      values: 'Valeurs scellées',
      valuesHint: 'secrets MFA, secrets webhooks, identifiants de bénéficiaires et documents',
      pending: 'À re-chiffrer',
      pendingHint: 'valeurs scellées avec une autre clé que la clé active',
      unreadable: 'Illisibles',
      unreadableHint: 'valeurs scellées avec une clé absente du trousseau',
      storage: 'Stockage des documents',
      storageHint: 'pilote actif (STORAGE_DRIVER) — blobs toujours scellés avant envoi',
      drivers: {
        local: 'Disque local',
        s3: 'Stockage objet S3-compatible',
      },
      documentsOn: 'document(s) sur',
      upToDate: 'Tout est scellé avec les clés actives : aucune rotation nécessaire.',
      upToDateShort: 'À jour',
      rotate: 'Lancer la rotation',
      rotatePurpose: 'Re-chiffrer cet usage',
      rotateConfirm:
        'La tâche ENCRYPTION_KEY_ROTATION s’exécute immédiatement (même verrou et même historique que les tâches planifiées). Elle re-chiffre par lots les valeurs scellées avec une ancienne clé et peut être relancée sans risque.',
      lastResult: 'Résultat',
      error: 'Erreur',
      unreadableTitle: 'Valeurs illisibles',
      unreadableAlert:
        'Des valeurs sont scellées avec une clé absente de ENCRYPTION_KEYRING : elles ne peuvent être ni lues ni re-chiffrées. Réintroduisez cette clé (en déchiffrement seul, après la clé active) avant de poursuivre.',
      procedureTitle: 'Ajouter une clé puis faire tourner',
      procedureIntro:
        'La première entrée d’un usage dans ENCRYPTION_KEYRING est sa clé active ; les entrées suivantes ne servent plus qu’au déchiffrement. Format : usage:identifiant:clé-hex-64.',
      procedure: {
        step1:
          'Générer une clé de 32 octets (par exemple openssl rand -hex 32) et la conserver dans le coffre de secrets.',
        step2:
          'L’ajouter en tête des entrées de l’usage dans ENCRYPTION_KEYRING (par exemple documents:d2:<hex>,documents:d1:<hex>) sans retirer l’ancienne clé.',
        step3: 'Redéployer toutes les instances de l’API avec le nouveau trousseau.',
        step4:
          'Lancer la rotation ici (ou laisser la tâche planifiée avancer par lots) jusqu’à ce que « À re-chiffrer » atteigne 0 pour l’usage.',
        step5:
          'Retirer l’ancienne clé du trousseau seulement après l’expiration des sauvegardes qui contiennent encore des valeurs scellées avec elle.',
      },
      procedureDoc: 'Procédure détaillée : docs/operations/KEY_ROTATION.md',
      scheduler: 'La tâche planifiée poursuit la rotation par lots toutes les {minutes} min.',
      schedulerOff:
        'Planificateur désactivé : lancez la rotation manuellement jusqu’à ce que tout soit à jour.',
      purposeColumn: 'Usage',
      keyId: 'Identifiant de clé',
      state: 'État',
      count: 'Valeurs',
      activeKey: 'Clé active',
      sources: 'Sources',
      batch: 'Lot par exécution',
      states: {
        active: 'Active',
        decryptOnly: 'Déchiffrement seul',
        legacy: 'Clé historique',
        missing: 'Absente du trousseau',
      },
      purposes: {
        documents: 'Documents',
        mfa: 'Secrets MFA (TOTP)',
        webhooks: 'Secrets de signature des webhooks',
        beneficiaries: 'Identifiants de bénéficiaires',
      },
      purposeDescriptions: {
        documents:
          'Pièces téléversées : chaque blob est re-scellé via une copie temporaire vérifiée (SHA-256) avant de remplacer l’original.',
        mfa: 'Secrets TOTP des utilisateurs ayant configuré la double authentification.',
        webhooks: 'Secrets HMAC utilisés pour signer les livraisons de webhooks sortants.',
        beneficiaries:
          'Numéros de compte et de mobile money des bénéficiaires (seule une forme masquée est affichée).',
      },
      lastRun: 'Dernière rotation',
      never: 'Aucune rotation exécutée pour le moment.',
      triggeredBy: 'Déclenchée par',
      scanned: 'Examinées',
      rotated: 'Re-chiffrées',
      failed: 'Échecs',
      remaining: 'Restantes',
      repaired: 'Réparées',
      allPurposes: 'Tous les usages',
    },
  },
  {
    keysAdmin: {
      title: 'Encryption keys & storage',
      subtitle: 'Key ring per purpose, sealed values per key and rotation — sandbox simulated data.',
      noSecret: 'No key is ever displayed: only key ids and counts are.',
      values: 'Sealed values',
      valuesHint: 'MFA secrets, webhook secrets, beneficiary identifiers and documents',
      pending: 'To re-encrypt',
      pendingHint: 'values sealed with a key other than the active one',
      unreadable: 'Unreadable',
      unreadableHint: 'values sealed with a key missing from the key ring',
      storage: 'Document storage',
      storageHint: 'active driver (STORAGE_DRIVER) — blobs are always sealed before upload',
      drivers: {
        local: 'Local disk',
        s3: 'S3-compatible object storage',
      },
      documentsOn: 'document(s) on',
      upToDate: 'Everything is sealed with the active keys: no rotation needed.',
      upToDateShort: 'Up to date',
      rotate: 'Run the rotation',
      rotatePurpose: 'Re-encrypt this purpose',
      rotateConfirm:
        'The ENCRYPTION_KEY_ROTATION job runs immediately (same lock and history as scheduled jobs). It re-encrypts, in batches, the values sealed with an older key and can safely be run again.',
      lastResult: 'Result',
      error: 'Error',
      unreadableTitle: 'Unreadable values',
      unreadableAlert:
        'Some values are sealed with a key missing from ENCRYPTION_KEYRING: they can be neither read nor re-encrypted. Put that key back (decrypt-only, after the active key) before going further.',
      procedureTitle: 'Add a key, then rotate',
      procedureIntro:
        'The first entry of a purpose in ENCRYPTION_KEYRING is its active key; later entries are only used to decrypt. Format: purpose:keyId:hex-key-64.',
      procedure: {
        step1: 'Generate a 32-byte key (for example openssl rand -hex 32) and keep it in the secrets vault.',
        step2:
          'Prepend it to the purpose’s entries in ENCRYPTION_KEYRING (for example documents:d2:<hex>,documents:d1:<hex>) without removing the old key.',
        step3: 'Redeploy every API instance with the new key ring.',
        step4:
          'Run the rotation here (or let the scheduled job progress in batches) until “To re-encrypt” reaches 0 for the purpose.',
        step5: 'Remove the old key only once the backups that still hold values sealed with it have expired.',
      },
      procedureDoc: 'Full procedure: docs/operations/KEY_ROTATION.md',
      scheduler: 'The scheduled job keeps rotating in batches every {minutes} min.',
      schedulerOff: 'Scheduler disabled: run the rotation manually until everything is up to date.',
      purposeColumn: 'Purpose',
      keyId: 'Key id',
      state: 'State',
      count: 'Values',
      activeKey: 'Active key',
      sources: 'Sources',
      batch: 'Batch per run',
      states: {
        active: 'Active',
        decryptOnly: 'Decrypt only',
        legacy: 'Legacy key',
        missing: 'Missing from the key ring',
      },
      purposes: {
        documents: 'Documents',
        mfa: 'MFA secrets (TOTP)',
        webhooks: 'Webhook signing secrets',
        beneficiaries: 'Beneficiary identifiers',
      },
      purposeDescriptions: {
        documents:
          'Uploaded files: each blob is re-sealed through a verified temporary copy (SHA-256) before it replaces the original.',
        mfa: 'TOTP secrets of users who set up two-factor authentication.',
        webhooks: 'HMAC secrets used to sign outgoing webhook deliveries.',
        beneficiaries:
          'Bank and mobile money account numbers of beneficiaries (only a masked form is ever shown).',
      },
      lastRun: 'Last rotation',
      never: 'No rotation has run yet.',
      triggeredBy: 'Triggered by',
      scanned: 'Scanned',
      rotated: 'Re-encrypted',
      failed: 'Failed',
      remaining: 'Remaining',
      repaired: 'Repaired',
      allPurposes: 'All purposes',
    },
  },
);
