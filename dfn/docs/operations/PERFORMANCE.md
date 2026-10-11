# Performance de l'API — tests de charge et de concurrence (phase 6)

> Environnement **sandbox** : toutes les mesures portent sur des données fictives (« Données fictives — Aucun fonds réel »). Les chiffres ci-dessous décrivent un poste de développement, pas une capacité de production ; ils servent à repérer les régressions et les goulets d'étranglement, et à vérifier les objectifs de [PRODUCT_REQUIREMENTS.md](../../PRODUCT_REQUIREMENTS.md) §5.

## 1. Objectifs (PRD §5 « Performance »)

| Objectif                                                                             | Application dans le test de charge                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Liste de transactions paginée (≤ 100 par page) < 500 ms p95 sur 100 000 transactions | appliqué à **toutes** les lectures mesurées (santé, synthèse du portefeuille, transactions, estimation FX, transferts) |
| Écriture ledger < 100 ms p95 hors contention                                         | scénario d'écriture optionnel (`LOAD_WRITES=1`) : dépôt sandbox de 0,01 CAD, **une seule connexion**                   |
| Taux d'erreur                                                                        | au plus 1 % de réponses non 2xx, erreurs de socket et délais dépassés confondus                                        |

## 2. Méthode

### 2.1 Test de charge (`apps/api/test/load/run.ts`)

