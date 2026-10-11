# Runbook d'exploitation — sandbox Diaspora Financial Network

> **Sandbox uniquement.** `DFN_MODE=sandbox` est la seule valeur acceptée : aucune opération décrite ici ne déplace de fonds réels, n'appelle un partenaire réel ni ne présente une vérification d'identité, un taux de change ou un règlement simulés comme réels. Toutes les données sont fictives ; elles contiennent néanmoins des données personnelles de comptes de test et sont traitées comme sensibles. Choix techniques : [ADR-0013](../decisions/ADR-0013-build-compile-et-conteneurs.md) ; politique : [`SECURITY.md`](../../SECURITY.md) §11–12.

## 1. Vue d'ensemble

| Composant    | Image / source                                      | Rôle                                                                                      | Données persistantes                      |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| `postgres`   | `postgres:16-alpine`                                | Base de données (registre comptable, audit, métier)                                       | volume `pgdata`                           |
| `redis`      | `redis:7-alpine` (AOF, `noeviction`, mot de passe)  | Planificateur BullMQ, limites de débit partagées                                          | volume `redisdata` (non critique)         |
| `migrate`    | `dfn-api` (même image que l'API)                    | Tâche ponctuelle `prisma migrate deploy`, avant l'API                                     | —                                         |
| `api`        | `apps/api/Dockerfile` → `dfn-api`                   | API NestJS **compilée** (`dist/main.js`), uid 10001, système de fichiers en lecture seule | volume `storage` (`STORAGE_DRIVER=local`) |
| `web`        | `apps/web/Dockerfile` → `dfn-web`                   | Next.js `standalone`, proxy same-origin `/api/*` → API                                    | —                                         |
| `minio`      | profil `s3` uniquement                              | Stockage objet compatible S3 pour les documents                                           | volume `miniodata`                        |
| `minio-init` | profil `s3` uniquement                              | Création idempotente du bucket privé et d'un utilisateur API restreint à ce bucket        | —                                         |
| `seed`       | profil `seed` uniquement (étape `build` de l'image) | Données de démonstration fictives                                                         | —                                         |

Ordre de démarrage imposé par `docker-compose.yml` : `postgres` et `redis` sains → `migrate` terminé avec le code 0 → `api` saine (`GET /v1/health`) → `web`.

## 2. Check-list d'environnement

`docker-compose.yml` ne contient **aucun secret par défaut** : `docker compose` refuse de démarrer tant que les variables obligatoires ne sont pas définies dans `.env` (copie de `.env.example`, jamais versionnée).

| Variable                                 | Obligatoire      | Règle                                                                                                        |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                      | oui              | `openssl rand -hex 24` (hexadécimal : il est inséré tel quel dans l'URL de connexion)                        |
| `REDIS_PASSWORD`                         | oui              | `openssl rand -hex 24` (même raison)                                                                         |
| `SESSION_SECRET`                         | oui              | `openssl rand -hex 32`, unique par environnement ; le changer invalide sessions et codes de récupération MFA |
| `DOCUMENT_ENCRYPTION_KEY`                | oui              | `openssl rand -hex 32` ; à sauvegarder **hors** des sauvegardes de la base                                   |
| `ENCRYPTION_KEYRING`                     | recommandé       | trousseau versionné par usage, voir [`KEY_ROTATION.md`](KEY_ROTATION.md)                                     |
| `DFN_MODE`                               | imposé           | `sandbox` (forcé par la composition ; toute autre valeur empêche le démarrage)                               |
| `API_PUBLIC_URL`, `WEB_PUBLIC_URL`       | hors poste local | URL publiques réelles de la recette                                                                          |
| `CORS_ORIGINS`, `WEBAUTHN_ORIGINS`       | hors poste local | origine(s) exacte(s) du web ; la garde CSRF rejette toute autre origine                                      |
| `WEBAUTHN_RP_ID`                         | hors poste local | domaine du web (sans schéma ni port)                                                                         |
| `COOKIE_SECURE`                          | hors poste local | `true` derrière TLS                                                                                          |
| `STORAGE_DRIVER`                         | non (`local`)    | `s3` pour plusieurs hôtes ; alors `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`     |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | profil `s3`      | vérifiés au démarrage du conteneur (MinIO aurait sinon des identifiants par défaut connus)                   |
| `LOG_LEVEL`                              | non (`info`)     | `debug` interdit en recette partagée                                                                         |
| `SEED_DEMO_PASSWORD`                     | profil `seed`    | mot de passe des comptes de démonstration ; à changer avant toute recette partagée                           |

Les valeurs propres aux conteneurs sont fixées par la composition et l'emportent sur `.env` : `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `JOBS_DRIVER=bullmq`, `RATE_LIMIT_STORE=redis`, `STORAGE_DIR=/data/storage`, `API_PORT=4000`.

Avant toute recette partagée : secrets uniques et stockés dans un coffre, TLS en frontal, `COOKIE_SECURE=true`, origines exactes, comptes de démonstration supprimés ou mots de passe changés, sauvegardes planifiées **et** un exercice de restauration réussi (§6).

## 3. Déployer la sandbox

```bash
cd dfn
cp .env.example .env            # puis renseigner les variables du §2
docker compose config --quiet   # échoue si une variable obligatoire manque
docker compose up -d --build    # postgres, redis, migrate, api, web
docker compose ps -a            # migrate : Exited (0) ; api et web : healthy
bash infra/ops/smoke-api.sh --base-url http://127.0.0.1:4000   # santé, inscription, session, OpenAPI
```

- Web : `http://localhost:3000` (bandeau « Données fictives — Aucun fonds réel » sur chaque page) ; API : `http://localhost:4000/docs`.
- PostgreSQL et Redis ne sont publiés que sur `127.0.0.1`.
- Données de démonstration : `docker compose --profile seed run --rm seed`.
- Stockage objet : `docker compose --profile s3 up -d --build` avec `STORAGE_DRIVER=s3` et les variables `S3_*` / `MINIO_ROOT_*` dans `.env`. Le volume `storage` reste monté : les documents déjà écrits sur disque restent servis depuis leur pilote d'origine (`Document.storageDriver`).
- `API_INTERNAL_URL` du web est fixé **à la construction** de l'image (les réécritures `/api/*` de Next sont résolues au build) : reconstruire l'image `web` si l'adresse interne de l'API change.

### Nouvelle version

1. `git pull` puis `docker compose build` (les images ne contiennent aucun secret).
2. `docker compose up -d` : `migrate` applique les migrations en attente avant que l'API ne redémarre. Si une migration échoue, `docker compose up` s'interrompt sans démarrer l'API sur la nouvelle image : lire `docker compose logs migrate`, corriger, relancer.
3. Vérifier `docker compose ps -a`, le test de fumée et la console **Admin → Tâches** (`/admin/jobs`).

Les migrations sont **additives** (expand/contract) : une réplique de l'ancienne version doit continuer à fonctionner sur le schéma migré pendant le déploiement progressif. Ne jamais modifier une migration déjà appliquée.

### Mise à niveau d'une pile des phases 0 à 5

- **Mot de passe PostgreSQL** : `POSTGRES_PASSWORD` n'est appliqué qu'à l'initialisation du volume `pgdata`. Une pile existante garde l'ancien mot de passe (`dfn`) : soit le reporter tel quel dans `.env` le temps de la bascule, soit le changer d'abord (`docker compose exec postgres psql -U dfn -c "ALTER USER dfn PASSWORD '<nouveau>'"`) puis mettre `.env` à jour.
- **Volume `storage`** : l'API s'exécute désormais sous l'uid 10001, sans capacité. Rendre le volume existant inscriptible une fois : `docker run --rm -v dfn-sandbox_storage:/data alpine chown -R 10001:10001 /data`.
- **Redis** exige maintenant `REDIS_PASSWORD` ; aucune donnée Redis n'est à migrer.

### Arrêt

`docker compose stop` envoie `SIGTERM` : l'API cesse d'accepter des connexions, termine les requêtes en cours, arrête planificateur et workers puis ferme Redis et Prisma ; au-delà de 25 s elle s'arrête d'elle-même avec le code 1, et Docker tue le conteneur à 30 s (`stop_grace_period`). Un arrêt brutal reste sûr : les baux de tâches expirent (ADR-0011) et les écritures comptables sont transactionnelles.

## 4. Passer à plusieurs répliques

Une réplique unique peut tourner avec `JOBS_DRIVER=inprocess` et `RATE_LIMIT_STORE=memory`. **Dès la deuxième réplique, les trois réglages suivants sont obligatoires** :

| Réglage                  | Pourquoi                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `JOBS_DRIVER=bullmq`     | une seule exécution par échéance de chaque tâche de maintenance, baux en base (ADR-0011)            |
| `RATE_LIMIT_STORE=redis` | quotas et limites anti-abus cohérents quel que soit le nombre de répliques                          |
| `STORAGE_DRIVER=s3`      | un document téléversé sur une réplique doit être lisible par toutes (au-delà d'un seul hôte Docker) |

La composition fixe déjà les deux premiers. Sur un seul hôte, le volume nommé `storage` est partagé par les répliques ; sur plusieurs hôtes (ou orchestrateur), utiliser S3.

```bash
# retirer d'abord la publication du port 4000 de l'API (conflit entre répliques) ;
# le web joint les répliques par le nom de service http://api:4000
docker compose up -d --scale api=3
```

- `INSTANCE_ID` vaut par défaut `<hostname>-<pid>` (unique par conteneur) ; sous un orchestrateur, utiliser le nom du pod.
- `JOBS_INTERVAL_MINUTES` et `JOB_LEASE_SECONDS` identiques sur toutes les répliques ; `JOBS_ENABLED=false` sur une réplique dédiée au trafic.
- Redis : `noeviction` et AOF (déjà configurés) ; Redis n'est pas une source de vérité — sa perte n'entraîne aucune perte de données métier (les planifications sont recréées au démarrage).

## 5. Sauvegardes

### Objectifs

| Indicateur           | Cible (sandbox, `SECURITY.md` §12) | Moyen                                                                                                                                                    |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPO                  | 24 h                               | sauvegarde complète quotidienne (`infra/ops/backup.sh`) ; l'archivage WAL (PITR) du service PostgreSQL géré la réduit, recommandé avant toute phase live |
| RTO                  | 8 h                                | `infra/ops/restore.sh` + vérifications de `restore-test.sh` ; durée mesurée à chaque exercice                                                            |
| Rétention            | 30 jours                           | `BACKUP_RETENTION_DAYS=30`, et toujours les `BACKUP_KEEP_MIN` (7) plus récentes                                                                          |
| Test de restauration | trimestriel (et à chaque CI)       | `infra/ops/restore-test.sh` (§6)                                                                                                                         |

Ces cibles sont celles de la sandbox ; elles seront révisées avant toute phase live.

### Base de données — `infra/ops/backup.sh`

```bash
# depuis dfn/, avec un client PostgreSQL 16 (pg_dump / pg_restore)
DATABASE_URL='postgresql://dfn:…@127.0.0.1:5432/dfn' \
BACKUP_DIR=/srv/dfn/backups \
BACKUP_AGE_RECIPIENT=age1… \
  bash infra/ops/backup.sh            # ou : pnpm ops:backup
```

- `pg_dump --format=custom` horodaté en UTC : `dfn-<base>-<AAAAMMJJTHHMMSSZ>.dump`, plus un fichier `.sha256`. Écriture dans un fichier temporaire puis renommage : une sauvegarde interrompue ne laisse jamais d'archive partielle.
- **Chiffrement** : avec `BACKUP_AGE_RECIPIENT` (ou `BACKUP_AGE_RECIPIENTS_FILE`), l'archive est chiffrée par `age` (`.dump.age`) ; avec `BACKUP_GPG_RECIPIENT` (empreinte complète), par `gpg` (`.dump.gpg`). La clé privée de déchiffrement **ne doit jamais** être stockée avec les sauvegardes. Sans chiffrement, l'archive est vérifiée par `pg_restore --list` ; chiffrée, elle l'est si `BACKUP_AGE_IDENTITY_FILE` est fourni (sinon par l'exercice du §6).
- **Rétention** : suppression des sauvegardes de la même base plus anciennes que `BACKUP_RETENTION_DAYS` (30), en conservant toujours les `BACKUP_KEEP_MIN` (7) plus récentes ; `--no-prune` pour désactiver.
- Les identifiants de connexion sont passés par les variables `PG*` (jamais en argument de commande, jamais affichés) ; `umask 077` sur tous les fichiers produits.
- Planification (exemple cron, hôte d'exploitation) : `15 2 * * * cd /srv/dfn && BACKUP_DIR=/srv/dfn/backups bash infra/ops/backup.sh >> /var/log/dfn-backup.log 2>&1`, puis copie hors site (stockage objet avec verrouillage, autre région).
- Depuis la composition : `docker compose exec -T postgres pg_dump -U dfn -Fc dfn > dfn-$(date -u +%Y%m%dT%H%M%SZ).dump` dépanne, mais ne chiffre ni ne purge : préférer `backup.sh` avec `DATABASE_URL` pointant sur `127.0.0.1:5432`.

### Documents, clés, Redis

| Élément                                                                  | Procédure                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blobs `STORAGE_DRIVER=local`                                             | `docker compose exec -T api tar -C /data/storage -cf - . > storage-$(date -u +%Y%m%dT%H%M%SZ).tar` (les blobs sont déjà chiffrés AES-256-GCM par l'application). **Après** la sauvegarde de la base : un blob sans ligne est inoffensif, l'inverse non. |
| Blobs `STORAGE_DRIVER=s3`                                                | `mc mirror --overwrite <alias>/<bucket> <sauvegarde>/<bucket>-<date>` ou réplication du bucket chez le fournisseur, après la sauvegarde de la base.                                                                                                     |
| Clés (`ENCRYPTION_KEYRING`, `DOCUMENT_ENCRYPTION_KEY`, `SESSION_SECRET`) | dans le coffre de secrets, **séparément** des sauvegardes de la base et des blobs ; toute clé encore référencée (`/admin/keys`) doit rester restaurable.                                                                                                |
| Redis                                                                    | non critique (AOF activé) : files et planifications sont reconstruites au démarrage.                                                                                                                                                                    |

## 6. Exercice de restauration (trimestriel)

`infra/ops/restore-test.sh` enchaîne, sans jamais écrire dans la base source :

1. une sauvegarde par `backup.sh` (ou `--dump <fichier>` pour éprouver une sauvegarde existante, p. ex. celle de la nuit) ;
2. sa restauration par `restore.sh --create` dans une base **jetable** `dfn_restore_drill_<horodatage>` (somme de contrôle, déchiffrement, `pg_restore` en une seule transaction) ;
3. `prisma migrate status` : le schéma restauré est à jour avec les migrations du code ;
4. le comptage des lignes des tables clés (`_prisma_migrations`, `User`, `Organization`, `Transaction`, `Wallet`, `LedgerAccount`, `LedgerTransaction`, `LedgerEntry`, `BalanceSnapshot`, `Transfer`, `Invoice`, `Document`, `AuditLog`, `RiskAlert`, `RegulatoryGate`…), comparé à la source ;
5. `LedgerService.reconcile()` sur la base restaurée (`infra/ops/reconcile-ledger.ts`, compilé en `apps/api/dist/reconcile-ledger.js`) : **0 transaction déséquilibrée** et **débits globaux = crédits globaux pour chaque devise** ; les écarts de continuité d'instantané font aussi échouer l'exercice ;
6. la suppression de la base jetable (`--keep` pour l'inspecter), puis un rapport des durées (sauvegarde, restauration, vérifications).

```bash
cd dfn
pnpm build:api                                   # facultatif : utilise dist/reconcile-ledger.js, sinon ts-node
DATABASE_URL='postgresql://…/dfn?schema=public' bash infra/ops/restore-test.sh
# sauvegarde chiffrée existante :
BACKUP_AGE_IDENTITY_FILE=~/.config/dfn/backup.key \
  bash infra/ops/restore-test.sh --dump /srv/dfn/backups/dfn-dfn-20261011T021500Z.dump.age
```

| Option                | Usage                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--allow-count-drift` | source en cours d'écriture : les écarts de comptage sont signalés sans faire échouer l'exercice |
| `--allow-differences` | écarts de réconciliation signalés sans échec (jamais pour un exercice de conformité)            |
| `--scratch-db NOM`    | nom de la base jetable (`[a-z_][a-z0-9_]*`, différent de la base source)                        |

Critères de réussite : code de sortie 0 (« RESTORE DRILL PASSED ») et durée totale compatible avec le RTO. Consigner dans le registre d'exploitation : date, sauvegarde éprouvée, durées, comptages, résultat de la réconciliation, opérateur. La CI (`backup-restore`) exécute l'exercice à chaque modification, en clair puis chiffré par `age`. Référence locale : base de test ensemencée (5 transactions comptables, 12 écritures, CAD équilibré) — sauvegarde 0,2 s, restauration 0,6 s, vérifications 5 s.

## 7. Restaurer en situation réelle

1. **Geler** : `docker compose stop api web` (plus aucune écriture) ; prévenir les utilisateurs de la recette.
2. **Choisir** la sauvegarde (la plus récente valide, ou antérieure à l'incident) et, de préférence, l'éprouver d'abord : `restore-test.sh --dump <fichier>`.
3. **Restaurer** :
   ```bash
   RESTORE_DATABASE_URL='postgresql://dfn:…@127.0.0.1:5432/dfn' \
   BACKUP_AGE_IDENTITY_FILE=… bash infra/ops/restore.sh <fichier>
   ```
   Le script vérifie la somme de contrôle, demande de **saisir le nom de la base cible** (ou `--yes` en automatisation), puis supprime et recrée les objets (`--clean --if-exists`) en **une seule transaction** : en cas d'erreur, la base reste dans son état antérieur. `--create` restaure dans une nouvelle base ; `--jobs N` accélère les gros volumes mais n'est plus atomique.
4. **Restaurer les blobs** de la même date (après la base), et vérifier que les clés du trousseau couvrent les identifiants référencés (`/admin/keys`, colonne « Illisibles » à 0).
5. **Vérifier** : `docker compose run --rm migrate` (migrations à jour), puis `docker compose up -d api web`, test de fumée, et réconciliation : `docker compose exec api node dist/reconcile-ledger.js` ou `POST /v1/admin/ledger/reconcile` (console administrateur).
6. **Tracer** : l'incident et la restauration dans le registre d'exploitation ; les écritures postérieures à la sauvegarde sont perdues (RPO) — **ne jamais les recréer en modifiant le registre** : toute correction comptable passe par une écriture de contrepassation (ADR-0002).

## 8. Check-list d'incident

1. **Qualifier** : `docker compose ps -a`, `curl -s http://127.0.0.1:4000/v1/health` (`database: ok|error`), journaux (`docker compose logs --since 30m api`), console `/admin/jobs` (baux, dernières exécutions).
2. **Contenir** selon le cas :

| Situation                                                       | Action                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API en boucle de redémarrage                                    | `docker compose logs api` : configuration invalide (message `Invalid environment configuration`), migration non appliquée (`migrate` en erreur), base injoignable.                                                                                                   |
| Base indisponible                                               | `/v1/health` → `degraded` ; les tâches ne s'exécutent plus et reprennent seules. Restaurer le service PostgreSQL ; au besoin §7.                                                                                                                                     |
| Redis indisponible                                              | L'API continue de servir ; planifications BullMQ suspendues, limites de débit repliées en mémoire par réplique (ADR-0011). Rétablir Redis, rien à rejouer.                                                                                                           |
| Stockage objet indisponible                                     | `503 STORAGE_UNAVAILABLE` sur les documents ; journal de démarrage `storage driver=… UNAVAILABLE`. Vérifier bucket, identifiants, réseau ([`KEY_ROTATION.md`](KEY_ROTATION.md) §4).                                                                                  |
| Réconciliation avec écarts (`/admin` ou tâche `RECONCILIATION`) | Ne rien modifier dans le registre. Conserver le rapport (`ReconciliationJob`, `ReconciliationDifference`), suspendre les tâches (`JOBS_ENABLED=false`), analyser, corriger par contrepassation.                                                                      |
| Suspicion de compromission d'un secret ou d'une clé             | Rotation immédiate ([`KEY_ROTATION.md`](KEY_ROTATION.md)) ; changement de `SESSION_SECRET` : invalide toutes les sessions **et tous les codes de récupération MFA** (hachés avec ce secret), à faire régénérer par les utilisateurs ; revue de l'audit (`AuditLog`). |
| Comportement inattendu laissant croire à un mouvement réel      | Impossible par construction (ADR-0003) : vérifier `x-dfn-mode: sandbox` sur les réponses et les fabriques d'adaptateurs ; toute autre valeur est un incident de sécurité majeur.                                                                                     |

3. **Rétablir**, puis vérifier : santé, test de fumée, réconciliation, file des tâches.
4. **Tracer et apprendre** : chronologie, cause, actions ; revue post-incident sous cinq jours ouvrés ; mise à jour de ce runbook.

## 9. Journaux, métriques, points de contrôle

| Source                                   | Contenu                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journaux API (`docker compose logs api`) | JSON pino sur la sortie standard, un enregistrement par requête avec `req.id` (en-tête `X-Request-Id` repris s'il est fourni, renvoyé dans les erreurs `requestId`) ; secrets, cookies et en-têtes `authorization` masqués. Rotation `json-file` 10 Mo × 5. |
| Traces de pile                           | `node --enable-source-maps` : les piles de `dist/main.js` pointent vers les sources TypeScript (cartes `dist/*.js.map` incluses dans l'image).                                                                                                              |
| `GET /v1/health`                         | sonde de vie et de base de données (utilisée par les `HEALTHCHECK` Docker et la composition).                                                                                                                                                               |
| Console administrateur                   | `/admin/jobs` (pilote, baux, historique `MaintenanceRun` par instance), `/admin/keys` (trousseau, documents à re-chiffrer), `/admin/gates`, réconciliation du registre.                                                                                     |
| Base de données                          | `AuditLog` (actions sensibles), `MaintenanceRun`, `ReconciliationJob` / `ReconciliationDifference`, `ApiRequestLog`, `WebhookDelivery`.                                                                                                                     |
| Exercices de restauration                | sortie de `restore-test.sh` (durées, comptages, réconciliation) et artefacts de la CI.                                                                                                                                                                      |

Pas encore de point de collecte de métriques (Prometheus/OpenTelemetry) : les indicateurs se lisent dans les journaux et la console. À ajouter avant toute phase live (latences, taux d'erreur, profondeur des files, durée des tâches).

## 10. Commandes utiles

```bash
pnpm build:api                                   # build compilé (tsup) → apps/api/dist
pnpm --filter @dfn/api start:prod                # node --enable-source-maps dist/main.js
bash infra/ops/smoke-api.sh --boot               # démarre dist/main.js, teste, arrête par SIGTERM
pnpm ops:backup | pnpm ops:restore <fichier> | pnpm ops:restore-test
docker compose exec api node dist/reconcile-ledger.js --json   # réconciliation à la demande
docker compose run --rm migrate                  # migrations seules
docker build -f apps/api/Dockerfile -t dfn-api:local .        # images seules (contexte : dfn/)
docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t dfn-web:local .
```
