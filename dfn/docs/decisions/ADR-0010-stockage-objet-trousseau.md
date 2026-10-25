# ADR-0010 — Stockage objet chiffré (local ou S3-compatible) et rotation des clés par trousseau versionné

| Champ  | Valeur                                                                                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut | Accepté (complète et remplace la section « Abstraction » et la note de révision de l'ADR-0006)                                                                                                                                                              |
| Date   | 2026-10-11                                                                                                                                                                                                                                                  |
| Portée | `apps/api/src/common/storage/`, `apps/api/src/common/keyring.ts`, modules `documents` et `keys` de l'API, tâche `ENCRYPTION_KEY_ROTATION`, modèle `Document` (`storageDriver`, `encryptionKeyId`), variables `STORAGE_DRIVER`, `S3_*`, `ENCRYPTION_KEYRING` |

## Contexte

Jusqu'à la phase 5, les documents étaient écrits sur le disque local (`STORAGE_DIR`) et tous les secrets scellés (documents, secrets MFA, secrets de signature des webhooks, identifiants de bénéficiaires) l'étaient avec une seule clé, `DOCUMENT_ENCRYPTION_KEY`. Deux limites bloquaient la préparation partenaires :

1. **Stockage** : un disque local ne survit pas à plusieurs réplicas de l'API ni à un redéploiement sans volume persistant ; les partenaires et les auditeurs attendent un stockage objet (S3 ou équivalent souverain) avec intégrité vérifiable.
2. **Clés** : une clé unique pour quatre usages élargit l'impact d'une fuite, et l'absence de version dans le format interdisait toute rotation sans interruption (il fallait tout déchiffrer et rechiffrer « en une fois »).

La plateforme reste un bac à sable (ADR-0003) : aucun fournisseur de stockage n'est imposé et aucune donnée réelle n'est stockée, mais la conception doit être celle d'un service en production.

## Décision

1. **Interface `BlobStore`** (`put`, `get`, `delete`, `exists`, `healthCheck`) avec deux pilotes choisis par `STORAGE_DRIVER` :
   - `LocalBlobStore` : chemin `<STORAGE_DIR>/<clé>` (disposition historique conservée), écriture atomique (fichier temporaire créé en exclusif, mode `0600`, `fsync`, puis `rename`), refus des fichiers dépassant la taille maximale avant lecture ;
   - `S3BlobStore` (AWS SDK v3, tout service S3-compatible) : `PutObject` avec `Content-MD5` et `x-amz-checksum-sha256`, `GetObject` lu en flux sous plafond de taille (`MAX_UPLOAD_MB` + en-tête de scellement) et vérification du SHA-256 renvoyé, `DeleteObject` idempotent, `HeadObject` / `HeadBucket` ; point d'accès, région, identifiants et style de chemin viennent de l'environnement.
2. **Clés de stockage générées par le serveur** (`<organisation>/<uuid>`) et validées par `^[a-z0-9/-]+$` (sans `//`, sans `/` initial ou final, 512 caractères au plus) : aucune traversée de répertoire n'est possible, même par erreur de programmation.
3. **Chiffrement côté application, toujours** : les octets confiés à un pilote sont déjà scellés par le trousseau (AES-256-GCM). Le chiffrement côté serveur du fournisseur n'est ni requis ni pris en compte ; une fuite du bucket ou une ACL erronée n'expose que du chiffré.
4. **Trousseau versionné par usage** (`ENCRYPTION_KEYRING = usage:identifiant:hex64,…`, usages `documents`, `mfa`, `webhooks`, `beneficiaries`) : la première entrée d'un usage est la clé active, les suivantes servent au déchiffrement seul ; l'usage et l'identifiant de clé sont liés au chiffré comme données additionnelles GCM. Les valeurs antérieures restent lisibles sous l'identifiant `legacy` (`DOCUMENT_ENCRYPTION_KEY`).
5. **Chaque document enregistre son pilote et sa clé** (`Document.storageDriver`, `Document.encryptionKeyId`, `null` = disposition historique). Les lectures utilisent le pilote enregistré : basculer `STORAGE_DRIVER` de `local` à `s3` n'empêche pas de lire les anciens documents.
6. **Intégrité vérifiée à chaque lecture** : le blob doit s'authentifier (tag GCM) puis son SHA-256 en clair doit égaler `Document.sha256`. Sinon : événement d'audit `document.integrity_failed`, réponse `409` et contenu jamais servi. Une clé absente du trousseau donne `503 KEY_NOT_FOUND` (audit `document.key_unavailable`) ; toute panne du stockage donne `503 STORAGE_UNAVAILABLE` avec une raison (`NOT_FOUND`, `TOO_LARGE`, `CHECKSUM_MISMATCH`, `ACCESS_DENIED`, `MISCONFIGURED`, `UNREACHABLE`, `IO_ERROR`), jamais le message brut du fournisseur ni un identifiant.
7. **Rotation par une tâche de maintenance** `ENCRYPTION_KEY_ROTATION` (enregistrée par `KeysModule` sur le `JobRegistry`, exécutée par `MaintenanceService` : verrou, historique `MaintenanceRun`) : par lots bornés (200 valeurs par usage et par exécution, 50 documents, plafond d'examen et budget de temps), elle rescelle avec la clé active toute valeur scellée avec une autre clé. Chaînes : remplacement par comparaison-échange (une valeur modifiée entre-temps est laissée au passage suivant). Documents : lecture et vérification, scellement, écriture sous une clé temporaire relue et vérifiée, remplacement atomique de l'original puis relecture, enregistrement de la nouvelle clé ; en cas d'échec l'original est réécrit. Chaque exécution est auditée (`keys.rotation_run`), son résumé par usage `{scanned, rotated, failed, remaining}` ne contient aucun secret.
8. **Console administrateur** `/admin/keys` et API `GET /v1/admin/keys`, `POST /v1/admin/keys/rotate {purpose?}` réservées au rôle `ADMIN` (`Permission.ADMIN_KEYS`) : identifiants de clés et décomptes uniquement, jamais de matériel de clé.

## Conséquences

Positives : stockage multi-réplicas et compatible avec un hébergement souverain (MinIO, Ceph, fournisseurs africains ou canadiens) sans dépendre de leur chiffrement ; intégrité de bout en bout (transport par somme de contrôle, repos par GCM, contenu par SHA-256) ; rotation sans interruption, reprenable et idempotente ; une fuite de clé n'affecte qu'un usage ; le passage d'un pilote à l'autre se fait document par document.

Négatives : les documents sont déchiffrés en mémoire (taille bornée par `MAX_UPLOAD_MB`, 15 Mo par défaut) ; la rotation des documents relit et réécrit chaque blob (coût d'E/S et de requêtes S3) ; les clés vivent dans l'environnement et non dans un KMS/HSM ; la copie des documents d'un pilote vers l'autre n'est pas automatisée ; pendant un déploiement progressif, une réplica qui ne connaît pas encore la nouvelle clé ne peut pas lire les valeurs déjà rescellées — d'où la procédure en deux temps de `docs/operations/KEY_ROTATION.md`.

## Alternatives

| Alternative                                                                  | Raison du rejet                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chiffrement côté serveur du fournisseur seul (SSE-S3 / SSE-KMS)              | Dépend de la configuration de l'hébergeur ; un bucket mal configuré exposerait des pièces d'identité ; non portable vers tous les services compatibles |
| Enveloppe par document (clé de données chiffrée par une clé maîtresse KMS)   | Cible à terme ; prématuré sans KMS retenu ni partenaire ; le format versionné actuel permet d'y migrer par une rotation                                |
| URL pré-signées vers le bucket pour le téléchargement                        | Contournerait le contrôle d'accès, l'audit de chaque téléchargement et la vérification d'intégrité ; incompatible avec le chiffrement applicatif       |
| Rotation « big bang » hors ligne (tout déchiffrer et rechiffrer en une fois) | Interruption de service, aucune reprise après incident, risque de perte si le processus s'arrête au milieu                                             |
| Blobs en base (`bytea`)                                                      | Alourdit les sauvegardes transactionnelles ; aucun gain par rapport au stockage objet (voir ADR-0006)                                                  |

## Détails de mise en œuvre

| Élément                    | Choix                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format scellé (chaîne)     | `k2.<usage>.<identifiant>.<base64(iv ‖ tag ‖ chiffré)>` ; historique : base64 sans en-tête                                                                        |
| Format scellé (blob)       | `DFNK2` ‖ longueur de l'identifiant ‖ identifiant ‖ iv(12) ‖ tag(16) ‖ chiffré ; historique : iv ‖ tag ‖ chiffré                                                  |
| Reprise après incident     | L'en-tête du blob désigne sa clé : une ligne restée sur l'ancienne clé après remplacement du blob est lue normalement et réparée (`document.key_id_repaired`)     |
| Clé temporaire de rotation | `rotation-tmp/<id du document>` (déterministe : écrasée et supprimée au passage suivant si un incident l'a laissée)                                               |
| Tâche planifiée            | Exécutée par le planificateur toutes les `JOBS_INTERVAL_MINUTES` ; sans valeur à resceller, elle se limite à des comptages                                        |
| Contrôle de santé          | Au démarrage (hors tests) : sonde écriture/lecture/suppression en local, `HeadBucket` en S3 ; le journal indique pilote et emplacement, jamais les identifiants   |
| Tests                      | `apps/api/test/storage.test.ts`, `keys.test.ts`, `s3-store.test.ts` (client S3 simulé ; suite réelle activée par `S3_TEST_ENDPOINT`, sinon explicitement ignorée) |

## Révision

Revoir cette décision au choix d'un KMS ou d'un HSM (chiffrement par enveloppe), à la signature du premier partenaire imposant une localisation des données, ou si la taille maximale des documents doit dépasser ce que le déchiffrement en mémoire permet (passage au chiffrement par segments en flux).
