# Architecture — Diaspora Financial Network (DFN)

> **Mode sandbox uniquement.** Données fictives — Aucun fonds réel. L'API refuse de démarrer si `DFN_MODE` ≠ `sandbox`.

## 1. Vue d'ensemble

DFN est un **monolithe modulaire** livré dans un monorepo pnpm. Deux applications déployables partagent des paquets de domaine typés :

```
dfn/
├── apps/
│   ├── web   — Next.js 15 (App Router, React 19, Tailwind, @dfn/ui)           port 3000
│   └── api   — NestJS 11 (REST /v1, OpenAPI /docs, sessions cookie, clés API)  port 4000
├── packages/
│   ├── shared            — enums, schémas zod (DTO), machines à états, monnaie, pays/corridors, RBAC, scopes API
│   ├── database          — schéma Prisma (51 tables), migrations, seed de démonstration
│   ├── financial-ledger  — registre comptable à double entrée (LedgerService), codes de comptes
│   ├── compliance        — interfaces KYC/KYB/sanctions + adaptateurs sandbox + moteur de règles explicable
│   ├── payment-adapters  — partenaire de paiement sandbox, fournisseur FX sandbox, signature HMAC des webhooks
│   ├── contracts         — gabarits de contrat numérique, hachage canonique SHA-256
│   └── ui                — design system (composants shadcn-style, tokens Tailwind)
├── docs/{architecture,api,compliance,security,decisions}
├── docker-compose.yml, .env.example
└── *.md (PRODUCT_REQUIREMENTS, ARCHITECTURE, DATA_MODEL, SECURITY, ROADMAP)
```

```
Navigateur ──(cookies 1st-party)──▶ Next.js (web) ──/api/* rewrite──▶ NestJS (api) ──Prisma──▶ PostgreSQL 16
Partenaire ──(Authorization: Bearer dfn_sk_…)──────────────────────────▶   │
                                      │ server components                 ├── planificateur in-process (tâches de maintenance)
                                      └── fetch API_INTERNAL_URL ─────────┼── bus d'événements de domaine ──▶ webhooks sortants signés
                                                                          ├── BullMQ ──▶ Redis (optionnel en dev)
                                                                          ├── stockage chiffré (AES-256-GCM, disque local)
                                                                          └── adaptateurs sandbox (KYC, sanctions, paiement, FX)
```

Le navigateur ne parle qu'à l'origine web : Next.js réécrit `/api/*` vers l'API, les cookies de session restent first-party (`SameSite=Lax`, `httpOnly`). Les composants serveur appellent l'API directement avec le cookie transmis. Les partenaires appellent l'API avec une clé `dfn_sk_…` limitée par scopes.

## 2. Modules de l'API (`apps/api/src/modules`)

| Module                                          | Rôle                                                                                                                                                                              | Dépend de                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `auth`                                          | inscription, connexion, sessions en base, MFA TOTP, mot de passe, verrouillage ; authentification par clé API déléguée à `api-platform`                                           | users, organizations, audit, risk, api-platform      |
| `users`                                         | profil, contexte d'authentification                                                                                                                                               | audit                                                |
| `organizations`                                 | espaces personnels / entreprises, membres, invitations, KYB simulée, contreparties (liées à l'espace d'un utilisateur DFN)                                                        | compliance (KYB), audit, notifications               |
| `verifications`                                 | KYC simulée, filtrage sanctions simulé, file de revue staff                                                                                                                       | compliance, audit, notifications                     |
| `transactions`                                  | **Diaspora Protect** : création, invitations, contrat, acceptation, annulation, jalons, événements (publiés sur le bus)                                                           | contracts, payments, risk, audit, notifications      |
| `payments`                                      | orchestration du partenaire simulé + écritures ledger (financement, libération, remboursement, clôture)                                                                           | financial-ledger, payment-adapters, ledger (wallets) |
| `documents`                                     | téléversement validé (MIME + magic bytes), chiffrement au repos, téléchargement contrôlé, revue                                                                                   | transactions, risk, audit                            |
| `disputes`                                      | contestations, gel des libérations, messages, décisions motivées, appel, exécution via ledger                                                                                     | payments, transactions, audit, notifications         |
| `ledger`                                        | fournisseur `LedgerService`, **Diaspora Wallet** : soldes dérivés, historique, relevés CSV, estimateur FX, bénéficiaires masqués, dépôt sandbox plafonné, préférences de sécurité | financial-ledger, payment-adapters (FX)              |
| `transfers`                                     | **Diaspora Transfer** : devis FX simulés, machine à états, autorisation MFA + plafond, revue conformité, règlement par partenaire simulé, reçus, tâche `TRANSFER_PROCESSING`      | ledger, risk, jobs, audit, notifications             |
| `business`                                      | **Diaspora Business** : factures, devis, paiements fictifs (dont par portefeuille), documents imprimables, rapports par période, tâche `INVOICE_OVERDUE`                          | ledger, organizations, jobs, notifications           |
| `jobs`                                          | registre de tâches, planificateur in-process, exécutions `MaintenanceRun` verrouillées, tâches intégrées (instantanés, réconciliation, expirations), suppression et anonymisation | financial-ledger, audit                              |
| `api-platform`                                  | clés API (hash, scopes, rotation, journal), limitation de débit par clé, intercepteur `Idempotency-Key`, abonnements webhook, dispatcher signé avec relances et anti-SSRF         | events, jobs, audit                                  |
| `dda`                                           | simulation de recherche DDA (administrateurs uniquement) : registre d'unités fictives, mint / transfer / redeem, réserve déclarative, stress test, traçabilité                    | financial-ledger, audit, notifications               |
| `risk`                                          | pont entre le moteur de règles pur et la persistance des alertes                                                                                                                  | compliance                                           |
| `admin`                                         | statistiques, utilisateurs, vérifications, alertes, journal d'audit, registre, réconciliation                                                                                     | tous                                                 |
| `sandbox`                                       | endpoints du partenaire simulé (confirmation de financement, dépôt fictif administré)                                                                                             | payments, ledger                                     |
| `notifications`, `audit`, `reference`, `health` | transverses                                                                                                                                                                       | —                                                    |

