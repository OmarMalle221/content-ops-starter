# Diaspora Financial Network (DFN) — « Diaspora Trust »

> **The trusted financial infrastructure connecting Africa and its global diaspora.**
>
> ⚠️ **Sandbox uniquement — Données fictives — Aucun fonds réel.** Aucun transfert réel, aucune émission d'actif, aucun service réglementé n'est activé. Les vérifications d'identité sont _simulées_ et affichées comme telles. Les cotations FX, règlements de transferts, paiements de factures et unités DDA sont des simulations.

Monorepo pnpm : **Next.js 15** (web) · **NestJS 11** (API REST + OpenAPI) · **PostgreSQL 16 / Prisma 6** · **Redis / BullMQ** (optionnel) · registre comptable à double entrée · partenaires simulés (paiement, FX, KYC).

| Document                                                                    | Contenu                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)                          | vision, personas, six modules, workflows, critères d'acceptation                                                        |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [docs/architecture](docs/architecture) | monolithe modulaire, flux Protect, registre, tâches planifiées, simulation DDA                                          |
| [DATA_MODEL.md](DATA_MODEL.md)                                              | 57 tables, invariants, conservation et anonymisation                                                                    |
| [SECURITY.md](SECURITY.md) · [docs/security](docs/security)                 | security-by-design, clés API, webhooks, idempotence                                                                     |
| [ROADMAP.md](ROADMAP.md)                                                    | phases 0–7, état d'avancement, rapports de livraison                                                                    |
| [docs/operations](docs/operations)                                          | exploitation : runbook, rotation des clés, performances mesurées                                                        |
| [docs/api](docs/api)                                                        | guide API partenaires + `openapi.json`                                                                                  |
| [docs/compliance](docs/compliance)                                          | checklists CANAFE, Banque du Canada, AMF Québec, BCEAO, BCRG, KYC/KYB, AML, données, litiges, stablecoin, autorisations |
| [docs/decisions](docs/decisions)                                            | ADR 0001–0013                                                                                                           |

## Ce qui est livré (phases 0 à 6, sandbox)

- **Fondations** : inscription/connexion, sessions serveur en cookie httpOnly, verrouillage après 5 échecs, **MFA TOTP**, organisations personnelles/entreprises, rôles, invitations, **journal d'audit**, notifications, design system, navigation FR/EN.
- **Diaspora Protect (P0)** : transactions à jalons, invitation du vendeur, **contrat numérique versionné et haché**, acceptation des conditions, **KYC/KYB simulées**, demande de financement, **partenaire simulé** confirmant la réception des fonds fictifs, documents **chiffrés au repos**, soumission/validation des preuves, **libérations fictives** jalon par jalon, **litiges avec gel automatique des libérations**, décisions motivées, appel, remboursement, historique complet.
- **Registre à double entrée** (`@dfn/financial-ledger`) : BigInt, idempotence, verrous, contrepassation, instantanés, réconciliation — avec tests de concurrence.
- **Diaspora Wallet (P1)** : soldes CAD/USD/EUR/XOF/GNF dérivés du registre par espace, historique filtrable, relevé CSV, estimateur FX, **bénéficiaires** (identifiants masqués), dépôt sandbox plafonné, **préférences de sécurité** (MFA pour les transferts, plafond quotidien).
- **Diaspora Transfer (P1)** : cotation FX **simulée** avec expiration, parcours `QUOTED → AUTHORIZED → PROCESSING → SETTLED/FAILED`, **revue conformité** (`REVIEW_REQUIRED`) alimentée par le moteur de risque, écritures en deux jambes via `FX_CLEARING`, règlement par partenaire simulé, reçus.
- **Diaspora Business (P1)** : factures et devis numérotés (`INV-2026-0001`, `QUO-2026-0001`), envoi aux contreparties, paiements fictifs (dont par portefeuille, écriture ledger), échéances, conversion devis → facture, documents imprimables, **rapports par période** et exports CSV.
- **Tâches planifiées** : instantanés de solde, **réconciliation**, expirations, traitement des transferts, relances webhooks, factures en retard, **anonymisation des comptes supprimés** (délai configurable) — console `/admin/jobs`.
- **API partenaires (P2)** : clés `dfn_sk_…` hachées, **10 scopes**, limitation de débit par clé, **`Idempotency-Key`**, **webhooks signés HMAC-SHA256** avec tentatives exponentielles et anti-SSRF, console `/developers`, OpenAPI.
- **DDA (P3, recherche interne)** : simulation d'unités fictives (mint / transfer / redeem), réserve déclarative, couverture, stress test — **administrateurs uniquement**, enveloppe `simulated: true` sur chaque réponse, aucune convertibilité.
- **Conformité** : moteur de règles explicable (13 règles dont 5 pour les transferts), alertes, file de revue, historique des décisions ; interfaces prêtes pour des fournisseurs KYC/sanctions agréés.
- **Administration** : utilisateurs, vérifications, litiges, anomalies, transferts, tâches, journal d'audit, registre + réconciliation, laboratoire DDA.

