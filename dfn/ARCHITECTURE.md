# Architecture — Diaspora Financial Network (DFN)

> **Mode sandbox uniquement.** Données fictives — Aucun fonds réel. L'API refuse de démarrer si `DFN_MODE` ≠ `sandbox`.

## 1. Vue d'ensemble

DFN est un **monolithe modulaire** livré dans un monorepo pnpm. Deux applications déployables partagent des paquets de domaine typés :

```
dfn/
├── apps/
│   ├── web   — Next.js 15 (App Router, React 19, Tailwind, @dfn/ui)           port 3000
│   └── api   — NestJS 11 (REST /v1, OpenAPI /docs, sessions cookie)          port 4000
├── packages/
│   ├── shared            — enums, schémas zod (DTO), machines à états, monnaie, pays, RBAC
│   ├── database          — schéma Prisma, migrations, seed de démonstration
│   ├── financial-ledger  — registre comptable à double entrée (LedgerService)
│   ├── compliance        — interfaces KYC/KYB/sanctions + adaptateurs sandbox + moteur de règles explicable
│   ├── payment-adapters  — interface partenaire de paiement + adaptateur sandbox (jamais de fonds réels)
│   ├── contracts         — gabarits de contrat numérique, hachage canonique SHA-256
│   └── ui                — design system (composants shadcn-style, tokens Tailwind)
├── docs/{architecture,api,compliance,security,decisions}
├── docker-compose.yml, .env.example
└── *.md (PRODUCT_REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SECURITY, ROADMAP)
```

```
Navigateur ──(cookies 1st-party)──▶ Next.js (web) ──/api/* rewrite──▶ NestJS (api) ──Prisma──▶ PostgreSQL 16
                                      │ server components                 │
                                      └── fetch API_INTERNAL_URL ─────────┤── BullMQ ──▶ Redis (optionnel en dev)
                                                                          ├── stockage chiffré (AES-256-GCM, disque local)
                                                                          └── adaptateurs sandbox (KYC, sanctions, partenaire de paiement)
```

Le navigateur ne parle qu'à l'origine web : Next.js réécrit `/api/*` vers l'API, les cookies de session restent first-party (`SameSite=Lax`, `httpOnly`). Les composants serveur appellent l'API directement avec le cookie transmis.

## 2. Modules de l'API (`apps/api/src/modules`)

| Module                                          | Rôle                                                                                                    | Dépend de                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `auth`                                          | inscription, connexion, sessions en base, MFA TOTP, mot de passe, verrouillage                          | users, organizations, audit, risk                    |
| `users`                                         | profil, contexte d'authentification                                                                     | audit                                                |
| `organizations`                                 | espaces personnels / entreprises, membres, invitations, KYB simulée, contreparties                      | compliance (KYB), audit, notifications               |
| `verifications`                                 | KYC simulée, filtrage sanctions simulé, file de revue staff                                             | compliance, audit, notifications                     |
| `transactions`                                  | **Diaspora Protect** : création, invitations, contrat, acceptation, annulation, jalons                  | contracts, payments, risk, audit, notifications      |
| `payments`                                      | orchestration du partenaire simulé + écritures ledger (financement, libération, remboursement, clôture) | financial-ledger, payment-adapters, ledger (wallets) |
| `documents`                                     | téléversement validé (MIME + magic bytes), chiffrement au repos, téléchargement contrôlé, revue         | transactions, risk, audit                            |
| `disputes`                                      | contestations, gel des libérations, messages, décisions motivées, appel, exécution via ledger           | payments, transactions, audit, notifications         |
| `ledger`                                        | fournisseur `LedgerService`, portefeuilles dérivés du registre, relevés CSV                             | financial-ledger                                     |
| `risk`                                          | pont entre le moteur de règles pur et la persistance des alertes                                        | compliance                                           |
| `admin`                                         | statistiques, utilisateurs, vérifications, alertes, journal d'audit, registre, réconciliation           | tous                                                 |
| `sandbox`                                       | endpoints du partenaire simulé (confirmation de financement, dépôt fictif)                              | payments, ledger                                     |
| `notifications`, `audit`, `reference`, `health` | transverses                                                                                             | —                                                    |

Garde-fous transverses (`src/common`) : `SessionAuthGuard` (global), `PermissionsGuard` (RBAC staff), `OriginCheckMiddleware` (CSRF défense en profondeur), `AllExceptionsFilter` (erreurs `{ statusCode, code, message, details }`), `SandboxHeaderInterceptor` (`x-dfn-mode: sandbox` sur chaque réponse), `ZodValidationPipe` (validation stricte).

