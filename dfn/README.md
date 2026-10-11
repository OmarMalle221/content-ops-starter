# Diaspora Financial Network (DFN) — « Diaspora Trust »

> **The trusted financial infrastructure connecting Africa and its global diaspora.**
>
> ⚠️ **Sandbox uniquement — Données fictives — Aucun fonds réel.** Aucun transfert réel, aucune émission d'actif, aucun service réglementé n'est activé. Les vérifications d'identité sont _simulées_ et affichées comme telles.

Monorepo pnpm : **Next.js 15** (web) · **NestJS 11** (API REST + OpenAPI) · **PostgreSQL 16 / Prisma 6** · **Redis / BullMQ** · registre comptable à double entrée · partenaire de paiement simulé.

| Document                                                                    | Contenu                                                                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [PRODUCT_REQUIREMENTS.md](PRODUCT_REQUIREMENTS.md)                          | vision, personas, six modules, workflows, critères d'acceptation                                                        |
| [ARCHITECTURE.md](ARCHITECTURE.md) · [docs/architecture](docs/architecture) | monolithe modulaire, flux Protect, registre                                                                             |
| [DATA_MODEL.md](DATA_MODEL.md)                                              | 41 tables, invariants, conservation                                                                                     |
| [SECURITY.md](SECURITY.md) · [docs/security](docs/security)                 | security-by-design                                                                                                      |
| [ROADMAP.md](ROADMAP.md)                                                    | phases 0–5, état d'avancement                                                                                           |
| [docs/api](docs/api)                                                        | guide API + `openapi.json`                                                                                              |
| [docs/compliance](docs/compliance)                                          | checklists CANAFE, Banque du Canada, AMF Québec, BCEAO, BCRG, KYC/KYB, AML, données, litiges, stablecoin, autorisations |
| [docs/decisions](docs/decisions)                                            | ADR 0001–0008                                                                                                           |

## Ce qui est livré (phases 0, 1, 2 + noyau ledger)

- **Fondations** : inscription/connexion, sessions serveur en cookie httpOnly, verrouillage après 5 échecs, **MFA TOTP**, organisations personnelles/entreprises, rôles, invitations, **journal d'audit**, notifications, design system, navigation FR/EN.
- **Diaspora Protect (P0)** : transactions à jalons, invitation du vendeur, **contrat numérique versionné et haché**, acceptation des conditions, **KYC/KYB simulées**, demande de financement, **partenaire simulé** confirmant la réception des fonds fictifs, documents **chiffrés au repos**, soumission/validation des preuves, **libérations fictives** jalon par jalon, **litiges avec gel automatique des libérations**, décisions motivées, appel, remboursement, historique complet.
- **Registre à double entrée** (`@dfn/financial-ledger`) : BigInt, idempotence, verrous, contrepassation, réconciliation — avec tests de concurrence.
- **Portefeuille** (lecture) : soldes CAD/USD/EUR/XOF/GNF dérivés du registre, historique, relevé CSV.
- **Conformité** : moteur de règles explicable (8 règles), alertes, file de revue, historique des décisions ; interfaces prêtes pour des fournisseurs KYC/sanctions.
- **Administration** : utilisateurs, vérifications, litiges, anomalies, journal d'audit, registre + réconciliation.

Non livré (voir ROADMAP) : écrans Transfer (phase 4), facturation Business (phase 4), API partenaires et DDA (phase 5).

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
pnpm db:generate && pnpm db:migrate:dev --name init   # ou pnpm db:migrate si les migrations existent déjà
pnpm db:seed
pnpm dev                        # API :4000 (ts-node --watch) + web :3000 (next dev)
```

Les variables de `.env` sont lues par l'API ; le web lit `API_INTERNAL_URL` (défaut `http://localhost:4000`).

### Comptes de démonstration (seed)

| Compte                | Rôle                                            |
| --------------------- | ----------------------------------------------- |
| `admin@demo.dfn`      | ADMIN                                           |
| `compliance@demo.dfn` | COMPLIANCE                                      |
| `moussa@demo.dfn`     | acheteur (Montréal)                             |
| `awa@demo.dfn`        | vendeuse, propriétaire de « Dakar Auto Import » |
| `ibrahima@demo.dfn`   | membre de « Dakar Auto Import »                 |

Mot de passe : `Demo-Sandbox-2026!Protect` (ou `SEED_DEMO_PASSWORD`). Comptes sandbox : à régénérer avant tout déploiement partagé ; activez la MFA depuis _Paramètres_.

## Scénario de démonstration (bout en bout)

1. Connectez-vous comme `moussa@demo.dfn` → _Nouvelle transaction_ (vendeur : `awa@demo.dfn`, deux jalons).
2. Copiez le lien d'invitation, connectez-vous comme `awa@demo.dfn` dans une autre fenêtre, acceptez.
3. Les deux parties acceptent les conditions ; la vérification simulée est déjà faite pour les comptes seedés.
4. Acheteur : _Demander les instructions de financement_ puis _Simuler la confirmation du partenaire_.
5. Vendeuse : _Ajouter un document_ (connaissement) puis _Soumettre les preuves_.
6. Acheteur : _Valider et libérer (fictif)_ — le portefeuille sandbox de Dakar Auto Import est crédité.
7. Variante litige : _Ouvrir une contestation_ → les libérations sont gelées ; `compliance@demo.dfn` prend en charge et rend une décision motivée dans _Administration › Litiges_.

## Commandes

| Commande                                | Effet                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm typecheck` / `pnpm lint`          | TypeScript strict sur tous les paquets, ESLint (API et web)                                                                                                                          |
| `pnpm test:unit`                        | tests unitaires des paquets (money, machines à états, schémas, règles de risque, adaptateurs, contrats) + **tests du registre contre PostgreSQL** (`TEST_DATABASE_URL`)              |
| `pnpm test:api`                         | tests d'intégration NestJS + supertest (auth, MFA, CSRF, RBAC, isolation multi-tenant, **scénario 1 clôture complète**, **scénario 2 litige avec gel**, course d'approbation, admin) |
| `pnpm test:e2e`                         | Playwright (web + API en cours d'exécution)                                                                                                                                          |
| `pnpm --filter @dfn/api openapi:export` | régénère `docs/api/openapi.json`                                                                                                                                                     |
| `pnpm format` / `pnpm format:check`     | Prettier                                                                                                                                                                             |

Tests exécutés dans cette itération : 41 tests unitaires/ledger, 20 tests d'intégration API, 2 tests Playwright — tous verts (voir le rapport de livraison dans ROADMAP.md).

## Déploiement sandbox

`docs/architecture` et `docker-compose.yml` décrivent le déploiement : trois conteneurs (`api`, `web`, `postgres`, `redis`). Avant tout environnement partagé : secrets uniques, `COOKIE_SECURE=true` derrière TLS, `CORS_ORIGINS` et `WEB_PUBLIC_URL` réels, sauvegardes PostgreSQL testées, stockage des documents sur un volume chiffré (adaptateur S3 prévu). **Aucun déploiement en production n'est autorisé sans validation juridique et contractuelle** (voir `docs/compliance/AUTHORIZATIONS_CHECKLIST.md`).

## Structure

```
apps/api  apps/web  packages/{shared,database,financial-ledger,compliance,payment-adapters,contracts,ui}  docs/
```

Le dépôt hôte contient aussi `trustcargo-pay/` (MVP antérieur, indépendant) et le starter Netlify d'origine ; DFN n'en dépend pas.