- **Phase 6 — durcissement** : **passkeys** (connexion sans mot de passe, vérification renforcée), anti-rejeu TOTP et **codes de secours**, **trousseau de clés** par usage avec rotation, **stockage chiffré local ou compatible S3**, **tâches distribuées** (baux, BullMQ) et limites de débit Redis, **files de revue conformité** (échéances, assignation, export) et détection du **fractionnement**, **registre des portes réglementaires** (suivi uniquement, quatre yeux), **adaptateurs partenaires de référence** jamais activables en sandbox, personnel en lecture seule dans les espaces clients, **liens clients soumis à acceptation**, **build compilé**, conteneurs durcis, **sauvegarde/restauration testées**, tests de charge et 9 parcours Playwright.

Non livré (voir ROADMAP, phase 7) : contrats et intégration de fournisseurs agréés, KMS, audit de sécurité indépendant, observabilité, essai contre un vrai service S3 et surtout la **relecture juridique des checklists de conformité** (tâche humaine).

## Démarrage rapide

### Prérequis

Node.js ≥ 22, pnpm ≥ 10 (`corepack enable`), PostgreSQL 16 et Redis 7 (ou Docker).

### Option A — Docker Compose (tout-en-un)

```bash
cd dfn
cp .env.example .env            # puis remplacer SESSION_SECRET et DOCUMENT_ENCRYPTION_KEY (openssl rand -hex 32)
# + POSTGRES_PASSWORD et REDIS_PASSWORD (voir docs/operations/RUNBOOK.md)
docker compose up --build       # migrations, API compilée, web — http://localhost:3000, API http://localhost:4000/docs
docker compose --profile seed run --rm seed   # comptes et transactions de démonstration
```

### Option B — local

```bash
cd dfn
cp .env.example .env            # adapter DATABASE_URL / REDIS_URL / secrets
pnpm install
pnpm db:generate && pnpm db:migrate          # applique les migrations existantes
pnpm db:seed
pnpm dev                        # API :4000 (ts-node --watch) + web :3000 (next dev)
```

Les variables de `.env` sont lues par l'API ; le web lit `API_INTERNAL_URL` (défaut `http://localhost:4000`), **figée au moment de `next build`** (réécritures `/api/*`). Les variables des phases 3 à 6 (`JOBS_*`, `ANONYMIZE_AFTER_DAYS`, `FX_*`, `SANDBOX_SELF_DEPOSIT_DAILY_LIMIT`, `WEBHOOK_*`, `IDEMPOTENCY_TTL_HOURS`, `ENCRYPTION_KEYRING`, `STORAGE_DRIVER`/`S3_*`, `WEBAUTHN_*`, `JOBS_DRIVER`, `RATE_LIMIT_STORE`, `TRUST_PROXY`, `REQUIRE_STAFF_MFA`, `REVIEW_SLA_HOURS_*`, `STRUCTURING_*`) sont documentées dans `.env.example`.

### Comptes de démonstration (seed)

| Compte                | Rôle                                            |
| --------------------- | ----------------------------------------------- |
| `admin@demo.dfn`      | ADMIN                                           |
| `compliance@demo.dfn` | COMPLIANCE                                      |
| `moussa@demo.dfn`     | acheteur (Montréal)                             |
| `awa@demo.dfn`        | vendeuse, propriétaire de « Dakar Auto Import » |
| `ibrahima@demo.dfn`   | membre de « Dakar Auto Import »                 |

Mot de passe : `Demo-Sandbox-2026!Protect` (ou `SEED_DEMO_PASSWORD`). Comptes sandbox : à régénérer avant tout déploiement partagé ; activez la MFA depuis _Paramètres_.

### Données de démonstration étendues (phase 6)

Le seed (`pnpm db:seed`, soit `pnpm --filter @dfn/database seed`) ajoute un jeu complet pour parcourir Wallet, Transfer, Business, l'API partenaires et la file de conformité. Tout est **fictif** (« Données fictives — Aucun fonds réel ») et **idempotent** : chaque enregistrement est retrouvé par une clé de seed, chaque écriture comptable porte une clé d'idempotence fixe ; relancer le seed ne crée aucune donnée métier de plus (seuls une entrée d'audit `system.seed` et un rapport de réconciliation s'ajoutent à chaque exécution). Les soldes ne sont jamais stockés : ils découlent d'écritures équilibrées passées par `LedgerService`, et le seed se termine par `LedgerService.reconcile()` — il échoue au moindre écart ou à la moindre transaction déséquilibrée.

