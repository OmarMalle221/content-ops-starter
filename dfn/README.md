# Diaspora Financial Network (DFN) — « Diaspora Trust »

> **The trusted financial infrastructure connecting Africa and its global diaspora.**
>
> ⚠️ **Sandbox uniquement — Données fictives — Aucun fonds réel.** Aucun transfert réel, aucune émission d'actif, aucun service réglementé n'est activé. Les vérifications d'identité sont _simulées_ et affichées comme telles. Les cotations FX, règlements de transferts, paiements de factures et unités DDA sont des simulations.

Monorepo pnpm : **Next.js 15** (web) · **NestJS 11** (API REST + OpenAPI) · **PostgreSQL 16 / Prisma 6** · **Redis / BullMQ** (optionnel) · registre comptable à double entrée · partenaires simulés (paiement, FX, KYC).

| Document                                                                    | Contenu                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)                          | vision, personas, six modules, workflows, critères d'acceptation                                                        |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [docs/architecture](docs/architecture) | monolithe modulaire, flux Protect, registre, tâches planifiées, simulation DDA                                          |
| [DATA_MODEL.md](DATA_MODEL.md)                                              | 51 tables, invariants, conservation et anonymisation                                                                    |
| [SECURITY.md](SECURITY.md) · [docs/security](docs/security)                 | security-by-design, clés API, webhooks, idempotence                                                                     |
| [ROADMAP.md](ROADMAP.md)                                                    | phases 0–6, état d'avancement, rapport de livraison                                                                     |
| [docs/api](docs/api)                                                        | guide API partenaires + `openapi.json`                                                                                  |
| [docs/compliance](docs/compliance)                                          | checklists CANAFE, Banque du Canada, AMF Québec, BCEAO, BCRG, KYC/KYB, AML, données, litiges, stablecoin, autorisations |
| [docs/decisions](docs/decisions)                                            | ADR 0001–0008                                                                                                           |

## Ce qui est livré (phases 0 à 5, sandbox)

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

Non livré (voir ROADMAP, phase 6) : fournisseurs KYC / FX agréés (interfaces seulement), passkeys, stockage objet, build compilé, tests de charge, **relecture juridique des checklists de conformité** (tâche humaine).

## Démarrage rapide

### Prérequis

Node.js ≥ 22, pnpm ≥ 10 (`corepack enable`), PostgreSQL 16 et Redis 7 (ou Docker).

### Option A — Docker Compose (tout-en-un)

```bash
cd dfn
cp .env.example .env            # puis remplacer SESSION_SECRET et DOCUMENT_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up --build       # web http://localhost:3000 — API http://localhost:4000/docs
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

Les variables de `.env` sont lues par l'API ; le web lit `API_INTERNAL_URL` (défaut `http://localhost:4000`). Les variables des phases 3–5 (`JOBS_*`, `ANONYMIZE_AFTER_DAYS`, `FX_*`, `SANDBOX_SELF_DEPOSIT_DAILY_LIMIT`, `WEBHOOK_*`, `IDEMPOTENCY_TTL_HOURS`) sont documentées dans `.env.example`.

### Comptes de démonstration (seed)

| Compte                | Rôle                                            |
| --------------------- | ----------------------------------------------- |
| `admin@demo.dfn`      | ADMIN                                           |
| `compliance@demo.dfn` | COMPLIANCE                                      |
| `moussa@demo.dfn`     | acheteur (Montréal)                             |
| `awa@demo.dfn`        | vendeuse, propriétaire de « Dakar Auto Import » |
| `ibrahima@demo.dfn`   | membre de « Dakar Auto Import »                 |

Mot de passe : `Demo-Sandbox-2026!Protect` (ou `SEED_DEMO_PASSWORD`). Comptes sandbox : à régénérer avant tout déploiement partagé ; activez la MFA depuis _Paramètres_.

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

| Commande                                | Effet                                                                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` / `pnpm lint`          | TypeScript strict sur tous les paquets, ESLint (API et web)                                                                                                                                                           |
| `pnpm test:unit`                        | tests unitaires des paquets (money, machines à états, schémas, règles de risque, adaptateurs, FX, contrats) + **tests du registre contre PostgreSQL** (`TEST_DATABASE_URL`)                                           |
| `pnpm test:api`                         | tests d'intégration NestJS + supertest : auth, gouvernance, **Protect (2 scénarios obligatoires)**, wallet, tâches et anonymisation, transferts, business, API partenaires (clés, scopes, idempotence, webhooks), DDA |
| `pnpm test:e2e`                         | Playwright (web + API en cours d'exécution)                                                                                                                                                                           |
| `pnpm --filter @dfn/api openapi:export` | régénère `docs/api/openapi.json`                                                                                                                                                                                      |
| `pnpm format` / `pnpm format:check`     | Prettier                                                                                                                                                                                                              |

Tests exécutés dans cette itération : 53 tests unitaires/ledger, 108 tests d'intégration API, 3 tests Playwright — tous verts (rapport de livraison dans `ROADMAP.md` §12).

## Déploiement sandbox

`docs/architecture` et `docker-compose.yml` décrivent le déploiement : quatre conteneurs (`api`, `web`, `postgres`, `redis`). Avant tout environnement partagé : secrets uniques, `COOKIE_SECURE=true` derrière TLS, `CORS_ORIGINS` et `WEB_PUBLIC_URL` réels, sauvegardes PostgreSQL testées, stockage des documents sur un volume chiffré (adaptateur S3 prévu), une seule réplique de l'API tant que le planificateur est en mémoire. **Aucun déploiement en production n'est autorisé sans validation juridique et contractuelle** (voir `docs/compliance/AUTHORIZATIONS_CHECKLIST.md`).

## Structure

```
apps/api  apps/web  packages/{shared,database,financial-ledger,compliance,payment-adapters,contracts,ui}  docs/
```

Le dépôt hôte contient aussi `trustcargo-pay/` (MVP antérieur, indépendant) et le starter Netlify d'origine ; DFN n'en dépend pas.
