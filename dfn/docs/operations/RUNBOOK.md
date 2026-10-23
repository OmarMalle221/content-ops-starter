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

| Variable                                                                                | Obligatoire            | Règle                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`                                                                     | oui                    | `openssl rand -hex 24` (hexadécimal : il est inséré tel quel dans l'URL de connexion)                                                                                                                                                                                                                           |
| `POSTGRES_APP_PASSWORD`                                                                 | oui                    | `openssl rand -hex 24` ; rôle `dfn_app` (`POSTGRES_APP_USER`) de l'API : lecture/écriture des données, aucun droit DDL ni superutilisateur. Les migrations et le seed gardent `POSTGRES_USER`                                                                                                                   |
| `REDIS_PASSWORD`                                                                        | oui                    | `openssl rand -hex 24` (même raison)                                                                                                                                                                                                                                                                            |
| `SESSION_SECRET`                                                                        | oui                    | `openssl rand -hex 32`, unique par environnement ; le changer invalide sessions et codes de récupération MFA                                                                                                                                                                                                    |
| `DOCUMENT_ENCRYPTION_KEY`                                                               | oui                    | `openssl rand -hex 32` ; à sauvegarder **hors** des sauvegardes de la base                                                                                                                                                                                                                                      |
| `ENCRYPTION_KEYRING`                                                                    | recommandé             | trousseau versionné par usage, voir [`KEY_ROTATION.md`](KEY_ROTATION.md)                                                                                                                                                                                                                                        |
| `DFN_MODE`                                                                              | imposé                 | `sandbox` (forcé par la composition ; toute autre valeur empêche le démarrage)                                                                                                                                                                                                                                  |
| `API_PUBLIC_URL`, `WEB_PUBLIC_URL`                                                      | hors poste local       | URL publiques réelles de la recette                                                                                                                                                                                                                                                                             |
| `CORS_ORIGINS`, `WEBAUTHN_ORIGINS`                                                      | hors poste local       | origine(s) exacte(s) du web ; la garde CSRF rejette toute autre origine                                                                                                                                                                                                                                         |
| `WEBAUTHN_RP_ID`                                                                        | hors poste local       | domaine du web (sans schéma ni port)                                                                                                                                                                                                                                                                            |
| `COOKIE_SECURE`                                                                         | hors poste local       | `true` derrière TLS                                                                                                                                                                                                                                                                                             |
| `TRUST_PROXY`                                                                           | non                    | pairs autorisés à fixer `X-Forwarded-For` (défaut : boucle locale et réseaux privés, c'est-à-dire le proxy `/api` du web). Derrière un proxy public, n'y mettre **que** ce proxy ; jamais `true`                                                                                                                |
| `WEB_TRUSTED_PROXY_HOPS`                                                                | non (`0`)              | nombre de proxys inverses devant le web ; `0` : l'adresse du client est celle de la connexion TCP (tout `X-Forwarded-For` reçu est remplacé). Ne le fixer que si le web n'est joignable **que** par ces proxys                                                                                                  |
| `WEB_HOST_BIND`                                                                         | non (`127.0.0.1`)      | interface hôte du port web ; `0.0.0.0` l'expose au réseau (recette, derrière TLS)                                                                                                                                                                                                                               |
| `REQUIRE_STAFF_MFA`                                                                     | avant pilote           | `true` : ADMIN et COMPLIANCE doivent activer la MFA pour utiliser leurs permissions (`403 STAFF_MFA_REQUIRED`) ; laisser `false` uniquement pour les comptes de démonstration                                                                                                                                   |
| `KMS_PROVIDER`                                                                          | recommandé             | `none` (clés d'environnement seulement), `local` (KMS simulé : `KMS_LOCAL_MASTER_KEY`, `openssl rand -hex 32`, **hors** des sauvegardes de la base) ou `aws` (`KMS_KEY_ID`, `KMS_REGION`, `KMS_ENDPOINT` facultatif) — voir [`KEY_ROTATION.md`](KEY_ROTATION.md) §4                                             |
| `KEY_ROTATION_INTERVAL_DAYS`, `KEY_ACTIVATION_DELAY_SECONDS`, `KEYRING_REFRESH_SECONDS` | non                    | rotation planifiée des clés gérées (0 = manuelle), délai avant activation d'une clé préparée (chaque réplique l'a chargée), période de rechargement                                                                                                                                                             |
| `ENCRYPTION_LEGACY_DECRYPT`                                                             | non (`true`)           | `false` retire la clé historique `DOCUMENT_ENCRYPTION_KEY` du déchiffrement ; uniquement quand `/admin/keys` indique `safeToDisable` pour chaque usage                                                                                                                                                          |
| `MFA_RECOVERY_SECRET`                                                                   | recommandé             | `openssl rand -hex 32` : les codes de récupération MFA ne dépendent plus de `SESSION_SECRET` (les anciens restent valides)                                                                                                                                                                                      |
| `METRICS_ENABLED`, `METRICS_TOKEN`                                                      | recommandé             | `GET /metrics` (Prometheus) ; avec un jeton (`openssl rand -hex 24`), accès par `Authorization: Bearer` ; sans jeton, boucle locale seulement — et seulement pour une API lancée hors conteneur : avec la composition, même un agent de l'hôte arrive depuis la passerelle Docker, le jeton est donc **requis** |
| `ANTIVIRUS_PROVIDER`                                                                    | avant pilote           | `sandbox` (ne détecte que le fichier de test EICAR — simulation), `clamd` (ClamAV, `CLAMD_HOST`, `CLAMD_PORT`, `ANTIVIRUS_TIMEOUT_MS`) ou `none` ; §11                                                                                                                                                          |
| `DOCUMENT_PURGE_GRACE_DAYS`                                                             | non (`0`)              | délai minimal entre la suppression d'un document et l'effacement de son blob (la rétention légale prime) ; §11                                                                                                                                                                                                  |
| `STORAGE_DRIVER`                                                                        | non (`local`)          | `s3` pour plusieurs hôtes ; alors `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`                                                                                                                                                                                                        |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`                                                | profil `s3`            | vérifiés au démarrage du conteneur (MinIO aurait sinon des identifiants par défaut connus)                                                                                                                                                                                                                      |
| `GRAFANA_ADMIN_PASSWORD`, `GRAFANA_ADMIN_USER`                                          | profil `observability` | mot de passe (>= 12 caractères) et compte administrateur de Grafana ; Prometheus lit `/metrics` avec `METRICS_TOKEN` ; ports publiés sur la boucle locale seulement (`PROMETHEUS_HOST_PORT`, `GRAFANA_HOST_PORT`) — voir [`OBSERVABILITY.md`](OBSERVABILITY.md)                                                 |
| `LOG_LEVEL`                                                                             | non (`info`)           | `debug` interdit en recette partagée                                                                                                                                                                                                                                                                            |
| `SEED_DEMO_PASSWORD`                                                                    | profil `seed`          | mot de passe des comptes de démonstration ; à changer avant toute recette partagée                                                                                                                                                                                                                              |

