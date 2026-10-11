# Rotation des clés de chiffrement

> Environnement **sandbox** : les valeurs scellées concernent des données fictives. La procédure est néanmoins celle qui s'appliquera en production ; elle est décrite par l'[ADR-0010](../decisions/ADR-0010-stockage-objet-trousseau.md).

## 1. Ce qui est chiffré, et avec quoi

| Usage (`purpose`) | Valeurs scellées                                   | Emplacement                                                                     |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `documents`       | Contenu des documents téléversés                   | Blobs du stockage (`STORAGE_DRIVER`), clé notée dans `Document.encryptionKeyId` |
| `mfa`             | Secrets TOTP                                       | `User.mfaSecretEnc`                                                             |
| `webhooks`        | Secrets de signature HMAC des webhooks             | `WebhookSubscription.secretEnc`                                                 |
| `beneficiaries`   | Numéros de compte / mobile money des bénéficiaires | `Beneficiary.accountIdentifierEnc`                                              |

Les clés sont déclarées dans `ENCRYPTION_KEYRING`, liste d'entrées `usage:identifiant:clé` séparées par des virgules :

```
ENCRYPTION_KEYRING=documents:d2:<hex64>,documents:d1:<hex64>,mfa:m1:<hex64>,webhooks:w1:<hex64>,beneficiaries:b1:<hex64>
```

- la **première** entrée d'un usage est sa **clé active** (toutes les nouvelles valeurs sont scellées avec elle) ;
- les entrées suivantes du même usage ne servent **qu'au déchiffrement** ;
- un usage sans entrée utilise `DOCUMENT_ENCRYPTION_KEY`, sous l'identifiant `legacy` (valeurs des phases 0 à 5) ;
- identifiant : 1 à 32 caractères `[A-Za-z0-9_-]`, jamais `legacy` ; clé : 32 octets en hexadécimal (64 caractères).

L'état du trousseau se lit dans la console **Admin → Clés et stockage** (`/admin/keys`, rôle `ADMIN`) ou par `GET /v1/admin/keys` : clé active, identifiants configurés et, pour chaque identifiant, le nombre de valeurs qu'il scelle ; « À re-chiffrer » (`pendingRotation`) et « Illisibles » (`unreadable`, valeurs scellées avec une clé absente du trousseau). Aucune clé n'est jamais affichée.

## 2. Quand faire tourner une clé

- périodiquement (au moins une fois par an, ou selon la politique de sécurité retenue avec le partenaire) ;
- immédiatement en cas de suspicion de compromission d'une clé, d'un poste d'exploitation ou d'une sauvegarde de la configuration ;
- au départ d'une personne ayant eu accès au coffre de secrets ;
- pour sortir de la clé historique `legacy` (première mise en place du trousseau).

## 3. Procédure

### Étape 1 — Générer la clé

```bash
openssl rand -hex 32
```

Choisir un identifiant explicite et unique pour l'usage (par exemple `d2026q4`). Conserver la clé dans le coffre de secrets (jamais dans le dépôt, un ticket ou une messagerie).

### Étape 2 — L'ajouter au trousseau

Ajouter l'entrée **en tête** des entrées de l'usage, **sans retirer** l'ancienne clé :

```
avant : documents:d1:<hex-d1>,mfa:m1:<hex-m1>,…
après : documents:d2026q4:<hex-nouvelle>,documents:d1:<hex-d1>,mfa:m1:<hex-m1>,…
```

> **Plusieurs instances de l'API** : procéder en deux déploiements. D'abord ajouter la nouvelle clé **après** la clé active (déchiffrement seul) et déployer toutes les instances ; ensuite seulement la placer en tête et redéployer. Sinon, pendant le déploiement progressif, une instance qui ne connaît pas encore la nouvelle clé ne pourrait pas lire les valeurs déjà rescellées par une autre. En instance unique (sandbox), un seul déploiement suffit.

### Étape 3 — Déployer

Redémarrer ou redéployer toutes les instances de l'API avec le nouveau `ENCRYPTION_KEYRING`. Une entrée mal formée empêche le démarrage (message explicite, sans la clé). Vérifier dans `/admin/keys` que la nouvelle clé apparaît comme **Active** et que les anciennes valeurs apparaissent « À re-chiffrer ».

### Étape 4 — Lancer la rotation

Au choix :

- console `/admin/keys` → **Lancer la rotation** (tous les usages) ou **Re-chiffrer cet usage** ;
- `POST /v1/admin/keys/rotate` avec `{}` ou `{"purpose": "documents"}` (session `ADMIN`) ;
- console des tâches `/admin/jobs` → `ENCRYPTION_KEY_ROTATION` → **Exécuter maintenant** (tous les usages) ;
- ne rien faire : le planificateur exécute la tâche toutes les `JOBS_INTERVAL_MINUTES` (si `JOBS_ENABLED=true`).