Garde-fous transverses (`src/common`) : `SessionAuthGuard` (global : cookie de session **ou** clé API), `PermissionsGuard` (RBAC staff), `OriginCheckMiddleware` (CSRF défense en profondeur), `AllExceptionsFilter` (erreurs `{ statusCode, code, message, details, requestId }`), `SandboxHeaderInterceptor` (`x-dfn-mode: sandbox` sur chaque réponse), `ZodValidationPipe` (validation stricte), `DomainEventsBus` (événements de domaine en mémoire, consommés par les webhooks), `IdempotencyInterceptor` (rejeu sûr des mutations).

## 3. Frontières et règles de dépendance

1. `packages/shared` ne dépend de rien (sauf zod) : c'est le vocabulaire commun web/API/partenaires.
2. `packages/financial-ledger` dépend de `database` + `shared` et ignore totalement le métier Protect, Transfer, Business ou DDA.
3. `packages/compliance`, `payment-adapters`, `contracts` sont **purs** : aucune dépendance Prisma, testables unitairement.
4. L'API est le seul endroit où le métier compose ces briques. Le web ne contient aucune règle financière : il affiche `nextActions` calculées par l'API.
5. Les soldes ne sont jamais stockés : `WalletsService` calcule depuis `LedgerEntry`.
6. Les modules métier publient des événements sur `DomainEventsBus` ; seul `api-platform` les transforme en webhooks. Aucun module n'appelle directement un partenaire externe.

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

## 5. Flux Diaspora Transfer (simulé)

```
POST /v1/transfers/quotes ──▶ FXQuote (taux fixe + écart 150 bps, frais fixes + 75 bps, expiration FX_QUOTE_TTL_MINUTES)
POST /v1/transfers ──▶ CREATED ──▶ QUOTED
POST …/authorize (MFA si exigée, plafond quotidien) ──▶ moteur de risque
   ├─ ALLOW ──▶ AUTHORIZED ──▶ PROCESSING   ledger: DEBIT WALLET:org / CREDIT FX_CLEARING (+ CREDIT PLATFORM_FEES)
   └─ MANUAL_REVIEW ──▶ REVIEW_REQUIRED ──(staff approuve)──▶ AUTHORIZED ──▶ PROCESSING   (ou CANCELLED)
Partenaire simulé (POST /v1/sandbox/partner/transfer-events ou tâche TRANSFER_PROCESSING après 60 s)
   ├─ SETTLED ──▶ ledger: DEBIT FX_CLEARING / CREDIT PROVIDER_SETTLEMENT (jambe de destination)
   └─ FAILED  ──▶ ledger: contre-passation, portefeuille recrédité
Devis expiré avant autorisation ──▶ EXPIRED ; annulation par le donneur d'ordre ──▶ CANCELLED
```

## 6. Registre financier

Voir `docs/architecture/LEDGER.md`. Points clés : BigInt en unités mineures, une devise par écriture, débits = crédits vérifiés en mémoire puis par réconciliation SQL, `SELECT … FOR UPDATE` sur les comptes triés par id, clé d'idempotence unique, contrepassation au lieu de suppression, instantanés + tâche de réconciliation planifiée. Codes de comptes : `PROVIDER_SETTLEMENT:<partenaire>:<ccy>`, `ESCROW:<tx>:<ccy>`, `WALLET:<org>:<ccy>`, `PLATFORM_FEES:<ccy>`, `FX_CLEARING:<ccy>`, et pour la recherche DDA `DDA_ISSUANCE:DDA`, `DDA_HOLDING:<org>:DDA` (devise `DDA` de type `SIMULATED_ASSET`, jamais mélangée au fiat).