Les valeurs propres aux conteneurs sont fixées par la composition et l'emportent sur `.env` : `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`, `JOBS_DRIVER=bullmq`, `RATE_LIMIT_STORE=redis`, `STORAGE_DIR=/data/storage`, `API_PORT=4000`. Les identifiants des conteneurs d'infrastructure (`POSTGRES_*`, `REDIS_PASSWORD`, `MINIO_ROOT_*`, `GRAFANA_ADMIN_*`) sont vidés dans l'environnement de l'API.

Avant toute recette partagée : secrets uniques et stockés dans un coffre, TLS en frontal, `COOKIE_SECURE=true`, `REQUIRE_STAFF_MFA=true`, `TRUST_PROXY` limité au proxy frontal, origines exactes, comptes de démonstration supprimés ou mots de passe changés, sauvegardes planifiées **et** un exercice de restauration réussi (§6).

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
- PostgreSQL, Redis **et l'API** ne sont publiés que sur `127.0.0.1` : les navigateurs passent par le web (`/api/*`). Pour exposer l'API à des partenaires, placer un proxy TLS devant et le déclarer dans `TRUST_PROXY`.
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

### Mise à niveau d'une pile de la phase 6

- **Rôle `dfn_app`** : le script `infra/postgres/initdb/10-app-role.sh` ne s'exécute qu'à l'initialisation d'un volume `pgdata` vide. Sur une pile existante, définir `POSTGRES_APP_PASSWORD` dans `.env` puis, **avant** `docker compose up -d` :

  ```bash
  docker compose exec -T postgres psql -U dfn -d dfn -v ON_ERROR_STOP=1 -v pw="$(grep '^POSTGRES_APP_PASSWORD=' .env | cut -d= -f2-)" <<'SQL'
  CREATE ROLE dfn_app LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  GRANT CONNECT, TEMPORARY ON DATABASE dfn TO dfn_app;
  GRANT USAGE ON SCHEMA public TO dfn_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dfn_app;
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO dfn_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE dfn GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dfn_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE dfn GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO dfn_app;
  SQL
  ```