Chaque exécution passe par le moteur de tâches (verrou : une seule exécution à la fois ; historique `MaintenanceRun`) et traite un **lot borné** par usage : 200 valeurs pour `mfa`, `webhooks` et `beneficiaries`, 50 documents, avec un budget de 5 minutes. Relancer jusqu'à ce que `remaining` atteigne 0 ; la tâche reprend là où la précédente s'est arrêtée et une exécution sans travail ne modifie rien.

Le résumé de chaque exécution donne, par usage, `scanned` (examinées), `rotated` (rescellées), `failed` (échecs, avec leurs raisons dans `errors`) et `remaining` (restant à traiter). Il ne contient jamais de secret. Chaque exécution est journalisée dans l'audit (`keys.rotation_run`, et `admin.keys_rotate` pour une demande depuis la console).

Pour les documents, chaque blob est : lu et vérifié (authentification GCM + SHA-256 enregistré), rescellé, écrit sous une clé temporaire `rotation-tmp/<id>` relue et vérifiée, puis substitué à l'original (écriture atomique, relue) ; la nouvelle clé n'est enregistrée sur la ligne qu'ensuite. Si la substitution échoue, l'original est réécrit. Si le processus s'arrête entre la substitution et l'enregistrement, le document reste lisible (l'en-tête du blob désigne sa clé) et la ligne est réparée à la lecture suivante ou au passage suivant de la tâche (`document.key_id_repaired`).

### Étape 5 — Vérifier

- `/admin/keys` : « À re-chiffrer » = 0 et « Illisibles » = 0 pour l'usage ; l'ancienne clé affiche 0 valeur ;
- dernière exécution `COMPLETED`, `failed` = 0 (sinon voir § 4) ;
- contrôle fonctionnel : télécharger un document, valider un code TOTP, envoyer un webhook de test.

### Étape 6 — Retirer l'ancienne clé

Ne retirer l'entrée de l'ancienne clé de `ENCRYPTION_KEYRING` **qu'une fois expirées toutes les sauvegardes** (base de données et stockage objet) contenant encore des valeurs scellées avec elle : une restauration ultérieure en aurait besoin. Archiver la clé retirée dans le coffre avec sa date de fin d'usage jusqu'à l'expiration de la dernière sauvegarde concernée, puis la détruire.

Cas de la clé historique : `DOCUMENT_ENCRYPTION_KEY` reste obligatoire au démarrage. Lorsque **chaque** usage a une clé dans le trousseau et que la ligne `legacy` est à 0 partout (et que les sauvegardes antérieures ont expiré), elle peut être remplacée par une nouvelle valeur aléatoire : elle ne protège alors plus aucune donnée.

## 4. Incidents

| Symptôme                                             | Cause probable et action                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `errors.KEY_NOT_FOUND`, « Illisibles » > 0           | Une clé a été retirée trop tôt ou mal recopiée. La réintroduire (après la clé active, en déchiffrement seul), redéployer, relancer.                                                        |
| `errors.DECRYPT_FAILED`                              | Valeur corrompue ou clé erronée sous le bon identifiant. Ne pas retirer d'ancienne clé ; examiner la ligne concernée (audit) et la restaurer depuis une sauvegarde si nécessaire.          |
| `errors.SHA256_MISMATCH` / `ROTATION_VERIFY_FAILED`  | Le contenu du blob ne correspond pas à l'empreinte enregistrée : incident d'intégrité. L'événement `document.integrity_failed` est dans l'audit ; restaurer le blob depuis une sauvegarde. |
| `errors.STORAGE_*` (`UNREACHABLE`, `ACCESS_DENIED`…) | Stockage indisponible ou mal configuré. Vérifier le journal de démarrage (`storage driver=… UNAVAILABLE (…)`), les identifiants S3 et le bucket ; la tâche reprendra au passage suivant.   |
| `409 JOB_ALREADY_RUNNING`                            | Une exécution est déjà en cours (planificateur ou autre instance). Attendre sa fin et consulter l'historique.                                                                              |
| Téléchargement en `503 KEY_NOT_FOUND`                | Le document est scellé avec une clé absente du trousseau : même action que la première ligne.                                                                                              |

## 5. Changer de pilote de stockage

`STORAGE_DRIVER=s3` (avec `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`) n'affecte que les **nouveaux** documents : chaque document est lu depuis le pilote enregistré sur sa ligne (`Document.storageDriver`), si bien que les documents existants restent servis depuis le disque local tant que `STORAGE_DIR` est monté. La copie des anciens blobs vers le bucket n'est pas automatisée : la faire (blobs déjà chiffrés, à copier tels quels sous la même clé) puis mettre à jour `storageDriver` des lignes concernées. Les blobs sont toujours scellés par l'application avant l'envoi ; le chiffrement côté serveur du fournisseur peut être activé en complément mais n'est pas requis.