## 7. Tâches planifiées

`JobRegistry` (module global) enregistre les tâches ; `JobsSchedulerService` les exécute séquentiellement toutes les `JOBS_INTERVAL_MINUTES` minutes lorsque `JOBS_ENABLED=true`. Chaque exécution est persistée dans `MaintenanceRun` et protégée par un verrou de ligne (une tâche déjà en cours renvoie `JOB_ALREADY_RUNNING`, délai maximal 15 minutes). Tâches : `BALANCE_SNAPSHOTS`, `RECONCILIATION`, `EXPIRE_STALE`, `ANONYMIZE_DELETED`, `TRANSFER_PROCESSING`, `WEBHOOK_RETRY`, `INVOICE_OVERDUE`. Le planificateur est en mémoire : une seule réplique de l'API doit l'activer (passage à BullMQ prévu en phase 6).

## 8. API partenaires

- **Authentification** : `Authorization: Bearer dfn_sk_…` ; le hash SHA-256 de la clé est stocké, le secret n'est affiché qu'à la création ou à la rotation. Le contexte obtenu est un membre (`MEMBER`) de l'organisation de la clé uniquement, jamais un rôle staff.
- **Scopes** : `requiredScopeFor(method, path)` associe chaque route à un scope ; les routes d'authentification, d'administration et de simulation sont `FORBIDDEN` pour toute clé.
- **Limitation de débit** : fenêtre glissante d'une minute par clé (`rateLimitPerMinute`).
- **Idempotence** : `Idempotency-Key` sur les mutations ; empreinte méthode + chemin + corps canonique ; la réponse initiale est rejouée avec `Idempotent-Replayed: true`, un corps différent est refusé.
- **Webhooks** : les événements de domaine deviennent des livraisons `WebhookDelivery` ; charge `{ id, type, createdAt, sandbox: true, data }`, signature `t=<unix>,v1=<HMAC-SHA256>` (`signPayload` / `verifySignature` de `@dfn/payment-adapters`), relances `2^n` minutes jusqu'à `WEBHOOK_MAX_ATTEMPTS`, désactivation après 50 échecs consécutifs, adresses privées refusées (anti-SSRF).

## 9. Multi-tenant et autorisation

- Toute entité métier porte un `organizationId`; chaque utilisateur possède un espace **PERSONAL** créé à l'inscription et peut appartenir à des organisations **BUSINESS** (rôles OWNER/ADMIN/MEMBER/VIEWER).
- `TransactionAccessService.loadFor()` détermine le rôle du lecteur (BUYER, SELLER, STAFF) ou renvoie **404** : l'existence d'une transaction d'un autre tenant n'est jamais révélée. Transferts, bénéficiaires, factures et devis suivent la même règle.
- Les permissions staff (ADMIN, COMPLIANCE) sont définies dans `packages/shared/src/permissions.ts` et appliquées par `@RequirePermission` (`ADMIN_TRANSFERS`, `ADMIN_JOBS`, `ADMIN_DDA`, …).

## 10. Choix techniques notables (voir `docs/decisions/`)

- ADR-0001 monolithe modulaire ; ADR-0002 registre double entrée ; ADR-0003 sandbox-only ; ADR-0004 sessions cookie vs JWT ; ADR-0005 RBAC défini dans le code ; ADR-0006 stockage documents chiffrés ; ADR-0007 machines à états explicites ; ADR-0008 adaptateurs partenaires.
- Exécution de l'API via `ts-node` (transpile-only) pour consommer directement les sources TypeScript des paquets ; un build compilé est une étape de durcissement listée dans la roadmap.
- Redis/BullMQ sont optionnels en développement : sans `REDIS_URL`, les courriels (transport `log`) sont dispatchés en mémoire avec un avertissement.
- Le fournisseur FX est une interface (`FxRateProvider`) ; seul `sandbox` existe et `FX_PROVIDER` ≠ `sandbox` est refusé tant que `DFN_MODE = sandbox`.

## 11. Observabilité

Logs structurés pino (redaction des cookies, mots de passe, jetons, clés API), `x-request-id` propagé, `AuditLog` pour chaque action sensible, `TransactionEvent` / `TransferEvent` pour l'historique métier, `ProviderEvent` pour la traçabilité partenaire, `ApiRequestLog` pour les appels par clé, `WebhookDelivery` pour les livraisons sortantes, `MaintenanceRun` pour les tâches.

## 12. Évolution vers des services

Les frontières de modules (payments, ledger, documents, notifications, api-platform) sont les candidates naturelles à l'extraction si la charge le justifie. Les contrats sont déjà des interfaces (`PaymentProviderAdapter`, `FxRateProvider`, `KycProvider`, `LedgerService`) ; aucune extraction n'est prévue avant la phase 6.