| Domaine                      | Données créées                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portefeuilles                | dépôts sandbox : `moussa@demo.dfn` +10 000,00 CAD et +800,00 EUR, « Dakar Auto Import » +2 500 000 XOF. Soldes après seed : Moussa **11 238,39 CAD · 800,00 EUR** ; Dakar Auto Import **24 500,00 CAD · 2 500 000 XOF**                                                                                                                                                                                                                                                                                     |
| Bénéficiaires (Moussa)       | « Awa Diop (démo) » (Sénégal, XOF, compte bancaire), « Mame Diarra Sarr (démo) » (Sénégal, XOF, mobile money), « Mamadou Bah (démo) » (Guinée, GNF, mobile money) — identifiants chiffrés, seule la forme masquée `••••1234` est affichée                                                                                                                                                                                                                                                                   |
| Transferts (Moussa)          | `DFT-<année>-DEMO01` **SETTLED** (300,00 CAD → Awa Diop), `DEMO02` **PROCESSING** (450,00 CAD → Mame Diarra Sarr ; la tâche `TRANSFER_PROCESSING` ou le bouton _Simuler le règlement du partenaire_ le règle), `DEMO03` **REVIEW_REQUIRED** (9 400,00 CAD → Mamadou Bah, score 65 : structuration + bénéficiaire récent ; rien n'est débité avant la revue) — mêmes écritures que l'API : portefeuille → `FX_CLEARING` + `PLATFORM_FEES`, puis `FX_CLEARING` → règlement partenaire pour le transfert réglé |
| Conformité                   | deux alertes sur `DEMO03`, **assignées à `compliance@demo.dfn`** : `STRUCTURING` (HIGH, échéance 24 h, ouverte) et `NEW_BENEFICIARY_HIGH_VALUE` (MEDIUM, échéance 72 h, en revue) — _Administration › Anomalies_ (`/admin/risk`)                                                                                                                                                                                                                                                                            |
| Business (Dakar Auto Import) | client « Moussa Ndiaye » **lié** à l'espace de Moussa (lien `ACCEPTED`) ; factures `INV-<année>-0001` brouillon (TVA 18 %), `0002` envoyée, `0003` partiellement payée (500,00 CAD payés depuis le portefeuille de Moussa, écriture au registre), `0004` payée (virement fictif enregistré) ; devis `QUO-<année>-0001` brouillon, `0002` envoyé, `0003` accepté (prêt à convertir) — taux de taxe (`taxBps`) enregistré                                                                                     |
| API partenaires              | clé sandbox « Clé sandbox de démonstration (seed) » de Dakar Auto Import (lecture seule, 60 req/min, 90 jours) : **le secret `dfn_sk_…` n'est affiché qu'une fois dans la console du seed** (seul son hachage SHA-256 est stocké ; à la relance, seul le préfixe est rappelé — faire tourner la clé depuis _Développeurs_ si besoin) ; webhook **désactivé** vers `https://example.invalid/webhooks` (domaine réservé, jamais joignable)                                                                    |

Le seed chiffre les identifiants de bénéficiaires et le secret du webhook comme l'API : `DOCUMENT_ENCRYPTION_KEY` (et `ENCRYPTION_KEYRING` s'il est utilisé) doivent avoir **les mêmes valeurs que pour l'API**. Les variables absentes de l'environnement sont lues dans le `.env` à la racine du monorepo ; sans clé disponible, bénéficiaires, transferts, alertes et webhook sont ignorés avec un avertissement (le reste est créé).

```bash
DATABASE_URL=postgresql://…/dfn pnpm --filter @dfn/database seed   # deux exécutions successives : la seconde n'ajoute rien
```

Parcours suggérés : `moussa@demo.dfn` → _Portefeuille_ (soldes, filtres, relevé CSV) puis _Transferts_ (`DEMO02` à régler, `DEMO03` en revue) ; `compliance@demo.dfn` → _Administration › Anomalies_ (`/admin/risk`) et _Administration › Transferts_ (approuver ou rejeter `DEMO03`) ; `awa@demo.dfn` → _Business_ (facture partiellement payée, devis à convertir) et _Développeurs_. Les journeys Playwright de la phase 6 (`apps/web/e2e/{wallet,transfers,business,developers}.spec.ts`) rejouent ces écrans avec des comptes neufs ; les tests de charge et de concurrence sont décrits dans [docs/operations/PERFORMANCE.md](docs/operations/PERFORMANCE.md).

## Scénarios de démonstration

**Protect (bout en bout)**

