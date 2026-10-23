# Rotation des clés de chiffrement

> Environnement **sandbox** : les valeurs scellées concernent des données fictives. La procédure est néanmoins celle qui s'appliquera en production ; elle est décrite par l'[ADR-0010](../decisions/ADR-0010-stockage-objet-trousseau.md) (trousseau, rotation) et l'[ADR-0014](../decisions/ADR-0014-chiffrement-enveloppe-kms.md) (clés gérées par un KMS, retrait de la clé historique, `MFA_RECOVERY_SECRET`).

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

Depuis la phase 7, un usage peut aussi recevoir des **clés gérées par un KMS** (§ 4) : clés de données aléatoires, enveloppées par la clé maîtresse du KMS et stockées enveloppées dans la table `EncryptionKey`, d'identifiant `kms-AAAAMMJJ-xxxxxx` (le préfixe `kms-` est réservé et refusé dans `ENCRYPTION_KEYRING`). Une clé gérée **active** remplace la première entrée de `ENCRYPTION_KEYRING` pour son usage ; les entrées d'environnement restent alors utilisables en déchiffrement seul.

L'état du trousseau se lit dans la console **Admin → Clés et stockage** (`/admin/keys`, rôle `ADMIN`) ou par `GET /v1/admin/keys` : clé active, identifiants configurés et, pour chaque identifiant, le nombre de valeurs qu'il scelle ; « À re-chiffrer » (`pendingRotation`) et « Illisibles » (`unreadable`, valeurs scellées avec une clé absente du trousseau). Aucune clé n'est jamais affichée.

## 2. Quand faire tourner une clé

- périodiquement (au moins une fois par an, ou selon la politique de sécurité retenue avec le partenaire) ;
- immédiatement en cas de suspicion de compromission d'une clé, d'un poste d'exploitation ou d'une sauvegarde de la configuration ;
- au départ d'une personne ayant eu accès au coffre de secrets ;
- pour sortir de la clé historique `legacy` (première mise en place du trousseau).

## 3. Procédure — clés d'environnement (`ENCRYPTION_KEYRING`)

Avec un KMS configuré, préférer la procédure du § 4 (aucun redéploiement, aucune clé en clair dans la configuration).

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

## 4. Clés gérées par un KMS (chiffrement par enveloppe)

### 4.1 Configurer le KMS

