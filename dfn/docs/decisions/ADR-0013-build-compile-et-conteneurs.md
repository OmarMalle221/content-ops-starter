# ADR-0013 — Build compilé de l'API, conteneurs durcis, sauvegardes éprouvées et CI de bout en bout

| Champ  | Valeur                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Statut | Accepté                                                                                                                                                                                                                                                                              |
| Date   | 2026-10-11                                                                                                                                                                                                                                                                           |
| Portée | `apps/api/tsup.config.ts`, `apps/api/src/main.ts`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`, `docker-compose.yml`, `infra/ops/*` (sauvegarde, restauration, exercice, test de fumée, réconciliation), `.github/workflows/dfn.yml`, `docs/operations/RUNBOOK.md` |

## Contexte

Jusqu'à la phase 5, l'API s'exécutait partout — y compris dans l'image Docker — avec `ts-node` en mode transpilation seule : compilation de tout le code au démarrage, dépendances de développement (TypeScript, ts-node) embarquées, conteneur exécuté par l'utilisateur `node` avec un système de fichiers inscriptible, migrations lancées par la commande de démarrage de l'API, aucun secret obligatoire dans la composition (mots de passe `dfn`/`dfn` par défaut), sauvegardes décrites dans `SECURITY.md` mais jamais outillées ni testées. La feuille de route listait « build compilé de l'API, image Docker durcie, sauvegardes PostgreSQL testées » comme prérequis de la préparation partenaires (phase 6).

Deux contraintes techniques encadrent le build :

- les paquets du monorepo (`@dfn/shared`, `@dfn/database`, `@dfn/financial-ledger`, `@dfn/compliance`, `@dfn/payment-adapters`, `@dfn/contracts`) sont publiés **en sources TypeScript** (`main: src/index.ts`) ;
- NestJS repose sur les métadonnées de décorateurs (`design:paramtypes`) pour l'injection de dépendances ; esbuild seul ne les émet pas.

## Décision

### 1. API compilée avec tsup + SWC

- `apps/api/tsup.config.ts` produit `apps/api/dist/{main,export-openapi,reconcile-ledger}.js` (CommonJS, cible Node 22, cartes de sources) ; `pnpm build:api` (racine) ou `pnpm --filter @dfn/api build`.
- Les paquets `@dfn/*` sont **embarqués** dans le bundle (`noExternal: [/^@dfn\//]`, résolus par les `paths` du tsconfig) ; **toute autre dépendance reste externe** (`skipNodeModulesBundle`) : client Prisma généré, modules natifs (`argon2`), et les `require()` optionnels de Nest continuent de se résoudre normalement depuis `node_modules`.
- `emitDecoratorMetadata` étant actif dans `tsconfig.base.json`, tsup transforme chaque fichier avec **SWC** (`@swc/core`, dépendance de développement) : plusieurs centaines de métadonnées `design:paramtypes` sont émises dans `dist/main.js`. L'étape de build Docker échoue si elles sont absentes (garde `grep`), car tsup ne fait qu'avertir quand SWC manque.
- `start:prod` = `node --enable-source-maps dist/main.js` ; `start`/`dev` (ts-node) restent pour le développement ; `typecheck` reste la vérification de types (tsup ne vérifie pas les types).
- `main.ts` active explicitement l'arrêt gracieux (`enableShutdownHooks`) et ajoute un chien de garde : au-delà de 25 s après `SIGTERM`/`SIGINT`, sortie forcée avec le code 1 (la composition laisse 30 s).

### 2. Images durcies

- **API** (`apps/api/Dockerfile`), multi-étapes : `manifests` (manifestes + lockfile, cache des installations) → `deps` (installation complète filtrée sur `@dfn/api...`) → `build` (`prisma generate`, tsup) → `prod-deps` (installation `--prod` du même lockfile, client Prisma généré copié dans le même répertoire du magasin virtuel, retrait de ts-node / TypeScript / SWC / `@types`, CLI Prisma exposé à un chemin stable et vérifié) → `runtime`.
- `pnpm deploy` n'est pas utilisé : en pnpm 10.0.0 il exige `inject-workspace-packages=true` et l'option `--legacy` reste refusée ; l'installation `--prod` filtrée donne le même résultat sans changer la configuration de l'espace de travail.
- `runtime` : `node:22-bookworm-slim`, `openssl` (moteurs Prisma), `tini` en PID 1 (relais de `SIGTERM`, récupération des zombies), `npm`/`npx`/`corepack`/`yarn` supprimés, utilisateur **uid 10001** sans shell ni répertoire personnel, fichiers applicatifs appartenant à `root` (lecture seule pour l'utilisateur), `NODE_ENV=production`, `DFN_MODE=sandbox`, `HEALTHCHECK` sur `/v1/health`, aucun secret. Contenu : `dist/` (+ cartes), `node_modules` de production, `prisma/schema.prisma` et `prisma/migrations`. Écritures possibles : `/data/storage` (volume) et `/tmp` (tmpfs).
- **Migrations** : service ponctuel `migrate` exécutant `prisma migrate deploy` **avec la même image** (le CLI Prisma est déjà présent comme pair de `@prisma/client`) ; l'API ne migre plus au démarrage et ne démarre qu'après la réussite de `migrate`.
- **Web** (`apps/web/Dockerfile`) : sortie `standalone` de Next, mêmes principes (uid 10001, `tini`, fichiers en lecture seule, `.next/cache` seul répertoire inscriptible). `API_INTERNAL_URL` est un argument de **construction** : les réécritures `/api/*` sont figées au build (vérifié : une image construite pour `:4000` ignore une autre valeur à l'exécution). Sonde de santé sur `/dashboard` sans cookie : la redirection du middleware vérifie le serveur web sans dépendre de l'API.
- `.dockerignore` exclut `node_modules`, `.next`, `dist`, `.env*` (sauf `.env.example`), le stockage local, les sauvegardes, la couverture et les rapports de test ; les motifs sont ancrés pour ne pas exclure `apps/api/src/common/storage` (code source).

### 3. Composition sans secret par défaut

`docker-compose.yml` : `postgres`, `redis` (mot de passe, AOF, `noeviction`), `migrate`, `api`, `web`, profils `s3` (`s3` + `s3-init` : SeaweedFS, bucket privé, utilisateur API limité au bucket — MinIO à l'origine, remplacé le 2026-10-23 faute d'image publique) et `seed`. Les secrets sont **obligatoires** (`${VAR:?…}`) ou vérifiés au démarrage du conteneur pour les services de profil (aucun identifiant par défaut du serveur S3 ne peut s'appliquer). `api`, `web` et `migrate` : `read_only: true`, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`. Avec Redis présent, l'API tourne en `JOBS_DRIVER=bullmq` et `RATE_LIMIT_STORE=redis` (ADR-0011) : elle peut être répliquée. PostgreSQL, Redis et MinIO ne sont publiés que sur `127.0.0.1`. La gestion des versions d'objets du bucket n'est pas activée : d'anciennes versions conserveraient des chiffrés sous des clés retirées (ADR-0010) et des documents supprimés.

### 4. Sauvegardes outillées et exercice de restauration automatisé

- `infra/ops/backup.sh` : `pg_dump -Fc` horodaté, chiffrement `age` ou `gpg` si un destinataire est configuré, `.sha256`, vérification `pg_restore --list`, publication atomique, rétention (30 jours, 7 sauvegardes minimum).
- `infra/ops/restore.sh` : somme de contrôle, déchiffrement, confirmation par saisie du nom de la base (ou `--yes`), restauration **en une seule transaction**.
- `infra/ops/restore-test.sh` : sauvegarde → restauration dans une base jetable → `prisma migrate status` → comptages comparés à la source → `LedgerService.reconcile()` (`infra/ops/reconcile-ledger.ts`) : 0 transaction déséquilibrée et débits = crédits par devise → suppression → rapport de durées.
- Identifiants passés par les variables `PG*`, jamais en argument ni à l'écran ; `set -euo pipefail` et `umask 077` partout ; `shellcheck` sans avertissement.

### 5. CI

`quality` gagne un service `redis:7` (`REDIS_URL`, `TEST_REDIS_URL`), la vérification de types de `infra/ops`, `shellcheck`, le build compilé et un démarrage de fumée de `dist/main.js` (santé, inscription, session, OpenAPI, arrêt par `SIGTERM`). `e2e` lance l'API **compilée**. Nouveaux travaux : `backup-restore` (exercice sur une base ensemencée, en clair puis chiffré par `age`, réconciliation compilée puis ts-node) et `containers` (construction des deux images, pile complète, migrations, test de fumée à travers le web, uid 10001 et système de fichiers en lecture seule vérifiés).

## Conséquences

Positives : démarrage sans compilation ; image sans chaîne de développement (TypeScript, SWC, ts-node), non privilégiée et immuable ; cartes de sources pour des piles lisibles ; migrations séparées et ordonnées ; aucun secret par défaut ; sauvegardes chiffrées, vérifiées et purgées ; restauration éprouvée à chaque CI avec réconciliation comptable, ce qui fournit la mesure de RTO demandée par `SECURITY.md` ; mise à l'échelle documentée (BullMQ, Redis, S3).

Négatives : un build de plus à maintenir (alias `paths`, liste des points d'entrée) ; les dépendances déclarées en `dependencies` mais inutiles au bundle (ts-node, tsconfig-paths) sont installées puis retirées dans l'image — à déplacer en `devDependencies` ; le CLI Prisma (≈ 120 Mo avec ses moteurs et dépendances) reste dans l'image d'exécution pour le service `migrate` ; l'image web dépend de l'adresse interne de l'API connue au build ; l'image du serveur S3 est épinglée (`S3_SERVER_IMAGE` pour la remplacer) ; pas encore de collecte de métriques.

## Alternatives

| Alternative                                 | Raison du rejet                                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conserver ts-node en production             | Compilation au démarrage, TypeScript dans l'image, surface d'attaque et temps de démarrage accrus ; jalon explicite de la feuille de route         |
| `tsc` + `tsc-alias` sur chaque paquet       | Imposerait un build et des sorties `dist` à tous les paquets `@dfn/*` (aujourd'hui consommés en sources par l'API, le web et les tests)            |
| esbuild seul / tsup sans SWC                | Pas de métadonnées `design:paramtypes` : injection de dépendances Nest cassée sans erreur à la compilation                                         |
| Nest CLI (`nest build`, webpack)            | Chaîne plus lourde, configuration webpack à maintenir pour les paquets en sources ; tsup + SWC suffit                                              |
| Tout embarquer (y compris `node_modules`)   | Incompatible avec les modules natifs et le client Prisma généré ; casse les `require()` optionnels de Nest                                         |
| `pnpm deploy`                               | Refusé par pnpm 10.0.0 sans `inject-workspace-packages=true` (modifie la résolution de tout l'espace de travail)                                   |
| Image distroless                            | Pas de shell pour la sonde ni le diagnostic, détection d'OpenSSL de Prisma fragile ; `bookworm-slim` + uid 10001 + lecture seule offre l'essentiel |
| Migrations au démarrage de l'API            | Courses entre répliques, droits DDL pour le processus applicatif, échec de migration = API indisponible                                            |
| Sauvegarde logique sans exercice automatisé | Une sauvegarde jamais restaurée n'est pas une sauvegarde ; la réconciliation comptable après restauration est exigée par `SECURITY.md` §12         |

## Vérification

- `dist/main.js` démarré contre une base de test (`NODE_ENV=production`) : `GET /v1/health`, `POST /v1/auth/register`, `GET /v1/auth/me`, `/docs`, rejet CSRF d'une origine étrangère et arrêt gracieux sur `SIGTERM`.
- Disposition exacte de l'image (`node_modules` de production élagués + client généré + `dist`) reconstituée hors du dépôt : démarrage, test de fumée et `prisma migrate deploy` / `migrate status` sur une base vierge réussis.
- `restore-test.sh` de bout en bout sur une base ensemencée : en clair, chiffré `age`, chiffré `gpg` ; échec attendu sur une sauvegarde contenant une écriture déséquilibrée ; refus sans `--yes` en non interactif ; refus sur somme de contrôle altérée ; rétention vérifiée.
- `docker compose config` valide (profils par défaut, `s3`, `seed`) et refus en l'absence de secret. Le démon Docker n'étant pas disponible dans l'environnement de développement, la construction réelle des images est vérifiée par le travail CI `containers`.

## Révision

À revoir avant toute phase live : PITR (archivage WAL) et cibles RPO/RTO, registre d'images signé (SBOM, signature), collecte de métriques, retrait du CLI Prisma de l'image d'exécution au profit d'une image d'outillage dédiée, et passage de ts-node / tsconfig-paths en `devDependencies`.