## 3. Frontières et règles de dépendance

1. `packages/shared` ne dépend de rien (sauf zod) : c'est le vocabulaire commun web/API.
2. `packages/financial-ledger` dépend de `database` + `shared` et ignore totalement le métier Protect.
3. `packages/compliance`, `payment-adapters`, `contracts` sont **purs** : aucune dépendance Prisma, testables unitairement.
4. L'API est le seul endroit où le métier compose ces briques. Le web ne contient aucune règle financière : il affiche `nextActions` calculées par l'API.
5. Les soldes ne sont jamais stockés : `WalletsService` calcule depuis `LedgerEntry`.

## 4. Flux Diaspora Protect

```
Acheteur crée ──▶ PENDING_ACCEPTANCE ──(vendeur accepte)──▶ ACCEPTED ──(2 acceptations contrat)──▶ contrat ACCEPTED
   │                                                                                          │
   └─ KYC simulée acheteur + vendeur requise (REQUIRE_VERIFICATION_BEFORE_FUNDING) ◀──────────┘
Acheteur demande financement ──▶ AWAITING_FUNDING (instructions fictives SBXF-…)
Partenaire simulé confirme ──▶ FUNDED   ledger: DEBIT PROVIDER_SETTLEMENT / CREDIT ESCROW:tx (+ CREDIT PLATFORM_FEES)
Vendeur soumet preuves ──▶ IN_PROGRESS   (jalon SUBMITTED → APPROVED → RELEASED, atomique avec l'écriture ledger)
Acheteur approuve ──▶ ledger: DEBIT ESCROW:tx / CREDIT WALLET:vendeur
Tous jalons terminaux & séquestre = 0 ──▶ SETTLED (ou REFUNDED si rien n'a été libéré)
Litige ouvert ──▶ DISPUTED + releaseFrozen=true ──▶ décision motivée (RELEASE/REFUND/SPLIT/DISMISSED) ──▶ exécution ledger ──▶ dégel
```

Chaque transition passe par les machines à états de `@dfn/shared` (`transactionMachine`, `milestoneMachine`, `disputeMachine`, `fundingMachine`) ; une transition interdite lève `INVALID_TRANSITION` (HTTP 409).

## 5. Registre financier

Voir `docs/architecture/LEDGER.md`. Points clés : BigInt en unités mineures, une devise par écriture, débits = crédits vérifiés en mémoire puis par réconciliation SQL, `SELECT … FOR UPDATE` sur les comptes triés par id, clé d'idempotence unique, contrepassation au lieu de suppression, snapshots + job de réconciliation.

## 6. Multi-tenant et autorisation

- Toute entité métier porte un `organizationId`; chaque utilisateur possède un espace **PERSONAL** créé à l'inscription et peut appartenir à des organisations **BUSINESS** (rôles OWNER/ADMIN/MEMBER/VIEWER).
- `TransactionAccessService.loadFor()` détermine le rôle du lecteur (BUYER, SELLER, STAFF) ou renvoie **404** : l'existence d'une transaction d'un autre tenant n'est jamais révélée.
- Les permissions staff (ADMIN, COMPLIANCE) sont définies dans `packages/shared/src/permissions.ts` et appliquées par `@RequirePermission`.

## 7. Choix techniques notables (voir `docs/decisions/`)

- ADR-0001 monolithe modulaire ; ADR-0002 registre double entrée ; ADR-0003 sandbox-only ; ADR-0004 sessions cookie vs JWT ; ADR-0005 RBAC défini dans le code ; ADR-0006 stockage documents chiffrés ; ADR-0007 machines à états explicites ; ADR-0008 adaptateurs partenaires.
- Exécution de l'API via `ts-node` (transpile-only) pour consommer directement les sources TypeScript des paquets ; un build compilé est une étape de durcissement listée dans la roadmap.
- Redis/BullMQ sont optionnels en développement : sans `REDIS_URL`, les courriels (transport `log`) sont dispatchés en mémoire avec un avertissement.

## 8. Observabilité

Logs structurés pino (redaction des cookies, mots de passe, jetons), `x-request-id` propagé, `AuditLog` pour chaque action sensible, `TransactionEvent` pour l'historique métier, `ProviderEvent` pour la traçabilité partenaire.

## 9. Évolution vers des services

Les frontières de modules (payments, ledger, documents, notifications) sont les candidates naturelles à l'extraction si la charge le justifie. Les contrats sont déjà des interfaces (`PaymentProviderAdapter`, `KycProvider`, `LedgerService`) ; aucune extraction n'est prévue avant la phase 4.
