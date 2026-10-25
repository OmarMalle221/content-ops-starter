import { definePart } from './define';

/**
 * Phase 6–7 — key ring & storage, KMS-managed keys (envelope encryption). Only the `keysAdmin` namespace
 * lives here; FR defines the shape, EN mirrors it.
 */
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
        'Des valeurs sont scellées avec une clé absente du trousseau (entrée retirée de ENCRYPTION_KEYRING, clé historique désactivée, ou clé gérée non chargée par cette instance) : elles ne peuvent être ni lues ni re-chiffrées. Réintroduisez cette clé (en déchiffrement seul, après la clé active), réactivez ENCRYPTION_LEGACY_DECRYPT ou rétablissez l’accès au KMS avant de poursuivre.',
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
      kms: {
        title: 'Chiffrement d’enveloppe (KMS)',
        description:
          'Les clés de données gérées sont générées par l’API, chiffrées (« enveloppées ») par la clé maîtresse du KMS et stockées enveloppées en base ; chaque instance les déchiffre au démarrage puis les recharge périodiquement.',
        provider: 'Fournisseur',
        providers: {
          none: 'Aucun',
          local: 'KMS local simulé (bac à sable)',
          aws: 'AWS KMS',
        },
        providerNotes: {
          none: 'KMS_PROVIDER=none : aucune clé gérée, seules les clés de ENCRYPTION_KEYRING (et la clé historique) sont utilisées. Configurez KMS_PROVIDER=local ou aws pour générer des clés ici.',
          local:
            'KMS simulé du bac à sable : la clé maîtresse vit dans l’environnement (KMS_LOCAL_MASTER_KEY). Elle sépare les clés enveloppées (base, sauvegardes) de la clé qui les ouvre, mais ce n’est ni un HSM ni un KMS managé.',
          aws: 'AWS KMS : enveloppement par Encrypt / Decrypt sur KMS_KEY_ID, avec le contexte de chiffrement { purpose, keyId } ; identifiants issus de la chaîne AWS par défaut.',
        },
        keyRef: 'Référence de la clé maîtresse',
        activationDelay: 'Délai d’activation',
        refresh: 'Rechargement des clés',
        rotationInterval: 'Rotation planifiée',
        rotationManual: 'manuelle uniquement (KEY_ROTATION_INTERVAL_DAYS=0)',
        rotationEvery: 'tous les {days} jours',
        seconds: '{n} s',
        lastRefresh: 'Dernier rechargement (cette instance)',
        never: 'jamais',
        loadFailuresTitle: 'Clés gérées non chargées',
        loadFailures:
          'Cette instance n’a pas pu déchiffrer ces clés auprès du KMS : les valeurs scellées avec elles y sont illisibles. Les clés déjà chargées restent utilisées. Vérifiez la disponibilité et les droits du KMS.',
        refreshErrorTitle: 'Rechargement impossible',
        refreshError:
          'Le dernier rechargement des clés gérées a échoué (base de données indisponible) : cette instance continue avec les clés déjà chargées.',
        procedureTitle: 'Faire tourner une clé gérée',
        procedure: {
          step1:
            'Générer une nouvelle clé pour l’usage : elle est créée « En attente », enveloppée par le KMS, et chaque instance la charge en déchiffrement seul.',
          step2:
            'Après le délai d’activation, la tâche KEY_LIFECYCLE l’active (l’ancienne passe en déchiffrement seul) puis lance la rotation ENCRYPTION_KEY_ROTATION.',
          step3: 'Laisser la rotation progresser jusqu’à ce que « À re-chiffrer » atteigne 0 pour l’usage.',
          step4:
            'Retirer l’ancienne clé quand plus rien ne l’utilise (valeurs, documents, y compris les blobs de documents supprimés encore conservés). La clé enveloppée reste en base pour les restaurations : conservez la clé maîtresse du KMS tant que des sauvegardes en dépendent.',
        },
      },
      managed: {
        title: 'Clés gérées par le KMS',
        empty: 'Aucune clé gérée pour cet usage.',
        keyId: 'Clé',
        status: 'Statut',
        dates: 'Cycle de vie',
        kms: 'KMS',
        values: 'Valeurs',
        action: 'Action',
        loaded: 'chargée sur cette instance',
        notLoaded: 'non chargée sur cette instance',
        created: 'Créée',
        scheduled: 'par la rotation planifiée',
        activateAfter: 'Activable après',
        activated: 'Activée',
        deactivated: 'Désactivée',
        retired: 'Retirée',
        deletedBlobs: 'dont {n} blob(s) de document(s) supprimé(s) conservé(s)',
        statuses: {
          STAGED: 'En attente',
          ACTIVE: 'Active',
          DECRYPT_ONLY: 'Déchiffrement seul',
          RETIRED: 'Retirée',
        },
      },
      lifecycle: {
        generate: 'Générer une nouvelle clé',
        generateConfirm:
          'Une clé de données aléatoire est générée et enveloppée par le KMS. Elle reste en attente pendant le délai d’activation (le temps que chaque instance la charge), puis la tâche KEY_LIFECYCLE l’active et re-chiffre les valeurs existantes.',
        retire: 'Retirer',
        retireConfirm:
          'La clé ne sera plus chargée par les instances. Le retrait n’est accepté que si plus aucune valeur ni aucun document ne l’utilise.',
        mfaHint:
          'Code de votre application d’authentification ou code de secours — requis si la double authentification ou une clé d’accès est active sur votre compte.',
        blockers: {
          NOT_DECRYPT_ONLY: 'Seule une clé en déchiffrement seul peut être retirée.',
          RECENTLY_DEACTIVATED:
            'Retrait possible après le {date} (chaque instance doit d’abord cesser de l’utiliser).',
          KEY_IN_USE:
            'Encore utilisée : {values} valeur(s) scellée(s) avec elle, {pending} autre(s) document(s) à re-chiffrer.',
        },
        errors: {
          STAGED_KEY_EXISTS: 'Une clé attend déjà son activation pour cet usage.',
          KMS_NOT_CONFIGURED: 'Aucun KMS configuré (KMS_PROVIDER=none) : les clés gérées sont indisponibles.',
          KEY_IN_USE:
            'Des valeurs ou des documents utilisent encore cette clé : terminez la rotation (et la purge) d’abord.',
          RECENTLY_DEACTIVATED: 'Clé désactivée trop récemment : réessayez dans quelques minutes.',
          NOT_DECRYPT_ONLY: 'Seule une clé en déchiffrement seul peut être retirée.',
          KEY_ID_COLLISION: 'Identifiant de clé déjà pris : réessayez.',
          KMS_UNAVAILABLE: 'Le KMS est indisponible ou a refusé l’opération. Aucune clé n’a été créée.',
          NOT_FOUND: 'Clé introuvable.',
        },
      },
      legacyKey: {
        title: 'Clé historique (DOCUMENT_ENCRYPTION_KEY)',
        description:
          'Valeurs scellées avant le trousseau de clés. Une fois qu’aucune n’en dépend et que chaque usage a une clé active, le déchiffrement historique peut être désactivé (ENCRYPTION_LEGACY_DECRYPT=false).',
        decryptEnabled: 'Déchiffrement historique actif',
        decryptDisabled: 'Déchiffrement historique désactivé',
        values: 'Valeurs encore scellées avec elle',
        deletedBlobs: 'dont blobs de documents supprimés conservés',
        safe: 'Plus rien n’en dépend : ENCRYPTION_LEGACY_DECRYPT=false peut être appliqué.',
        notSafe:
          'Encore nécessaire : re-chiffrez ces valeurs (et donnez une clé active à chaque usage) avant de la désactiver.',
        disabledWithValues:
          'Le déchiffrement historique est désactivé alors que des valeurs en dépendent encore : elles sont illisibles. Réactivez-le (ENCRYPTION_LEGACY_DECRYPT=true), faites tourner, puis désactivez-le de nouveau.',
        perPurpose: 'Clé historique : {n} valeur(s)',
      },
      recovery: {
        title: 'Codes de secours MFA',
        secretMfa:
          'Les nouveaux codes sont protégés par MFA_RECOVERY_SECRET : changer SESSION_SECRET ne les invalide plus.',
        secretSession:
          'Les codes sont protégés par SESSION_SECRET : le changer invalide tous les codes de secours. Définissez MFA_RECOVERY_SECRET pour les en séparer.',
        bound: 'Codes encore liés à SESSION_SECRET',
        boundHint:
          'codes non utilisés créés avant MFA_RECOVERY_SECRET : ils deviendront invalides si SESSION_SECRET change',
        orphaned: 'Codes créés sous un MFA_RECOVERY_SECRET absent',
        orphanedHint:
          'ces codes non utilisés sont refusés tant que le secret n’est pas rétabli : restaurer la valeur de MFA_RECOVERY_SECRET depuis le coffre de secrets — une nouvelle valeur masquerait l’alerte sans les rendre valides (ne pas demander aux utilisateurs de régénérer)',
      },
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
        'Some values are sealed with a key missing from the key ring (entry removed from ENCRYPTION_KEYRING, legacy key disabled, or managed key not loaded by this instance): they can be neither read nor re-encrypted. Put that key back (decrypt-only, after the active key), re-enable ENCRYPTION_LEGACY_DECRYPT or restore access to the KMS before going further.',
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
      kms: {
        title: 'Envelope encryption (KMS)',
        description:
          'Managed data keys are generated by the API, encrypted (“wrapped”) by the KMS master key and stored wrapped in the database; every instance unwraps them at startup and reloads them periodically.',
        provider: 'Provider',
        providers: {
          none: 'None',
          local: 'Simulated sandbox KMS',
          aws: 'AWS KMS',
        },
        providerNotes: {
          none: 'KMS_PROVIDER=none: no managed keys, only the ENCRYPTION_KEYRING keys (and the legacy key) are used. Set KMS_PROVIDER=local or aws to generate keys here.',
          local:
            'Simulated sandbox KMS: the master key lives in the environment (KMS_LOCAL_MASTER_KEY). It keeps the wrapped keys (database, backups) apart from the key that opens them, but it is neither an HSM nor a managed KMS.',
          aws: 'AWS KMS: wrapping with Encrypt / Decrypt on KMS_KEY_ID, with the encryption context { purpose, keyId }; credentials from the default AWS chain.',
        },
        keyRef: 'Master key reference',
        activationDelay: 'Activation delay',
        refresh: 'Key reload',
        rotationInterval: 'Scheduled rotation',
        rotationManual: 'manual only (KEY_ROTATION_INTERVAL_DAYS=0)',
        rotationEvery: 'every {days} days',
        seconds: '{n} s',
        lastRefresh: 'Last reload (this instance)',
        never: 'never',
        loadFailuresTitle: 'Managed keys not loaded',
        loadFailures:
          'This instance could not unwrap these keys with the KMS: values sealed with them are unreadable here. Keys already loaded stay in use. Check the KMS availability and permissions.',
        refreshErrorTitle: 'Reload failed',
        refreshError:
          'The last reload of the managed keys failed (database unavailable): this instance keeps going with the keys already loaded.',
        procedureTitle: 'Rotate a managed key',
        procedure: {
          step1:
            'Generate a new key for the purpose: it is created “Staged”, wrapped by the KMS, and every instance loads it decrypt-only.',
          step2:
            'After the activation delay, the KEY_LIFECYCLE job activates it (the previous one becomes decrypt-only) and starts the ENCRYPTION_KEY_ROTATION job.',
          step3: 'Let the rotation progress until “To re-encrypt” reaches 0 for the purpose.',
          step4:
            'Retire the old key once nothing uses it any more (values, documents, including blobs of deleted documents still retained). The wrapped key stays in the database for restores: keep the KMS master key as long as backups depend on it.',
        },
      },
      managed: {
        title: 'KMS-managed keys',
        empty: 'No managed key for this purpose.',
        keyId: 'Key',
        status: 'Status',
        dates: 'Lifecycle',
        kms: 'KMS',
        values: 'Values',
        action: 'Action',
        loaded: 'loaded on this instance',
        notLoaded: 'not loaded on this instance',
        created: 'Created',
        scheduled: 'by the scheduled rotation',
        activateAfter: 'Activatable after',
        activated: 'Activated',
        deactivated: 'Deactivated',
        retired: 'Retired',
        deletedBlobs: 'including {n} retained blob(s) of deleted document(s)',
        statuses: {
          STAGED: 'Staged',
          ACTIVE: 'Active',
          DECRYPT_ONLY: 'Decrypt only',
          RETIRED: 'Retired',
        },
      },
      lifecycle: {
        generate: 'Generate a new key',
        generateConfirm:
          'A random data key is generated and wrapped by the KMS. It stays staged for the activation delay (so that every instance loads it), then the KEY_LIFECYCLE job activates it and re-encrypts the existing values.',
        retire: 'Retire',
        retireConfirm:
          'Instances will no longer load the key. Retirement is only accepted once no value or document uses it any more.',
        mfaHint:
          'Code from your authenticator app or a recovery code — required when two-factor authentication or a passkey is active on your account.',
        blockers: {
          NOT_DECRYPT_ONLY: 'Only a decrypt-only key can be retired.',
          RECENTLY_DEACTIVATED: 'Can be retired after {date} (every instance must stop using it first).',
          KEY_IN_USE:
            'Still in use: {values} value(s) sealed with it, {pending} other document(s) to re-encrypt.',
        },
        errors: {
          STAGED_KEY_EXISTS: 'A key is already waiting for activation for this purpose.',
          KMS_NOT_CONFIGURED: 'No KMS configured (KMS_PROVIDER=none): managed keys are unavailable.',
          KEY_IN_USE: 'Values or documents still use this key: finish the rotation (and the purge) first.',
          RECENTLY_DEACTIVATED: 'Key deactivated too recently: try again in a few minutes.',
          NOT_DECRYPT_ONLY: 'Only a decrypt-only key can be retired.',
          KEY_ID_COLLISION: 'Key id already taken: try again.',
          KMS_UNAVAILABLE: 'The KMS is unavailable or refused the operation. No key was created.',
          NOT_FOUND: 'Key not found.',
        },
      },
      legacyKey: {
        title: 'Legacy key (DOCUMENT_ENCRYPTION_KEY)',
        description:
          'Values sealed before the key ring. Once none depends on it and every purpose has an active key, legacy decryption can be switched off (ENCRYPTION_LEGACY_DECRYPT=false).',
        decryptEnabled: 'Legacy decryption enabled',
        decryptDisabled: 'Legacy decryption disabled',
        values: 'Values still sealed with it',
        deletedBlobs: 'of which retained blobs of deleted documents',
        safe: 'Nothing depends on it any more: ENCRYPTION_LEGACY_DECRYPT=false can be applied.',
        notSafe:
          'Still needed: re-encrypt these values (and give every purpose an active key) before switching it off.',
        disabledWithValues:
          'Legacy decryption is disabled while values still depend on it: they are unreadable. Re-enable it (ENCRYPTION_LEGACY_DECRYPT=true), rotate, then disable it again.',
        perPurpose: 'Legacy key: {n} value(s)',
      },
      recovery: {
        title: 'MFA recovery codes',
        secretMfa:
          'New codes are protected by MFA_RECOVERY_SECRET: changing SESSION_SECRET no longer invalidates them.',
        secretSession:
          'Codes are protected by SESSION_SECRET: changing it invalidates every recovery code. Set MFA_RECOVERY_SECRET to separate them.',
        bound: 'Codes still bound to SESSION_SECRET',
        boundHint:
          'unused codes created before MFA_RECOVERY_SECRET: they become invalid if SESSION_SECRET changes',
        orphaned: 'Codes created under a missing MFA_RECOVERY_SECRET',
        orphanedHint:
          'these unused codes are rejected until the secret is restored: restore the value of MFA_RECOVERY_SECRET from the secrets vault — a new value would hide this alert without making them valid (do not ask users to regenerate)',
      },
    },
  },
);