- **Port web** : publié sur `127.0.0.1` par défaut (`WEB_HOST_BIND`) ; une recette exposée met un proxy TLS devant et fixe `WEB_TRUSTED_PROXY_HOPS=1`.
- **Restauration** (§7) : `restore.sh` sans `--create` recrée le schéma `public` en conservant ses droits (`USAGE` de `dfn_app`) ; les droits de `dfn_app` sur les tables restaurées viennent des privilèges par défaut ci-dessus, non liés au schéma (restauration exécutée en tant que `dfn`).

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
- Planification (hôte d'exploitation) : cron ne fournit **aucune** variable du `.env`. Les paramètres vont dans un fichier réservé à root, lu par la tâche :

  ```bash
  # /etc/dfn/backup.env (chmod 600, propriétaire root) — jamais dans le dépôt
  BACKUP_DATABASE_URL='postgresql://dfn:…@127.0.0.1:5432/dfn'
  BACKUP_DIR=/srv/dfn/backups
  BACKUP_AGE_RECIPIENT=age1…            # sans destinataire, l'archive serait en clair

  # crontab de root
  15 2 * * * cd /srv/dfn && set -a && . /etc/dfn/backup.env && set +a && bash infra/ops/backup.sh >> /var/log/dfn-backup.log 2>&1 || logger -p user.err -t dfn-backup "échec de la sauvegarde"
  ```

  Un code de sortie non nul doit déclencher une alerte (ici `logger`, relayé par la supervision de l'hôte) ; puis copie hors site (stockage objet avec verrouillage, autre région).

- Depuis la composition, en dépannage uniquement (ni chiffrement ni purge) : `(umask 077; docker compose exec -T postgres pg_dump -U dfn -Fc dfn > dfn-$(date -u +%Y%m%dT%H%M%SZ).dump)` — le sous-shell `umask 077` rend le fichier lisible par son seul propriétaire. Préférer `backup.sh` avec `DATABASE_URL` pointant sur `127.0.0.1:5432`.

### Documents, clés, Redis

| Élément                                                                                                                                                                        | Procédure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blobs `STORAGE_DRIVER=local`                                                                                                                                                   | `(umask 077; docker compose exec -T api tar -C /data/storage -cf - . > storage-$(date -u +%Y%m%dT%H%M%SZ).tar)` (les blobs sont déjà chiffrés AES-256-GCM par l'application ; `storage-*.tar` est ignoré par git). **Juste après** la sauvegarde de la base, sans activation de clé gérée (`KEY_LIFECYCLE`) entre les deux : un blob sans ligne est inoffensif, l'inverse non, et un blob re-scellé avec une clé que la sauvegarde de la base ne contient pas serait illisible après restauration.                                                                                                                                                                                        |
| Blobs `STORAGE_DRIVER=s3`                                                                                                                                                      | `mc mirror --overwrite <alias>/<bucket> <sauvegarde>/<bucket>-<date>` ou réplication du bucket chez le fournisseur, juste après la sauvegarde de la base. Une réplication continue n'est pas une sauvegarde datée : garder des versions (versionnement du bucket, verrouillage d'objets) pour pouvoir revenir aux blobs de la date de la base.                                                                                                                                                                                                                                                                                                                                            |
| Clés et secrets (`ENCRYPTION_KEYRING`, `DOCUMENT_ENCRYPTION_KEY`, `SESSION_SECRET`, `MFA_RECOVERY_SECRET`, `KMS_LOCAL_MASTER_KEY` ou la clé AWS KMS désignée par `KMS_KEY_ID`) | dans le coffre de secrets, **séparément** des sauvegardes de la base et des blobs ; toute clé encore référencée (`/admin/keys`) doit rester restaurable. La clé maîtresse du KMS doit vivre aussi longtemps que la plus ancienne sauvegarde contenant des clés enveloppées sous elle (table `EncryptionKey`) ; `MFA_RECOVERY_SECRET` aussi longtemps que des codes de secours `r2:` existent. Sans la clé maîtresse, l'API refuse de démarrer et les valeurs scellées par les clés gérées sont perdues.                                                                                                                                                                                   |
| Clés de données gérées (table `EncryptionKey`)                                                                                                                                 | elles n'existent **que dans la base et ses sauvegardes** (enveloppées par le KMS, qui ne peut pas les recréer) : lancer la sauvegarde juste après chaque génération manuelle, avant son activation, avec les paramètres de la tâche planifiée (destination, chiffrement) : `sudo sh -c 'set -a && . /etc/dfn/backup.env && set +a && bash infra/ops/backup.sh --label key-<keyId>'`. Avec la rotation planifiée (`KEY_ROTATION_INTERVAL_DAYS` > 0), porter `KEY_ACTIVATION_DELAY_SECONDS` à `86400` (maximum) pour qu'une sauvegarde quotidienne capture chaque clé en attente avant son activation. `restore.sh` refuse d'effacer une clé plus récente que la sauvegarde restaurée (§7). |
| Redis                                                                                                                                                                          | non critique (AOF activé) : files et planifications sont reconstruites au démarrage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
   Le script vérifie la somme de contrôle, demande de **saisir le nom de la base cible** (ou `--yes` en automatisation), puis supprime le schéma (avec tout ce qu'il contient, tables ajoutées depuis comprises) et le restaure en **une seule transaction** : en cas d'erreur, la base reste dans son état antérieur. `--create` restaure dans une nouvelle base ; `--jobs N` accélère les gros volumes mais n'est plus atomique.
   **Clés gérées** : si la base cible contient des clés de données `ACTIVE` ou `DECRYPT_ONLY` absentes de la sauvegarde (générées après elle), le script **refuse** et les liste — les effacer détruirait leur seule copie et rendrait illisible tout ce qu'elles ont scellé depuis. Relancer avec `--keep-newer-keys` : elles sont reportées en `DECRYPT_ONLY` dans la même transaction et, si une clé `documents` en fait partie, chaque document restauré qui a encore un blob est enregistré sous elle (les blobs, hors de la base, ont pu être re-scellés avec elle depuis la sauvegarde) — `ENCRYPTION_KEY_ROTATION` rouvre alors chaque blob (ligne réparée, blob re-scellé avec la clé active ; « À re-chiffrer » dans `/admin/keys`) et aucune clé reportée ne peut être retirée avant le dernier. Ou `--discard-newer-keys`, seulement si les blobs sont restaurés d'une date antérieure à l'activation de ces clés. Une sauvegarde antérieure à la phase 7 (sans table `EncryptionKey`) n'accepte pas `--keep-newer-keys` : exporter d'abord les lignes (`pg_dump --data-only -t '"EncryptionKey"'`), relancer avec `--discard-newer-keys`, puis, après les migrations et **avant** de démarrer l'API, les réinsérer en `DECRYPT_ONLY` et enregistrer sous la clé `documents` la plus récente chaque document qui a un blob (`UPDATE "Document" SET "encryptionKeyId" = '<keyId>' WHERE encrypted AND "blobPurgedAt" IS NULL;`) — ce que `--keep-newer-keys` fait seul. Ne retirer aucune de ces clés avant que « À re-chiffrer » soit revenu à 0.
4. **Restaurer les blobs** de la même date (après la base), et vérifier que les clés du trousseau couvrent les identifiants référencés (`/admin/keys`, colonne « Illisibles » à 0). Cette colonne ne lit que les identifiants enregistrés sur les lignes : télécharger aussi quelques documents modifiés ou re-scellés après la sauvegarde. Un `503 KEY_NOT_FOUND` qui nomme une clé `kms-…` signale un blob re-scellé avec une clé que la base restaurée ne contient pas (`KEY_ROTATION.md` §7).
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

| Source                                   | Contenu                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journaux API (`docker compose logs api`) | JSON pino sur la sortie standard, un enregistrement par requête avec `req.id` (en-tête `X-Request-Id` repris s'il est fourni, renvoyé dans les erreurs `requestId`) ; secrets, cookies et en-têtes `authorization` masqués. Rotation `json-file` 10 Mo × 5.                              |
| Traces de pile                           | `node --enable-source-maps` : les piles de `dist/main.js` pointent vers les sources TypeScript (cartes `dist/*.js.map` incluses dans l'image).                                                                                                                                           |
| `GET /v1/health`                         | sonde de vie, de base de données et des clés gérées par le KMS (`managedKeys` : clés chargées, en échec, erreur de rafraîchissement) ; `status: degraded` si la base ou une clé gérée fait défaut, sans faire échouer le `HEALTHCHECK` Docker.                                           |
| Console administrateur                   | `/admin/jobs` (pilote, baux, historique `MaintenanceRun` par instance, résumés des exécutions), `/admin/keys` (trousseau, clés gérées, documents à re-chiffrer), `/admin/gates`, réconciliation du registre ; état du stockage et de la migration par `GET /v1/admin/storage`.           |
| Métriques et alertes                     | `GET /metrics` (Prometheus, jeton `METRICS_TOKEN`), 24 règles d'alerte, tableau de bord Grafana et profil compose `observability` : [`OBSERVABILITY.md`](OBSERVABILITY.md). Chaque ligne de journal porte `traceId` / `spanId` (`traceparent` W3C repris ou créé, propagé aux webhooks). |
| Base de données                          | `AuditLog` (actions sensibles), `MaintenanceRun`, `ReconciliationJob` / `ReconciliationDifference`, `ApiRequestLog`, `WebhookDelivery`.                                                                                                                                                  |
| Exercices de restauration                | sortie de `restore-test.sh` (durées, comptages, réconciliation) et artefacts de la CI.                                                                                                                                                                                                   |

Latences, taux d'erreur, profondeur des files, état des tâches, des webhooks et des clés se lisent sur `/metrics` (phase 7, ADR-0016) ; `infra/ops/check-profiles.sh` vérifie de bout en bout une pile démarrée avec les profils `s3` et `observability` (document stocké sur MinIO, collecte, règles, tableau de bord) ; règles, seuils et conduite à tenir pour chaque alerte : [`OBSERVABILITY.md`](OBSERVABILITY.md) §5.

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

## 11. Documents : antivirus, purge différée, migration vers S3

Choix et garanties : [ADR-0015](../decisions/ADR-0015-antivirus-purge-migration-documents.md). Vue d'ensemble pour un administrateur (`admin:keys`) : `GET /v1/admin/storage` (blobs par pilote, verdicts antivirus, blobs conservés / purgeables / purgés, migration en attente — comptages uniquement).

### Antivirus des téléversements

| `ANTIVIRUS_PROVIDER` | Comportement                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox` (défaut)   | **Simulation** : ne détecte que le fichier de test EICAR (chaîne de test publiée par eicar.org), rien d'autre. Sert à éprouver le refus de bout en bout ; ce n'est **pas** une protection. |
| `clamd`              | Démon ClamAV (protocole `INSTREAM`, `CLAMD_HOST`, `CLAMD_PORT`, `ANTIVIRUS_TIMEOUT_MS`). Seul mode qui analyse réellement.                                                                 |
| `none`               | Aucune analyse : documents enregistrés `SKIPPED`. À réserver à un diagnostic, décision consignée dans le registre d'exploitation.                                                          |

- Analyse **avant** tout stockage. Fichier signalé : `422 DOCUMENT_INFECTED`, rien n'est stocké, audit `document.rejected_infected` : moteur, nom de signature, type, taille, SHA-256 et transaction — jamais le nom de fichier ni le contenu. Sans verdict (démon arrêté, délai, fichier trop gros pour clamd) : `503 SCAN_UNAVAILABLE`, **échec fermé** — les téléversements sont refusés tant que l'antivirus est indisponible, le reste de l'API continue.
- Au démarrage, le journal `Antivirus` indique le fournisseur ; avec `clamd`, un `PING` est tenté : `antivirus provider=clamd at clamav:3310: ok` ou `UNAVAILABLE`. Vérification manuelle : `printf 'zPING\0' | nc -q1 clamav 3310` → `PONG`.
- **Conteneur annexe clamd** (suggestion, fichier `docker-compose.override.yml` hors dépôt) :

  ```yaml
  services:
    clamav:
      image: clamav/clamav:1.4 # épingler une version ; l'image met à jour ses signatures (freshclam)
      restart: unless-stopped
      # aucun port publié : joint par l'API sur le réseau interne de la composition
      volumes:
        - clamavdb:/var/lib/clamav # signatures conservées entre redémarrages
    api:
      environment:
        ANTIVIRUS_PROVIDER: clamd
        CLAMD_HOST: clamav
        CLAMD_PORT: '3310'
        ANTIVIRUS_TIMEOUT_MS: '30000'
      depends_on:
        clamav:
          condition: service_healthy
  volumes:
    clamavdb:
  ```

  Prévoir 1,5 à 3 Go de mémoire pour clamd et quelques minutes au premier démarrage (chargement des signatures). `StreamMaxLength` (clamd.conf, 25 Mo par défaut) doit être **au moins** `MAX_UPLOAD_MB` : au-delà, clamd répond « INSTREAM size limit exceeded » et l'API refuse en `503 SCAN_UNAVAILABLE` (`details.reason = SIZE_LIMIT`). Plusieurs répliques peuvent partager un démon ou en avoir un chacune.

- Incident « `503 SCAN_UNAVAILABLE` sur les téléversements » (alertes `DfnDocumentScanUnavailable` et, pour `SIZE_LIMIT`, `DfnDocumentScanSizeLimit` ; compteur `dfn_document_scans_total{outcome="UNAVAILABLE"}` par `reason`) : `details.reason` dans la réponse (`UNREACHABLE`, `TIMEOUT`, `SIZE_LIMIT`, `ENGINE_ERROR`, `CONNECTION_LOST`, `PROTOCOL_ERROR`), journaux `docker compose logs clamav` et `Antivirus` de l'API ; rétablir le démon (rien à rejouer : aucun fichier n'a été stocké). Passer à `none` est une dégradation de sécurité, jamais un correctif.

### Purge différée (`DOCUMENT_PURGE`)

- Supprimer un document ne fait plus que la suppression logique : le blob chiffré est **conservé** jusqu'à `max(deletedAt + DOCUMENT_PURGE_GRACE_DAYS, retentionUntil)` (7 ans après le téléversement par défaut), et tant qu'il est une pièce (preuve de jalon, preuve ou pièce jointe d'un litige non clos). Les utilisateurs voient l'état sous « Documents supprimés » (`/documents`).
- La tâche s'exécute à chaque passage du planificateur (`JOBS_INTERVAL_MINUTES`) : au plus 1 000 documents ou 5 minutes par exécution, la suite au passage suivant. Exécution immédiate : console `/admin/jobs` → `DOCUMENT_PURGE` (réservée à `admin:keys`).
- Lire le résumé de l'exécution (`MaintenanceRun.summary`) : `purged` ; `missing` (blob déjà absent **et** suppression antérieure à la phase 7 : ligne enregistrée purgée, audit `document.blob_missing`) ; `raced` (document déplacé entre-temps, repris au passage suivant) ; `failed` et `errors` par raison ; `reswept` (lignes purgées depuis l'exécution précédente dont l'emplacement a été supprimé une seconde fois — ferme la fenêtre d'une rotation ou d'une migration interrompue entre son écriture et sa comparaison-échange) ; `remaining`.
- Intention avant destruction : chaque suppression de blob est précédée de l'audit `document.blob_purge_started` (pilote et clé de stockage). Une purge interrompue entre la suppression du blob et l'horodatage de la ligne (arrêt du processus, erreur de base) est reconnue et **achevée** au passage suivant (blob absent + intention pour ce même emplacement), et la ligne apparaît alors dans `document.blobs_purged`. Une suppression signalée en échec est vérifiée aussitôt : si le blob a disparu (suppression appliquée malgré l'erreur, délai d'un appel S3 par exemple), la purge se termine normalement ; s'il est encore là, ou si la vérification échoue, l'intention est retirée (`document.blob_purge_aborted`) et un blob absent ensuite n'est jamais supposé détruit.
- Garde-fous : le stockage de chaque pilote est sondé une fois par exécution. S'il est indisponible (`STORAGE_UNREACHABLE`, `STORAGE_MISCONFIGURED`, `STORAGE_ACCESS_DENIED`, `STORAGE_IO_ERROR` : volume non monté, mauvais `STORAGE_DIR`, bucket inexistant, droits), **aucune ligne n'est horodatée** et tous ses documents sont comptés `failed` ; la purge réessaie seule au passage suivant, rien n'est perdu. Un blob absent d'un stockage sain alors que sa suppression promettait la rétention (audit `document.deleted` avec `blobRetained`) n'est jamais enregistré purgé : compté `failed` (`STORAGE_NOT_FOUND`) et réessayé à chaque passage — l'obligation d'effacement n'est déclarée remplie qu'après destruction effective.
- Audit : `document.blobs_purged` par page et par organisation (identifiants purgés et absents, nombre d'échecs) ; la ligne `Document` (métadonnées, SHA-256) reste et porte `blobPurgedAt`.
- Les documents supprimés **avant** la phase 7 n'ont déjà plus de blob : ils sont enregistrés purgés quand la purge (à leur date), la migration ou la rotation des clés les rencontre (`document.blob_missing`).
- Incident « `STORAGE_NOT_FOUND` qui persiste » : des blobs conservés manquent (une purge interrompue est achevée seule, elle ne laisse pas ce symptôme). Exception à vérifier d'abord : un audit `document.blob_purge_aborted` pour ce document signale une suppression déclarée en échec dont la vérification n'a pas pu conclure (stockage injoignable juste après) ; elle a pu aboutir. Vérifier `STORAGE_DIR` et le montage du volume (`docker compose exec api ls /data/storage`) ou le bucket et ses identifiants, puis restaurer les blobs depuis la sauvegarde (§5, §7) : la purge les détruit ensuite normalement. Si la perte est confirmée et consignée dans le registre d'exploitation, enregistrer la ligne à la main — `UPDATE "Document" SET "blobPurgedAt" = now() WHERE id = '<id>' AND "deletedAt" IS NOT NULL AND "blobPurgedAt" IS NULL;` — jamais en masse sans cette vérification : une ligne horodatée sort pour toujours du filtre de la purge, de la rotation et de la migration.

### Migrer les documents du disque local vers S3 (`STORAGE_MIGRATION`)

Prérequis : sauvegarde de la base **puis** des blobs locaux (§5) ; bucket privé et identifiants restreints (profil `s3` de la composition, ou fournisseur) ; trousseau complet (`/admin/keys`, « Illisibles » à 0).

1. Passer **toutes** les répliques à `STORAGE_DRIVER=s3` avec les variables `S3_*`, en gardant le volume `storage` monté (les documents encore locaux restent servis depuis leur pilote d'origine), puis redémarrer. Sans `STORAGE_DRIVER=s3`, la tâche est sans effet au passage du planificateur, échoue si on la lance à la main, et la console répond `409 NOT_AVAILABLE`.
2. État : `GET /v1/admin/storage` → `migration.pending` (documents à copier) et `migration.pendingBytes`.
3. **Essai à blanc** : `POST /v1/admin/storage/migration` avec `{"dryRun": true}` (session administrateur ; via `curl`, joindre le cookie de session). Chaque blob en attente est lu et vérifié (authentification, SHA-256), rien n'est écrit. Exiger `failed = 0` ; sinon lire `errors` (`DECRYPT_FAILED` / `SHA256_MISMATCH` : blob corrompu, audité `document.integrity_failed` ; `KEY_NOT_FOUND` : clé à restaurer dans le trousseau) et traiter avant de poursuivre.
4. **Migration** : `{"dryRun": false}` sur le même point d'accès, ou laisser le planificateur avancer (200 documents par passage). Pour chaque document : copie vers S3, relecture et comparaison des SHA-256 des octets scellés, bascule de la ligne (comparaison-échange), **puis** suppression de la copie locale. Un échec laisse le document sur le disque local, intact et servi.
5. Contrôler : `migration.pending = 0`, téléchargement d'un ancien document, audit `document.blobs_migrated` / `storage.migration_run`. Les documents supprimés avant la phase 7 (blob déjà effacé) sont comptés `missing` et enregistrés purgés au passage (l'essai à blanc les compte seulement) ; un blob absent dont la conservation était promise (ou celui d'un document vivant) est compté `failed` avec `errors.STORAGE_NOT_FOUND`, dès l'essai à blanc, et reste dans `remaining` : anomalie à analyser (mauvais `STORAGE_DIR`, volume non monté, blobs restaurés d'une sauvegarde trop ancienne) avant de poursuivre — même traitement qu'au §11 pour la purge. Conserver la sauvegarde des blobs locaux au moins jusqu'à la sauvegarde suivante du bucket ; le volume `storage` peut ensuite être retiré.

**Délai d'attente.** L'appel de la console s'exécute dans la requête HTTP (jusqu'à 5 min et 200 documents par exécution). Un délai d'attente du mandataire ou du proxy `/api` du web (502/504 après 30 à 60 s) **n'interrompt pas** l'exécution, qui continue sous son bail et écrit ses audits : lire le résultat dans `/admin/jobs` (`GET /v1/admin/jobs/runs?jobName=STORAGE_MIGRATION`, colonne `summary` — `failed = 0` attendu à l'étape 3 —, audit `storage.migration_run`) au lieu de relancer ; une relance pendant l'exécution répond `409 JOB_ALREADY_RUNNING`. Pour un essai à blanc volumineux, porter le délai de lecture du mandataire au-delà de 5 min, ou laisser le planificateur avancer.

**Retour arrière.** Avant la bascule d'une ligne, rien n'est perdu : interrompre (repasser `STORAGE_DRIVER=local`) laisse les documents non migrés sur le disque ; une copie S3 orpheline éventuelle est sans effet (chiffrée, écrasée au passage suivant). Après bascule, les documents migrés vivent dans le bucket : repasser `STORAGE_DRIVER=local` est sans danger **tant que `S3_*` reste configuré** (lecture selon le pilote enregistré de chaque document). Il n'existe pas de migration inverse automatisée : pour revenir à un stockage purement local, geler l'API, copier le bucket dans `STORAGE_DIR` (`mc mirror <alias>/<bucket> <STORAGE_DIR>`), vérifier, puis `UPDATE "Document" SET "storageDriver" = 'local' WHERE "storageDriver" = 's3'` dans une transaction, et contrôler quelques téléchargements avant de rouvrir.