1. Connectez-vous comme `moussa@demo.dfn` → _Nouvelle transaction_ (vendeur : `awa@demo.dfn`, deux jalons).
2. Copiez le lien d'invitation, connectez-vous comme `awa@demo.dfn` dans une autre fenêtre, acceptez.
3. Les deux parties acceptent les conditions ; la vérification simulée est déjà faite pour les comptes seedés.
4. Acheteur : _Demander les instructions de financement_ puis _Simuler la confirmation du partenaire_.
5. Vendeuse : _Ajouter un document_ (connaissement) puis _Soumettre les preuves_.
6. Acheteur : _Valider et libérer (fictif)_ — le portefeuille sandbox de Dakar Auto Import est crédité.
7. Variante litige : _Ouvrir une contestation_ → les libérations sont gelées ; `compliance@demo.dfn` prend en charge et rend une décision motivée dans _Administration › Litiges_.

**Wallet et Transfer**

1. _Portefeuille_ → _Dépôt sandbox_ (fonds fictifs) puis _Bénéficiaires_ → ajouter un bénéficiaire au Sénégal.
2. _Transferts_ → _Nouveau transfert_ : montant, devis simulé (compte à rebours), autorisation (MFA si activée).
3. Le transfert passe en `PROCESSING` ; la tâche `TRANSFER_PROCESSING` (ou _Administration › Tâches_) le règle fictivement ; un montant élevé vers un nouveau bénéficiaire déclenche `REVIEW_REQUIRED` dans _Administration › Transferts_.

**Business et API**

1. Comme `awa@demo.dfn` : _Business › Factures_ → créer, envoyer à `moussa@demo.dfn`, enregistrer un paiement fictif ; _Rapports_ → période.
2. _Développeurs_ → créer une clé (`dfn_sk_…`, affichée une seule fois) et un webhook ; _Tester_ envoie un événement signé.

## Commandes

| Commande                                        | Effet                                                                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `pnpm lint`                  | TypeScript strict sur tous les paquets, ESLint (API et web)                                                                                                                                                           |
| `pnpm test:unit`                                | tests unitaires des paquets (money, machines à états, schémas, règles de risque, adaptateurs, FX, contrats) + **tests du registre contre PostgreSQL** (`TEST_DATABASE_URL`)                                           |
| `pnpm test:api`                                 | tests d'intégration NestJS + supertest : auth, gouvernance, **Protect (2 scénarios obligatoires)**, wallet, tâches et anonymisation, transferts, business, API partenaires (clés, scopes, idempotence, webhooks), DDA |
| `pnpm test:e2e`                                 | Playwright (web + API en cours d'exécution)                                                                                                                                                                           |
| `pnpm build:api` / `node apps/api/dist/main.js` | bundle compilé de l'API (tsup) et démarrage de production                                                                                                                                                             |
| `pnpm --filter @dfn/api test:load`              | tests de charge autocannon (`BASE_URL`), objectifs p95 du PRD                                                                                                                                                         |
| `pnpm ops:backup` / `pnpm ops:restore-test`     | sauvegarde chiffrable et exercice de restauration avec réconciliation du registre                                                                                                                                     |
| `pnpm --filter @dfn/api openapi:export`         | régénère `docs/api/openapi.json`                                                                                                                                                                                      |
| `pnpm format` / `pnpm format:check`             | Prettier                                                                                                                                                                                                              |

Tests exécutés à la fin de la phase 6 : 156 tests unitaires de paquets, 230 tests d'intégration API, 9 parcours Playwright, exercice de restauration et tests de charge — tous verts (rapport de livraison dans `ROADMAP.md` §13).

## Déploiement sandbox

`docker-compose.yml` décrit la pile : `postgres`, `redis`, une tâche `migrate` exécutée avant l'API, l'`api` compilée (utilisateur non root, système de fichiers en lecture seule), le `web`, et en option `minio` (profil `s3`) et `seed` (profil `seed`). La procédure complète (secrets, mise à l'échelle, sauvegardes, exercice de restauration, incidents) est dans `docs/operations/RUNBOOK.md`. Avant tout environnement partagé : secrets uniques, `ENCRYPTION_KEYRING` renseigné, `COOKIE_SECURE=true` derrière TLS, `CORS_ORIGINS`, `WEB_PUBLIC_URL` et `WEBAUTHN_*` réels, `REQUIRE_STAFF_MFA=true`, API publiée sur la boucle locale ou derrière un proxy déclaré dans `TRUST_PROXY`, et pour plusieurs réplicas `JOBS_DRIVER=bullmq`, `RATE_LIMIT_STORE=redis`, `STORAGE_DRIVER=s3`. **Aucun déploiement en production n'est autorisé sans validation juridique et contractuelle** (voir `docs/compliance/AUTHORIZATIONS_CHECKLIST.md` et `/admin/gates`).

## Structure

```
apps/api  apps/web  packages/{shared,database,financial-ledger,compliance,payment-adapters,contracts,ui}  docs/
```

Le dépôt hôte contient aussi `trustcargo-pay/` (MVP antérieur, indépendant) et le starter Netlify d'origine ; DFN n'en dépend pas.