- Outil : **autocannon 8**, API programmatique, contre une **API déjà démarrée** (le script n'en démarre jamais) ; il refuse toute cible autre que la boucle locale sans `LOAD_ALLOW_REMOTE=1`, et toute API qui ne répond pas `x-dfn-mode: sandbox`.
- Identité : connexion avec un compte seedé (`moussa@demo.dfn` par défaut, `LOAD_EMAIL` / `LOAD_PASSWORD`) ; à défaut, inscription d'un compte `load-<horodatage>@example.com`.
- Scénarios, joués l'un après l'autre : `GET /v1/health`, `GET /v1/wallets/:org/summary`, `GET /v1/transactions?pageSize=20`, `POST /v1/wallets/estimate` (CAD → XOF), `GET /v1/transfers?pageSize=20` ; avec `LOAD_WRITES=1`, `POST /v1/sandbox/wallets/self-deposit` (0,01 CAD, 1 connexion).
- Paramètres par défaut : **10 connexions**, **10 s mesurées par scénario**, précédées de **2 s de chauffe** non mesurées (`LOAD_CONNECTIONS`, `LOAD_DURATION`, `LOAD_WARMUP`).
- Latences : chaque réponse est enregistrée (événement `response` d'autocannon) ; p50, p95 et p99 sont calculés exactement sur l'ensemble des réponses (autocannon ne fournit pas de p95).
- Clients simulés : l'API limite le débit **par adresse IP** (120 requêtes par minute et par route, garde `@nestjs/throttler`, `trust proxy = 1`). En mode `LOAD_CLIENT_MODE=distinct` (défaut), chaque requête porte son propre `X-Forwarded-For`, comme une population de clients derrière le proxy de confiance : on mesure la capacité de l'API, pas la limite anti-abus. Le mode `single` mesure au contraire la limitation : sur 5 s, 9 701 réponses sur 9 820 sont des `429` (98,79 %) et le script sort en échec, comme attendu.
- Sortie : tableau Markdown (repris ci-dessous), JSON brut optionnel (`LOAD_JSON`), **code de sortie non nul** si un p95 dépasse son objectif ou si les erreurs dépassent 1 %.

### 2.2 Jeu de données de 100 000 transactions (`apps/api/test/load/bulk-transactions.ts`)

L'objectif du PRD est formulé « sur 100 000 transactions ». Les créer par l'API prendrait des heures ; le script les insère directement dans PostgreSQL (`generate_series`, lots de 10 000, environ 3 s) pour l'organisation personnelle du compte de charge : transactions Protect **sans aucun mouvement d'argent** (`DRAFT`, `PENDING_ACCEPTANCE`, `CANCELLED`, `EXPIRED`), référencées `LOAD-<tag>-<n>` et marquées `metadata.loadTest = true`. Aucune écriture comptable n'est créée ni modifiée ; `--cleanup` supprime exactement ces lignes. Le script refuse une base dont le nom ne contient ni `test` ni `load` (sauf `LOAD_BULK_FORCE=1`).

### 2.3 Tests de concurrence (`apps/api/test/concurrency.test.ts`)

Tests vitest exécutés à travers toute la pile HTTP (gardes, validation, services, verrous PostgreSQL) ; chaque scénario envoie ses requêtes **simultanément** puis vérifie l'invariant **en base et dans le registre**, jamais d'après les seules réponses :

| Scénario                                                              | Invariant vérifié                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 20 dépôts sandbox de 3 000,00 CAD autour du plafond (50 000,00)       | exactement 16 acceptés, 4 refus `409 SANDBOX_LIMIT_REACHED`, utilisé du jour = 49 000,00 ≤ plafond, solde = 49 000,00     |
| 10 autorisations de transferts vidant un portefeuille de 1 000,00 CAD | exactement 4 transferts `PROCESSING` (4 × 204,49), 6 refus `409 INSUFFICIENT_FUNDS`, solde 182,04 ≥ 0, 4 écritures source |
| 10 paiements par portefeuille de 30,00 sur une facture de 100,00      | exactement 3 paiements, payé 90,00 ≤ total, statut `PARTIALLY_PAID`, 3 écritures, mouvements payeur/émetteur exacts       |
| 10 approbations simultanées d'un même jalon Protect                   | une seule libération (`RELEASE`) de 9 250,00, jalon `RELEASED`, portefeuille vendeur crédité une fois                     |
| 10 premiers dépôts simultanés sur un portefeuille inexistant          | aucune corruption : un seul `Wallet`, solde = somme des dépôts acceptés, autant d'écritures que de succès                 |
| Réconciliation finale (`LedgerService.reconcile()`)                   | aucun écart, aucune transaction déséquilibrée, débits = crédits par devise, aucun portefeuille négatif                    |

Les comptes créés paresseusement (premier portefeuille d'une organisation dans une devise, premier compte `FX_CLEARING:<devise>` de la plateforme) sont « chauffés » avant les scénarios monétaires : leur création concurrente est une course connue, traitée par le scénario dédié (voir §5.3).

## 3. Environnement de mesure

| Élément   | Valeur                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine   | VM Linux, 4 vCPU Intel Xeon 2,1 GHz, 16 Gio de RAM                                                                                                                                                                    |
| Logiciels | Node.js 22.22.0, PostgreSQL 16.15 (local, configuration par défaut : `jit = on`, `jit_above_cost = 100000`)                                                                                                           |
| API       | une instance, `NODE_ENV=production` (limitation de débit active), lancée par `ts-node` en mode `transpile-only` (pas le bundle `tsup`), `JOBS_ENABLED=false`, sans Redis (notifications en mémoire), `LOG_LEVEL=warn` |
| Injecteur | autocannon sur la **même machine** que l'API et PostgreSQL (les trois se partagent les 4 vCPU)                                                                                                                        |
| Date      | 11 octobre 2026                                                                                                                                                                                                       |

## 4. Résultats mesurés

### 4.1 Jeu de démonstration (3 transactions, 3 transferts visibles par l'utilisateur)

| Scénario       | Requête                                            | Conn. | Requêtes | Débit (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Erreurs | Objectif p95 | Verdict |
| -------------- | -------------------------------------------------- | ----: | -------: | ------------: | -------: | -------: | -------: | -------: | ------: | -----------: | ------- |
| health         | `GET /v1/health`                                   |    10 |   10 083 |       1 008,3 |      9,3 |       15 |     18,5 |     31,1 |  0,00 % |     < 500 ms | OK      |
| wallet-summary | `GET /v1/wallets/:org/summary`                     |    10 |    2 372 |         237,2 |     41,3 |     52,3 |     59,2 |     85,4 |  0,00 % |     < 500 ms | OK      |
| transactions   | `GET /v1/transactions?pageSize=20`                 |    10 |    2 731 |         273,1 |     35,7 |     49,3 |     57,8 |     88,2 |  0,00 % |     < 500 ms | OK      |
| fx-estimate    | `POST /v1/wallets/estimate`                        |    10 |    9 873 |         987,3 |      9,4 |     15,5 |       19 |       45 |  0,00 % |     < 500 ms | OK      |
| transfers      | `GET /v1/transfers?pageSize=20`                    |    10 |    3 639 |         363,9 |     26,6 |     37,7 |     44,1 |     57,8 |  0,00 % |     < 500 ms | OK      |
| ledger-write   | `POST /v1/sandbox/wallets/self-deposit` (0,01 CAD) |     1 |      315 |          31,5 |       31 |     41,3 |     45,8 |     51,7 |  0,00 % |     < 100 ms | OK      |

### 4.2 Condition du PRD : 100 000 transactions (configuration PostgreSQL par défaut)

| Scénario       | Requête                                            | Conn. | Requêtes | Débit (req/s) | p50 (ms) |  p95 (ms) | p99 (ms) | max (ms) | Erreurs | Objectif p95 | Verdict   |
| -------------- | -------------------------------------------------- | ----: | -------: | ------------: | -------: | --------: | -------: | -------: | ------: | -----------: | --------- |
| health         | `GET /v1/health`                                   |    10 |    8 133 |         813,3 |       11 |      20,8 |     29,4 |    247,7 |  0,00 % |     < 500 ms | OK        |
| wallet-summary | `GET /v1/wallets/:org/summary`                     |    10 |      652 |          65,2 |    149,5 |     194,8 |    215,9 |    254,7 |  0,00 % |     < 500 ms | OK        |
| transactions   | `GET /v1/transactions?pageSize=20`                 |    10 |       80 |             8 |  1 163,6 | **1 672** |  2 211,1 |  2 211,1 |  0,00 % |     < 500 ms | **ÉCHEC** |
| fx-estimate    | `POST /v1/wallets/estimate`                        |    10 |    8 354 |         835,4 |     11,2 |        19 |     24,2 |     35,6 |  0,00 % |     < 500 ms | OK        |
| transfers      | `GET /v1/transfers?pageSize=20`                    |    10 |    3 108 |         310,8 |     31,4 |      44,4 |     51,5 |    127,5 |  0,00 % |     < 500 ms | OK        |
| ledger-write   | `POST /v1/sandbox/wallets/self-deposit` (0,01 CAD) |     1 |      215 |          21,5 |     45,6 |      58,8 |     64,4 |     66,8 |  0,00 % |     < 100 ms | OK        |

### 4.3 Même jeu, compilation JIT de PostgreSQL désactivée (`jit = off`)

Mesure de contrôle (base de test seulement, réglage annulé ensuite) pour valider le diagnostic du §5.1 :

| Scénario       | Requête                            | Conn. | Requêtes | Débit (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Erreurs | Objectif p95 | Verdict |
| -------------- | ---------------------------------- | ----: | -------: | ------------: | -------: | -------: | -------: | -------: | ------: | -----------: | ------- |
| wallet-summary | `GET /v1/wallets/:org/summary`     |    10 |      511 |          51,1 |    190,7 |    269,6 |    289,3 |    315,8 |  0,00 % |     < 500 ms | OK      |
| transactions   | `GET /v1/transactions?pageSize=20` |    10 |      348 |          34,8 |    276,1 |    395,5 |    450,6 |    482,1 |  0,00 % |     < 500 ms | OK      |

## 5. Comparaison avec les objectifs et constats

### 5.1 Liste des transactions sur 100 000 lignes : objectif **non atteint** en configuration par défaut

- Mesure : p95 **1 672 ms** pour 500 ms visés (8 req/s). Une requête isolée prend déjà ~310 ms.
- Cause : le périmètre « mes transactions » combine acheteur, vendeur **et** « partie vendeuse » (`parties: { some: { role: SELLER, userId } }`). Prisma le traduit en `EXISTS (…)` corrélé, dont le coût estimé (≈ 824 000) dépasse `jit_above_cost` : PostgreSQL **compile en JIT** la requête de page et le `COUNT(*)` à chaque appel, soit ~130 ms de compilation par requête (mesuré par `EXPLAIN ANALYZE` : 171 ms avec JIT, 22 ms sans pour le comptage). Sous 10 connexions, la compilation sature les 4 vCPU.
- Contre-mesure validée (§4.3) : `jit = off` ramène le p95 à **395 ms** (objectif tenu, sans marge confortable : chaque appel parcourt encore 100 000 lignes deux fois, pour le tri par `updatedAt` et pour le comptage).
- Recommandations (hors périmètre de ce chantier, à arbitrer) : (1) désactiver le JIT pour le rôle ou la base de l'API (`ALTER ROLE … SET jit = off`), standard pour une charge transactionnelle ; (2) réécrire le périmètre en sous-requête non corrélée (identifiants de transactions où l'utilisateur est partie vendeuse, puis `id IN (…)`) ; (3) index `("buyerOrganizationId", "updatedAt")` et `("sellerOrganizationId", "updatedAt")` pour servir `ORDER BY updatedAt LIMIT 20` sans tri complet ; (4) total approximatif ou plafonné au-delà de quelques milliers de lignes.

### 5.2 Synthèse du portefeuille : coût proportionnel aux dépôts du jour

- La synthèse reste sous l'objectif mais se dégrade au fil des mesures : p50 41 ms → 150 ms → 191 ms à mesure que le scénario d'écriture accumule des dépôts (≈ 670 dépôts sandbox du jour pour l'organisation).
- Cause : le plafond quotidien de dépôt (`WalletsService.selfDepositUsage`) charge **toutes** les écritures de dépôt du jour, avec leurs lignes, pour chacune des cinq devises (≈ 40 ms pour 670 dépôts en CAD).
- Recommandation : calculer le montant utilisé par une agrégation SQL (`SUM` sur `LedgerEntry` joint à `LedgerTransaction`) ; même constat, plus atténué, pour l'écriture elle-même (p95 41 → 59 ms entre les deux séries).

### 5.3 Concurrence : invariants monétaires tenus, une course de création identifiée

- Les six scénarios du §2.3 passent de façon répétée (trois exécutions consécutives) : plafond jamais dépassé, aucun solde négatif, aucune facture surpayée, une seule libération, registre réconcilié sans écart.
- Course identifiée : la **première** utilisation concurrente d'un portefeuille (ou du premier compte `FX_CLEARING` d'une devise) peut être refusée par `409 CONFLICT « Resource already exists »` : `WalletsService.ensureWallet` crée le compte de registre puis le portefeuille sans tolérer la création concurrente (violation d'unicité sur `LedgerAccount.code`). Lors d'une mesure, 4 des 10 premiers dépôts simultanés ont été refusés ainsi. Aucun argent n'est mal comptabilisé (la requête refusée n'écrit rien) mais le client reçoit une erreur alors que l'opération est légitime. Recommandation : création idempotente (`INSERT … ON CONFLICT DO NOTHING` puis relecture, par exemple `createMany({ skipDuplicates: true })`), qui ne fait pas échouer la transaction englobante.

### 5.4 Écriture ledger

Objectif tenu : p95 41 ms (série 4.1) puis 59 ms (série 4.2) sur une connexion, pour un dépôt complet (authentification, contrôle du plafond, verrou du portefeuille, écriture équilibrée, audit, notification) — borne supérieure du seul coût d'écriture du registre.

## 6. Limites de la mesure

- **Même machine** pour l'injecteur, l'API et PostgreSQL : les trois se disputent 4 vCPU, ce qui pénalise surtout les scénarios lourds en base ; aucune latence réseau n'est mesurée.
- **Durées courtes** (10 s par scénario, 2 s de chauffe) : utiles pour comparer des versions, insuffisantes pour observer des effets de cache, de vacuum ou de fuite mémoire.
- **Une instance d'API**, lancée par `ts-node` (transpilation à la volée) et non par le bundle compilé ; pas de TLS, pas de proxy Next.js : les requêtes atteignent l'API directement.
- **Clients simulés par `X-Forwarded-For`** : valable parce que l'API fait confiance à un proxy (`trust proxy = 1`). Conséquence de déploiement : l'API ne doit être joignable **que** derrière ce proxy, sinon un client pourrait choisir son adresse et contourner la limitation de débit par IP.
- **Données synthétiques** : 100 000 transactions sans parties, jalons ni écritures, toutes rattachées à une seule organisation acheteuse ; aucun volume équivalent pour les transferts, factures ou écritures du registre. Les plans d'exécution réels dépendront de la distribution des données.
- Les journeys Playwright ne sont pas des mesures de performance ; la limitation à 5 inscriptions par minute et par IP impose d'ailleurs un seul worker (`apps/web/playwright.config.ts`).

## 7. Reproduire

```bash
# API sandbox sur un port libre, base de test seedée (voir README, « Données de démonstration étendues (phase 6) »)
cd dfn/apps/api
BASE_URL=http://localhost:4100 pnpm test:load                                   # 5 lectures, 10 conn., 10 s chacune
BASE_URL=http://localhost:4100 LOAD_WRITES=1 LOAD_JSON=/tmp/load.json pnpm test:load   # + écriture ledger, JSON brut
BASE_URL=http://localhost:4100 LOAD_CLIENT_MODE=single LOAD_ONLY=health pnpm test:load  # vérifie la limitation (échec attendu)

# Jeu de 100 000 transactions (base de test uniquement), puis nettoyage
DATABASE_URL=postgresql://…/dfn_test_seed node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  test/load/bulk-transactions.ts --email moussa@demo.dfn --count 100000
DATABASE_URL=postgresql://…/dfn_test_seed node -r ts-node/register/transpile-only -r tsconfig-paths/register \
  test/load/bulk-transactions.ts --email moussa@demo.dfn --cleanup

# Tests de concurrence (base de test dédiée, vidée par le test)
TEST_DATABASE_URL=postgresql://…/dfn_test_seed ./node_modules/.bin/vitest run test/concurrency.test.ts
```