**Bac à sable — KMS local** (simulé : la clé maîtresse vit dans l'environnement ; ce n'est ni un HSM ni un KMS managé, la console l'indique) :

```bash
KMS_PROVIDER=local
KMS_LOCAL_MASTER_KEY=$(openssl rand -hex 32)   # coffre de secrets, JAMAIS avec les sauvegardes de la base
```

**Production — AWS KMS** :

```bash
KMS_PROVIDER=aws
KMS_KEY_ID=arn:aws:kms:<région>:<compte>:key/<id>   # ou alias/<nom>
KMS_REGION=<région>
# KMS_ENDPOINT=https://…   # seulement pour un service compatible (ou un point d'accès VPC)
```

- clé KMS **symétrique** (`SYMMETRIC_DEFAULT`, usage `ENCRYPT_DECRYPT`), rotation automatique AWS activée (elle conserve l'identifiant : transparente pour l'API) ;
- identifiants par la chaîne AWS par défaut — rôle IAM de l'instance ou de la tâche, jamais de clé d'accès dans l'environnement si on peut l'éviter ;
- droits minimaux du rôle de l'API : `kms:Encrypt` et `kms:Decrypt` sur cette clé seulement, idéalement restreints par `kms:EncryptionContextKeys` = `purpose`, `keyId` ;
- les appels sont bornés (3 tentatives, 3 s de connexion, 10 s par requête) et journalisés par CloudTrail avec le contexte `{purpose, keyId}`.

Réglages communs : `KEY_ACTIVATION_DELAY_SECONDS` (300 par défaut) doit rester **supérieur** à `KEYRING_REFRESH_SECONDS` (60 par défaut) — un avertissement est journalisé sinon ; `KEY_ROTATION_INTERVAL_DAYS` (0 = rotation manuelle uniquement, voir § 4.4).

Au démarrage, chaque instance déchiffre toutes les clés gérées non retirées auprès du KMS. **Si une seule échoue (KMS injoignable, droits manquants, autre clé maîtresse, `KMS_PROVIDER=none` alors que des clés gérées existent), le démarrage échoue** avec la liste des clés concernées et leur raison (`UNREACHABLE`, `ACCESS_DENIED`, `MASTER_KEY_MISMATCH`, `KMS_NOT_CONFIGURED`…), sans message du fournisseur. Ensuite, chaque instance recharge les clés toutes les `KEYRING_REFRESH_SECONDS` ; seules les nouvelles clés sont demandées au KMS, si bien qu'une panne du KMS après le démarrage n'enlève aucune clé déjà chargée.

### 4.2 Faire tourner une clé gérée

1. **Générer** : console `/admin/keys` → carte de l'usage → **Générer une nouvelle clé**, ou `POST /v1/admin/keys/<usage>/generate` (session `ADMIN` ; si l'administrateur a une TOTP ou une clé d'accès, joindre `{"mfaCode": "…"}` ou `{"passkeyAssertion": …}` — l'assertion doit répondre à un défi demandé pour l'opération `keys.manage` et la ressource `<usage>`, sinon `403 STEP_UP_OPERATION_MISMATCH`). La clé est enveloppée, vérifiée par un aller-retour KMS **avant** la vérification du second facteur (une panne du KMS ne consomme aucun code), puis enregistrée **En attente** (`STAGED`) avec `activateAfter` = maintenant + `KEY_ACTIVATION_DELAY_SECONDS`. Chaque instance la charge en déchiffrement seul à son rechargement suivant. Une seule clé en attente par usage.
2. **Activer** : la tâche `KEY_LIFECYCLE` (planificateur toutes les `JOBS_INTERVAL_MINUTES`, ou console des tâches → **Exécuter maintenant**) active les clés échues : la nouvelle devient **Active**, l'ancienne **Déchiffrement seul** ; puis elle lance `ENCRYPTION_KEY_ROTATION` pour l'usage.
3. **Re-chiffrer** : laisser la rotation progresser par lots (§ 3, étape 4) jusqu'à « À re-chiffrer » = 0. Elle rescelle aussi les blobs des documents supprimés encore conservés (jusqu'à leur purge).
4. **Retirer** l'ancienne clé : bouton **Retirer** (proposé seulement quand c'est possible) ou `POST /v1/admin/keys/<usage>/<keyId>/retire` (même second facteur ; une assertion de clé d'accès doit avoir été demandée pour `keys.manage` et la ressource `<keyId>`, celle-là précisément). Refusé (`409 KEY_LIFECYCLE_CONFLICT`) tant que :
   - la clé a été désactivée il y a moins de deux périodes de rechargement (`RECENTLY_DEACTIVATED`, avec `retireAfter`) ;
   - des valeurs ou des blobs l'utilisent encore (`KEY_IN_USE`, avec `references.values`, `references.deletedBlobs` — blobs de documents supprimés non purgés — et, pour les documents, `references.pendingDocuments` : autres blobs pas encore re-chiffrés).
     Une clé retirée n'est plus chargée par aucune instance ; sa forme enveloppée reste en base pour les restaurations. **Conserver la clé maîtresse du KMS** (et `KMS_LOCAL_MASTER_KEY`) aussi longtemps que des sauvegardes contiennent des clés enveloppées sous elle.

Chaque étape est auditée : `keys.generated` (`trigger: manual | scheduled`), `keys.activated`, `keys.retired`, `keys.rotation_scheduled`, sans matériel de clé.

### 4.3 Passer des clés d'environnement aux clés gérées

Générer une clé gérée par usage (§ 4.2) ; à son activation, les entrées de `ENCRYPTION_KEYRING` de l'usage passent en déchiffrement seul et la rotation y fait migrer les valeurs. Quand l'ancienne clé d'environnement affiche 0 valeur et que les sauvegardes qui en dépendent ont expiré, retirer son entrée de `ENCRYPTION_KEYRING` et redéployer (§ 3, étape 6) — les clés d'environnement ne se retirent pas depuis la console.

### 4.4 Rotation planifiée

Avec `KEY_ROTATION_INTERVAL_DAYS=N` (> 0), `KEY_LIFECYCLE` met en attente une nouvelle clé pour tout usage dont la clé gérée **active** a été activée il y a plus de N jours (audit `keys.rotation_scheduled`), puis l'active à l'échéance du délai et lance la rotation. Elle ne concerne que les usages déjà passés aux clés gérées : la première clé d'un usage se génère toujours à la main. Le retrait de l'ancienne clé reste une décision d'administrateur.

### 4.5 Plusieurs instances

Le délai d'activation garantit qu'aucune valeur n'est scellée avec une clé qu'une autre instance ne connaît pas encore. Après une activation, une instance pas encore rechargée scelle encore quelques secondes avec l'ancienne clé (toujours chargée partout) : la rotation suivante les rattrape et le retrait attend deux périodes de rechargement. Surveiller dans les journaux `managed keys refresh: … could not be loaded` (erreur) : une instance qui ne peut pas charger une nouvelle clé ne pourra pas lire ce qu'elle scelle ; la console affiche ces échecs pour l'instance qui répond.

### 4.6 Changer de clé maîtresse

- **AWS** : utiliser la rotation automatique de la clé KMS (même identifiant, transparente pour l'API). `Decrypt` est épinglé sur `KMS_KEY_ID` (un chiffré produit sous une autre clé est refusé) : remplacer `KMS_KEY_ID` par une **autre** clé rend les clés de données existantes illisibles et le démarrage échoue avec la raison `MASTER_KEY_MISMATCH` (`IncorrectKeyException` de KMS ; `INVALID_CIPHERTEXT` signale au contraire un chiffré altéré ou un contexte de chiffrement différent). Passer d'un alias à l'ARN de la **même** clé est sans effet. Un changement de clé maîtresse exigerait un ré-enveloppement, non automatisé à ce stade.
- **Local** : changer `KMS_LOCAL_MASTER_KEY` rend les clés existantes illisibles (le démarrage échoue avec `MASTER_KEY_MISMATCH`) ; il n'y a pas de ré-enveloppement automatique. En bac à sable, repartir de clés d'environnement ou d'une base vierge.

## 5. Retirer la clé historique (`ENCRYPTION_LEGACY_DECRYPT=false`)

Liste de contrôle :

1. chaque usage a une clé active autre que `legacy` (gérée ou dans `ENCRYPTION_KEYRING`) ;
2. la rotation est terminée : la carte **Clé historique** de `/admin/keys` (ou `legacy` dans `GET /v1/admin/keys`) affiche **0 valeur**, y compris les blobs de documents supprimés encore conservés, et `legacy.safeToDisable = true` ;
3. les sauvegardes antérieures qui contiennent encore des valeurs historiques ont expiré (sinon une restauration exigerait de réactiver le déchiffrement historique) ;
4. définir `ENCRYPTION_LEGACY_DECRYPT=false` et redéployer : le trousseau refuse alors les valeurs au format historique et ne scelle plus rien avec `DOCUMENT_ENCRYPTION_KEY`.

Si des valeurs historiques subsistent malgré tout, le démarrage **n'échoue pas** : il journalise un avertissement (`ENCRYPTION_LEGACY_DECRYPT=false but legacy-sealed values remain …`), ces valeurs sont illisibles (rotation : `KEY_NOT_FOUND` ; téléchargement : `503 KEY_NOT_FOUND`) et la console les signale. Réactiver (`true`), faire tourner, puis recommencer. Un usage sans clé active refuse de sceller de nouvelles valeurs (avertissement au démarrage). `DOCUMENT_ENCRYPTION_KEY` reste exigée au démarrage : une fois le retrait confirmé, elle peut être remplacée par une valeur aléatoire.

## 6. Codes de secours MFA : `MFA_RECOVERY_SECRET`

Sans ce secret, les empreintes des codes de secours sont des HMAC sous `SESSION_SECRET` : faire tourner `SESSION_SECRET` (après une fuite de cookies, par exemple) invalide **tous** les codes de secours. Avec `MFA_RECOVERY_SECRET` (32 caractères au moins, `openssl rand -hex 32`, dans le coffre de secrets) :

- les nouveaux codes sont stockés sous la forme `r2:` + HMAC(`MFA_RECOVERY_SECRET`) ; les codes déjà émis restent valides (vérification sous les deux secrets, le dédié d'abord) ;
- changer `SESSION_SECRET` n'invalide plus que les codes créés **avant** `MFA_RECOVERY_SECRET` ; la carte **Codes de secours MFA** de `/admin/keys` (`recoveryCodes.sessionSecretBound`) indique combien de codes non utilisés en dépendent encore — inviter leurs titulaires à régénérer leurs codes avant de faire tourner `SESSION_SECRET` ;
- `MFA_RECOVERY_SECRET` doit rester stable : le changer invalide les codes créés sous lui (les utilisateurs les régénèrent depuis leurs paramètres).

## 7. Incidents

| Symptôme                                                         | Cause probable et action                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors.KEY_NOT_FOUND`, « Illisibles » > 0                       | Une clé a été retirée trop tôt ou mal recopiée. La réintroduire (après la clé active, en déchiffrement seul), redéployer, relancer.                                                                                                                                                                                                                                                                                                                                                           |
| `errors.DECRYPT_FAILED`                                          | Valeur corrompue ou clé erronée sous le bon identifiant. Ne pas retirer d'ancienne clé ; examiner la ligne concernée (audit) et la restaurer depuis une sauvegarde si nécessaire.                                                                                                                                                                                                                                                                                                             |
| `errors.SHA256_MISMATCH` / `ROTATION_VERIFY_FAILED`              | Le contenu du blob ne correspond pas à l'empreinte enregistrée : incident d'intégrité. L'événement `document.integrity_failed` est dans l'audit ; restaurer le blob depuis une sauvegarde.                                                                                                                                                                                                                                                                                                    |
| `errors.STORAGE_*` (`UNREACHABLE`, `ACCESS_DENIED`…)             | Stockage indisponible ou mal configuré. Vérifier le journal de démarrage (`storage driver=… UNAVAILABLE (…)`), les identifiants S3 et le bucket ; la tâche reprendra au passage suivant.                                                                                                                                                                                                                                                                                                      |
| `409 JOB_ALREADY_RUNNING`                                        | Une exécution est déjà en cours (planificateur ou autre instance). Attendre sa fin et consulter l'historique.                                                                                                                                                                                                                                                                                                                                                                                 |
| Téléchargement en `503 KEY_NOT_FOUND`                            | Le document est scellé avec une clé absente du trousseau : même action que la première ligne.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Démarrage refusé : `KMS: … managed data key(s) cannot be loaded` | Le KMS est injoignable, refuse l'accès, ou la configuration ne correspond plus aux clés enregistrées : `MASTER_KEY_MISMATCH` (autre `KMS_LOCAL_MASTER_KEY`, ou `KMS_KEY_ID` pointant une autre clé — `IncorrectKeyException` côté AWS), `KMS_NOT_CONFIGURED` (`KMS_PROVIDER=none`) ; `INVALID_CIPHERTEXT` désigne un chiffré altéré. Rétablir le KMS ou la configuration (`KMS_PROVIDER`, `KMS_LOCAL_MASTER_KEY`, `KMS_KEY_ID`, droits IAM) ; ne jamais supprimer les lignes `EncryptionKey`. |
| `503 KMS_UNAVAILABLE` à la génération                            | Le KMS a échoué (raison dans `details.reason`) : rien n'a été enregistré et aucun code à usage unique n'a été consommé (l'aller-retour KMS précède le second facteur). Réessayer une fois le KMS rétabli.                                                                                                                                                                                                                                                                                     |
| `403 STEP_UP_OPERATION_MISMATCH` à la génération ou au retrait   | L'assertion de clé d'accès a été demandée pour une autre opération ou une autre ressource (générer : l'usage ; retirer : l'identifiant de clé). Refaire la confirmation depuis le bouton concerné ; le défi utilisé est consommé.                                                                                                                                                                                                                                                             |
| « Clés gérées non chargées » dans la console                     | Cette instance n'a pas pu déchiffrer une nouvelle clé auprès du KMS : elle ne pourra pas lire ce que d'autres instances scelleront avec elle une fois activée. Rétablir son accès au KMS avant `activateAfter`, ou la redémarrer : son démarrage échoue tant que le KMS lui reste inaccessible, ce qui la sort du service au lieu de la laisser répondre en erreur.                                                                                                                           |
| `409 KEY_LIFECYCLE_CONFLICT` au retrait                          | Lire `details.reason` et `details.references` : attendre `retireAfter`, terminer la rotation, ou laisser `DOCUMENT_PURGE` purger les blobs de documents supprimés.                                                                                                                                                                                                                                                                                                                            |

## 8. Changer de pilote de stockage

`STORAGE_DRIVER=s3` (avec `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`) n'affecte que les **nouveaux** documents : chaque document est lu depuis le pilote enregistré sur sa ligne (`Document.storageDriver`), si bien que les documents existants restent servis depuis le disque local tant que `STORAGE_DIR` est monté. Les anciens blobs se déplacent avec la tâche `STORAGE_MIGRATION` (ADR-0015, procédure dans [`RUNBOOK.md`](RUNBOOK.md) §11) : vérification de chaque blob, copie relue et comparée par condensé, bascule de la ligne par comparaison-échange, puis suppression de la copie locale ; elle coexiste avec la rotation et la purge. **Ne pas** copier les blobs à la main puis mettre à jour `storageDriver` en masse : un document re-scellé ou purgé entre la copie et la mise à jour pointerait vers un blob périmé. Les blobs sont toujours scellés par l'application avant l'envoi ; le chiffrement côté serveur du fournisseur peut être activé en complément mais n'est pas requis.
