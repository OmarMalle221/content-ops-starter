# Diaspora Financial Network — Feuille de route

> Mode : `sandbox` uniquement — « Données fictives — Aucun fonds réel ».  
> Dernière mise à jour : 2026-10-11 (fin de l'itération Phases 3–5).

Cette feuille de route décrit les phases de construction de la plateforme, ce qui est livré, ce qui vient ensuite, les dépendances entre phases et — surtout — les **portes réglementaires** qui conditionnent toute phase « live ». Aucune date ferme n'est donnée pour les phases live : elles dépendent d'autorisations externes que l'équipe ne contrôle pas.

---

## 1. Vue d'ensemble

| Phase | Intitulé                                         | Statut                                   | Contenu principal                                                                                                                                                                                                 |
| ----- | ------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Cadrage et socle technique                       | **TERMINÉ**                              | Monorepo pnpm, schéma Prisma, conventions, ADR, environnement local                                                                                                                                               |
| 1     | Fondations                                       | **TERMINÉ**                              | Authentification (sessions + MFA TOTP), organisations, RBAC, journal d'audit, design system, bandeau sandbox                                                                                                      |
| 2     | Diaspora Protect complet                         | **TERMINÉ**                              | Transactions, invitations, contrats, jalons, documents chiffrés, litiges avec gel des libérations, notifications ; **noyau du registre** et **partenaire de paiement sandbox** livrés parce que Protect en dépend |
| 3     | Wallet complet, tâches planifiées, anonymisation | **TERMINÉ (sandbox)**                    | Écrans Wallet multi-devises, bénéficiaires, préférences de sécurité, planificateur de tâches (instantanés, réconciliation), suppression et anonymisation des comptes                                              |
| 4     | Diaspora Transfer et Diaspora Business           | **TERMINÉ (sandbox)**                    | Cotation FX simulée, machine à états `Transfer` avec revue conformité, règlement simulé ; factures, devis, paiements fictifs, rapports par période                                                                |
| 5     | API partenaires et recherche DDA                 | **TERMINÉ (sandbox, DDA interne)**       | Clés API, scopes, limitation de débit, idempotence, webhooks signés, console développeur ; simulation DDA strictement interne (administrateurs uniquement)                                                        |
| 6     | Durcissement et préparation partenaires          | **SUIVANT**                              | Adaptateurs KYC/sanctions pour fournisseurs agréés, passkeys, stockage objet chiffré, build compilé, tests de charge, revue juridique des checklists                                                              |
| Live  | Activité réelle                                  | **Bloqué** par les portes réglementaires | Uniquement après autorisations, contrats partenaires et audit de sécurité indépendant                                                                                                                             |

---

## 2. Phase 0 — Cadrage et socle technique (TERMINÉ)

| Livrable                                                                                                                                                     | État  | Emplacement                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------- |
| Monorepo pnpm (`apps/api`, `apps/web`, `packages/*`), TypeScript strict, Prettier, ESLint                                                                    | Livré | racine, `tsconfig.base.json`                                                      |
| Schéma PostgreSQL / Prisma 6 (identité, organisations, vérification, Protect, registre, partenaires, transferts, gouvernance, API, DDA) + migration initiale | Livré | `packages/database/prisma/schema.prisma`, `prisma/migrations/20261011024233_init` |
| Énumérations partagées miroir du schéma, codes d'erreur stables, utilitaires monétaires `BigInt`, pays et corridors                                          | Livré | `packages/shared/src/{enums,errors,money,countries}.ts`                           |
| Machines à états explicites (`Transaction`, `Milestone`, `Dispute`, `FundingRequest`, `Transfer`, `Invoice`, `Quote`)                                        | Livré | `packages/shared/src/state-machines/`                                             |
| Matrice RBAC définie en code                                                                                                                                 | Livré | `packages/shared/src/permissions.ts`                                              |
| Constantes sandbox (disclaimer FR/EN, en-tête `x-dfn-mode`)                                                                                                  | Livré | `packages/shared/src/sandbox.ts`                                                  |
| `.env.example` documenté, `DFN_MODE=sandbox`                                                                                                                 | Livré | `.env.example`                                                                    |
| ADR 0001 à 0008                                                                                                                                              | Livré | `docs/decisions/`                                                                 |

## 3. Phase 1 — Fondations (TERMINÉ)

| Livrable                                                                                                         | État  | Notes                                            |
| ---------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------ |
| Inscription / connexion, mots de passe argon2id, politique ≥ 12 caractères                                       | Livré | `registerSchema`, `passwordSchema`               |
| Sessions persistées (`Session.tokenHash`), cookie httpOnly `SameSite=Lax`, TTL 12 h, révocation                  | Livré | `SESSION_*` dans `.env.example`                  |
| Verrouillage après échecs répétés (`failedLoginCount`, `lockedUntil`), code `ACCOUNT_LOCKED`                     | Livré | Alimente la règle `REPEATED_LOGIN_FAILURES`      |
| MFA TOTP (`otplib`), secret chiffré AES-256-GCM, `Session.mfaVerified`, code `MFA_REQUIRED`                      | Livré | Passkeys : Phase 6                               |
| Organisations `PERSONAL` / `BUSINESS`, membres, invitations par jeton, rôles                                     | Livré | `createOrganizationSchema`, `inviteMemberSchema` |
| Gardes d'autorisation serveur (rôle global + rôle d'organisation), isolation multi-tenant (404 sur accès croisé) | Livré | `SECURITY.md` §4                                 |
| Journal d'audit (`AuditLog`) avec acteur, organisation, IP, user-agent                                           | Livré | Consultation `admin:audit`                       |
| Design system (`packages/ui`), bandeau persistant « Données fictives — Aucun fonds réel »                        | Livré | `NEXT_PUBLIC_DFN_MODE`                           |
| Logs structurés pino avec redaction, `requestId`                                                                 | Livré | `LOG_LEVEL`                                      |
| Limitation de débit (`@nestjs/throttler`), helmet, CORS restreint                                                | Livré | `CORS_ORIGINS`                                   |

## 4. Phase 2 — Diaspora Protect complet (TERMINÉ)

| Livrable                                                                                                                                                                 | État  | Notes                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------- |
| Création de transaction avec jalons (1–12), conditions, corridor, frais 150 bps                                                                                          | Livré | `createTransactionSchema`               |
| Invitation du vendeur, acceptation, inscription depuis l'invitation                                                                                                      | Livré | `TransactionParty`, `invitationToken`   |
| Contrat numérique versionné et hashé, acceptation par partie                                                                                                             | Livré | `packages/contracts`                    |
| Vérification KYC/KYB via adaptateur sandbox (`SIMULATED_PASS` / `SIMULATED_FAIL`), criblage sanctions simulé                                                             | Livré | `packages/compliance/src/kyc`           |
| Demande de financement, instructions fictives, webhook simulé signé HMAC et idempotent, expiration 72 h                                                                  | Livré | `packages/payment-adapters`             |
| **Noyau du registre à double entrée** : écritures équilibrées, `BigInt`, idempotence, verrouillage `FOR UPDATE`, contre-passations, instantanés, réconciliation          | Livré | `packages/financial-ledger`             |
| Plan comptable sandbox : `PROVIDER_SETTLEMENT`, `ESCROW:<tx>`, `WALLET:<org>`, `PLATFORM_FEES`                                                                           | Livré | `account-codes.ts`                      |
| Documents : allowlist MIME, taille max 15 Mo, magic bytes, SHA-256, chiffrement au repos, revue conformité                                                               | Livré | `MAX_UPLOAD_MB`, `STORAGE_DIR`          |
| Jalons : soumission, demande de modifications, approbation, libération comptable                                                                                         | Livré | `milestoneMachine`                      |
| Litiges : ouverture, gel automatique des libérations, messages publics / notes internes, décision motivée, appel, exécution `RELEASE` / `REFUND` / `SPLIT` / `DISMISSED` | Livré | `disputeMachine`, `DISPUTE_HANDLING.md` |
| Moteur de risque explicable et files `RiskAlert` avec actions `START_REVIEW` / `CONFIRM` / `DISMISS` / `CONTEST`                                                         | Livré | `packages/compliance/src/risk`          |
| Historique immuable `TransactionEvent`, notifications in-app + e-mail (journal)                                                                                          | Livré | `TransactionEventType`                  |
| Tests : unitaires (packages), intégration API (`TEST_DATABASE_URL`), e2e Playwright du scénario à 12 étapes et du scénario de litige                                     | Livré | `PRODUCT_REQUIREMENTS.md` §6            |

## 5. Phase 3 — Wallet complet, tâches planifiées, anonymisation (TERMINÉ, sandbox)

| Livrable                                                                                                                                                                                                                         | État  | Emplacement / notes                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| Écrans Wallet : soldes par devise et par espace (sélecteur d'organisation), résumé, historique paginé et filtrable (type, période, recherche), relevé CSV, estimateur de conversion FX                                           | Livré | `apps/web/src/app/(app)/wallet`, `GET /v1/wallets/:org/{summary,:ccy/entries,:ccy/statement.csv}`, `POST /v1/wallets/estimate` |
| Bénéficiaires structurés (banque, mobile money…), identifiants masqués à la lecture, suppression logique, règle de voyage préparée                                                                                               | Livré | `GET/POST/DELETE /v1/beneficiaries`, `Beneficiary`                                                                             |
| Dépôt sandbox libre-service plafonné par organisation, devise et jour (`SANDBOX_SELF_DEPOSIT_DAILY_LIMIT`), audité, code `SANDBOX_LIMIT_REACHED`                                                                                 | Livré | `POST /v1/sandbox/wallets/self-deposit`                                                                                        |
| Préférences de sécurité : MFA obligatoire pour les transferts, plafond quotidien de transfert                                                                                                                                    | Livré | `GET/PUT /v1/users/me/security-preferences`, `User.securityPreferences`                                                        |
| Planificateur in-process (`JOBS_ENABLED`, `JOBS_INTERVAL_MINUTES`) et registre de tâches : `BALANCE_SNAPSHOTS`, `RECONCILIATION`, `EXPIRE_STALE`, `ANONYMIZE_DELETED`, `TRANSFER_PROCESSING`, `WEBHOOK_RETRY`, `INVOICE_OVERDUE` | Livré | `apps/api/src/modules/jobs`, verrou `MaintenanceRun` (`JOB_ALREADY_RUNNING`), délai max 15 min                                 |
| Console d'administration des tâches : liste, historique des exécutions, lancement manuel                                                                                                                                         | Livré | `/admin/jobs`, `GET /v1/admin/jobs`, `GET …/runs`, `POST …/:name/run`                                                          |
| Suppression de compte : demande, refus si transactions / organisations / soldes ouverts (`ACCOUNT_HAS_OPEN_ITEMS`), annulation pendant le délai, révocation des sessions                                                         | Livré | `POST /v1/users/me/deletion-request`, `GET …/status`, `POST …/:id/deletion-cancel`                                             |
| Anonymisation différée (`ANONYMIZE_AFTER_DAYS`) : e-mail `deleted-<id>@anonymized.invalid`, nom, téléphone, MFA, mot de passe aléatoire, préférences, données déclarées KYC ; registre, historique et audit **jamais modifiés**  | Livré | `anonymization.ts`, `AnonymizationService`, `User.anonymizedAt`                                                                |
| Réconciliation planifiée : instantanés de solde puis comparaison écritures / instantanés, écarts persistés (`ReconciliationDifference`)                                                                                          | Livré | `BALANCE_SNAPSHOTS` + `RECONCILIATION`, `LedgerService.reconcile()`                                                            |

Reporté en Phase 6 : adaptateur KYC/sanctions pour fournisseur agréé (interfaces prêtes), passkeys, stockage objet S3 chiffré, files de revue enrichies (SLA, assignation).

## 6. Phase 4 — Diaspora Transfer et Diaspora Business (TERMINÉ, sandbox)

| Livrable                                                                                                                                                                                                                                                 | État  | Emplacement / notes                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cotation FX **simulée** : taux indicatifs fixes en fractions entières, écart 150 bps, frais fixes + 75 bps, expiration (`FX_QUOTE_TTL_MINUTES`), corridors `CORRIDORS` (`CA→SN` lancement, autres en expansion / recherche), code `CORRIDOR_UNSUPPORTED` | Livré | `packages/payment-adapters/src/fx.ts`, `POST /v1/transfers/quotes`, `FXQuote`                                                  |
| Machine à états `CREATED → QUOTED → AUTHORIZED → PROCESSING → SETTLED / FAILED`, `REVIEW_REQUIRED`, `CANCELLED`, `EXPIRED` ; toute transition passe par `transferMachine`                                                                                | Livré | `packages/shared/src/state-machines`, `apps/api/src/modules/transfers`                                                         |
| Autorisation : MFA vérifiée (préférence), plafond quotidien (`DAILY_LIMIT_EXCEEDED`), devis expiré (`QUOTE_EXPIRED`), évaluation du moteur de risque → `REVIEW_REQUIRED` avec motif explicable                                                           | Livré | Règles `TRANSFER_VELOCITY`, `NEW_BENEFICIARY_HIGH_VALUE`, `BENEFICIARY_CHURN`, `UNVERIFIED_TRANSFER`, `TRANSFER_DRAINS_WALLET` |
| Écritures en deux jambes : `WALLET → FX_CLEARING` (+ `PLATFORM_FEES`) à l'autorisation ; `FX_CLEARING → PROVIDER_SETTLEMENT` au règlement ; recrédit intégral du portefeuille en cas d'échec                                                             | Livré | `LedgerService`, idempotence `transfer:<id>:…`                                                                                 |
| Partenaire simulé : événements `SETTLED` / `FAILED` (`POST /v1/sandbox/partner/transfer-events`), auto-règlement par la tâche `TRANSFER_PROCESSING` après 60 s, expiration des devis                                                                     | Livré | `transfers-sandbox.controller.ts`                                                                                              |
| Revue conformité : file `/admin/transfers`, approbation / rejet motivés (`POST /v1/admin/transfers/:id/review`), historique `TransferEvent`, reçu (`GET /v1/transfers/:id/receipt`)                                                                      | Livré | `transfers-admin.controller.ts`                                                                                                |
| Écrans : liste filtrable, parcours de création en étapes (bénéficiaire, montant, devis avec compte à rebours, autorisation MFA), détail avec chronologie                                                                                                 | Livré | `apps/web/src/app/(app)/transfers`, `components/transfers`                                                                     |
| Business : factures `INV-AAAA-0001` et devis `QUO-AAAA-0001` numérotés par organisation et par année, lignes, taxes en bps, brouillon → envoi → payée / partiellement payée / en retard / annulée, conversion devis → facture, document imprimable       | Livré | `apps/api/src/modules/business`, `invoiceMachine`, `quoteMachine`                                                              |
| Paiements fictifs de facture (virement simulé, espèces, **portefeuille** → écriture ledger entre portefeuilles), notifications à la contrepartie, tâche `INVOICE_OVERDUE`                                                                                | Livré | `POST /v1/invoices/:id/payments`                                                                                               |
| Rapports par période : synthèse, exports CSV transactions / factures, commissions                                                                                                                                                                        | Livré | `GET /v1/organizations/:id/reports/{summary,transactions.csv,invoices.csv,commissions}`, `/business/reports`                   |
| Contreparties liées à l'espace personnel d'un utilisateur DFN (même e-mail) ou explicitement (`linkedOrganizationId`) pour les paiements par portefeuille                                                                                                | Livré | `organizations.service.ts`                                                                                                     |

## 7. Phase 5 — API partenaires et recherche DDA (TERMINÉ, sandbox)

| Livrable                                                                                                                                                                                                                                                                                                 | État  | Emplacement / notes                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| Clés API `dfn_sk_…` : hash SHA-256 stocké, préfixe affiché, secret révélé une seule fois, expiration, rotation, révocation, journal des requêtes par clé                                                                                                                                                 | Livré | `GET/POST /v1/api-credentials`, `POST …/:id/rotate`, `DELETE …/:id`, `GET …/:id/logs`, `ApiCredential`, `ApiRequestLog`        |
| Scopes (10 : `transactions:read/write`, `documents:write`, `disputes:write`, `wallets:read`, `transfers:read/write`, `invoices:read/write`, `webhooks:manage`) ; routes auth / admin / sandbox **jamais** accessibles par clé ; contexte limité à l'organisation de la clé                               | Livré | `api-scopes.ts`, `GET /v1/api-credentials/catalog`, code `SCOPE_FORBIDDEN`                                                     |
| Limitation de débit par clé (fenêtre glissante par minute, `rateLimitPerMinute`), code `RATE_LIMITED`                                                                                                                                                                                                    | Livré | `rate-limiter.ts`                                                                                                              |
| Idempotence : en-tête `Idempotency-Key` sur `POST/PATCH/PUT/DELETE`, empreinte méthode + chemin + corps canonique, rejeu → réponse identique + `Idempotent-Replayed`, réutilisation avec un autre corps → `IDEMPOTENCY_KEY_REUSED`, concurrence → `IDEMPOTENCY_IN_PROGRESS`, TTL `IDEMPOTENCY_TTL_HOURS` | Livré | `idempotency.interceptor.ts`, `IdempotencyRecord`                                                                              |
| Webhooks sortants : 12 types d'événements, secret chiffré au repos, enveloppe `{ id, type, createdAt, sandbox: true, data }`, signature `t=<unix>,v1=<HMAC-SHA256>`, tentatives `2^n` minutes jusqu'à `WEBHOOK_MAX_ATTEMPTS`, désactivation après 50 échecs, anti-SSRF, test et rejeu manuel             | Livré | `GET/POST/PATCH/DELETE /v1/webhooks`, `…/rotate-secret`, `…/test`, `…/deliveries`, `…/deliveries/:id/retry`, `WebhookDelivery` |
| Console développeur : clés, webhooks, livraisons, journal des requêtes, checklist d'intégration, OpenAPI                                                                                                                                                                                                 | Livré | `/developers`, `docs/api/README.md`, `docs/api/openapi.json`                                                                   |
| DDA (recherche interne) : devise `DDA` de type `SIMULATED_ASSET`, comptes `DDA_ISSUANCE` / `DDA_HOLDING:<org>`, opérations mint / transfer / redeem en écritures équilibrées, réserve déclarative hors registre fiat, couverture, stress test (de-peg / liquidité), traçabilité par référence            | Livré | `apps/api/src/modules/dda`, `GET/POST /v1/admin/dda/*`, `/admin/dda`, `docs/architecture/DDA_SIMULATION.md`                    |
| Lignes rouges DDA appliquées : aucune blockchain, aucun jeton, aucune convertibilité (écriture multi-devises structurellement refusée), administrateurs uniquement (`ADMIN_DDA`), enveloppe `simulated: true` + hypothèse « 1 DDA = 1 USD non garantie » sur chaque réponse                              | Livré | `docs/compliance/STABLECOIN_RISKS.md` (porte R10)                                                                              |

## 8. Phase 6 — Durcissement et préparation partenaires (SUIVANT)

| Livrable                                                                                                                                                                                                               | Dépend de                              | Critère de sortie                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| **Relecture juridique** des checklists `docs/compliance/*` par un conseiller avant tout contrat partenaire (tâche humaine, non automatisable)                                                                          | —                                      | Avis écrit archivé, décisions consignées dans un ADR                             |
| Adaptateurs KYC/KYB et sanctions pour un fournisseur agréé (`KycProvider` / `SanctionsProvider`), activés uniquement par `KYC_PROVIDER` ≠ `sandbox` **et** contrat signé                                               | `packages/compliance/src/kyc/types.ts` | Résultats non simulés distingués (`simulated = false`), revue manuelle conservée |
| Adaptateur FX / transfert partenaire agréé derrière les portes R3–R6 ; `FX_PROVIDER` ≠ `sandbox` refusé tant que `DFN_MODE = sandbox`                                                                                  | Portes §10                             | Jamais activé sans autorisation                                                  |
| Passkeys (WebAuthn) en complément de la TOTP                                                                                                                                                                           | Phase 1                                | Enrôlement + authentification sans régression                                    |
| Stockage objet S3-compatible chiffré (remplace `STORAGE_DIR`), clés KMS, rotation documentée                                                                                                                           | Phase 2                                | Migration des blobs testée                                                       |
| Build compilé de l'API (remplace `ts-node`), image Docker durcie, sauvegardes PostgreSQL testées                                                                                                                       | —                                      | Restauration chronométrée                                                        |
| Files de revue enrichies (SLA, assignation, filtres, export), signalement de structuration sur 24 h agrégé par personne                                                                                                | Phase 2                                | Aucune décision sans `note`                                                      |
| Planificateur distribué (BullMQ) avec verrou Redis lorsque plusieurs réplicas sont déployés                                                                                                                            | Phase 3                                | Une seule exécution par tâche et par intervalle                                  |
| Tests de charge et de concurrence étendus (registre, files, webhooks), parcours e2e complets dans l'interface pour Wallet / Transfer / Business (un scénario de fumée existe déjà : `apps/web/e2e/phases-3-5.spec.ts`) | —                                      | Objectifs `PRODUCT_REQUIREMENTS.md` §5                                           |
| Seed de démonstration étendu (bénéficiaires, transferts, factures, clé API)                                                                                                                                            | Phases 3–5                             | Scénario de démonstration complet sans saisie manuelle                           |

---

## 9. Dépendances entre phases

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
                          │            │           │                       │
                          │            │           └─ partenaire FX/transfert (porte R3, R4, R6)
                          │            └─ fournisseur KYC agréé (porte R2) ─┘
                          └─ registre + partenaire sandbox (livrés en Phase 2)

Toute phase « live » ──► portes R1 à R10 toutes franchies
```

- Le registre et le partenaire sandbox ont été avancés de la Phase 3 à la Phase 2 : Protect ne peut pas être démontré sans séquestre comptable ni confirmation de financement.
- Le module Transfer réutilise le moteur de risque et la file `REVIEW_REQUIRED` ; les transferts sont **tous** réglés par le partenaire simulé.
- L'API partenaires expose uniquement des parcours déjà éprouvés en interface ; elle n'atteint jamais les routes d'authentification, d'administration ni de simulation.
- La simulation DDA ne dépend d'aucun autre module et n'est accessible qu'aux administrateurs ; elle ne précède aucune décision de porte R10.

---

## 10. Portes réglementaires avant toute phase live

Aucune ligne de code de ce dépôt ne doit être connectée à des fonds réels tant que **toutes** les portes applicables au corridor et au module concernés ne sont pas franchies et documentées. Détail et responsables : `docs/compliance/AUTHORIZATIONS_CHECKLIST.md`.

| Porte | Objet                                                                                                                                                        | Juridiction                     | Document de référence                | Niveau          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------ | --------------- |
| R1    | Avis juridique écrit sur la qualification des activités (Protect, Wallet, Transfer) et le modèle « fonds détenus par un partenaire agréé »                   | Canada, Québec, Sénégal, Guinée | `docs/compliance/README.md`          | Bloquant        |
| R2    | Fournisseur KYC/KYB et criblage sanctions contractualisé ; fin des statuts `SIMULATED_*` en production                                                       | Toutes                          | `KYC_KYB.md`                         | Bloquant        |
| R3    | Inscription ESM auprès de CANAFE (ou confirmation écrite de non-assujettissement) ; programme de conformité LBC/FT approuvé                                  | Canada                          | `CANADA_CANAFE.md`, `AML_POLICY.md`  | Bloquant        |
| R4    | Enregistrement comme fournisseur de services de paiement auprès de la Banque du Canada (LAPD) ou analyse d'exclusion validée ; cadre de protection des fonds | Canada                          | `CANADA_BANQUE_DU_CANADA.md`         | Bloquant        |
| R5    | Permis d'entreprise de services monétaires (AMF) pour les catégories applicables ou confirmation de non-assujettissement                                     | Québec                          | `QUEBEC_ESM.md`                      | Bloquant        |
| R6    | Partenariat avec une banque / un EME agréé par la BCEAO (Sénégal, Côte d'Ivoire) et conformité change ; équivalent BCRG pour la Guinée                       | UEMOA, Guinée                   | `SENEGAL_BCEAO.md`, `GUINEE_BCRG.md` | Bloquant        |
| R7    | Conformité protection des données : EFVP (Loi 25), déclarations CDP (Sénégal), transferts transfrontaliers, registre d'incidents                             | Toutes                          | `DATA_PROTECTION.md`                 | Bloquant        |
| R8    | Audit de sécurité indépendant (test d'intrusion, revue du registre et des gardes), plan de reprise testé                                                     | —                               | `SECURITY.md`                        | Bloquant        |
| R9    | Assurance responsabilité / cyber, conditions d'utilisation et politique de litiges validées par un conseil (protection du consommateur)                      | Canada, Québec                  | `DISPUTE_HANDLING.md`                | Fort            |
| R10   | Pour toute activité DDA : avis juridique spécifique, aucun lancement sans cadre explicite                                                                    | Canada, UEMOA                   | `STABLECOIN_RISKS.md`                | Bloquant absolu |

Franchir une porte signifie : document signé, référence d'autorisation ou avis écrit archivé, décision consignée dans un ADR et modification du garde `DFN_MODE` revue par deux personnes. **Les checklists de `docs/compliance/` sont des documents de travail rédigés par l'équipe produit : elles doivent être relues par un conseiller juridique avant tout contrat partenaire.**

---

## 11. Indicateurs de suivi

| Indicateur                                          | Cible                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Scénarios e2e verts (12 étapes + litige)            | 100 % à chaque fusion                                                          |
| Écarts de réconciliation en recette                 | 0 (tâche `RECONCILIATION` planifiée)                                           |
| Couverture tests `packages/financial-ledger`        | ≥ 90 % lignes                                                                  |
| Alertes de risque traitées sans note                | 0                                                                              |
| Transferts réglés sans passer par `transferMachine` | 0                                                                              |
| Pages sans bandeau sandbox                          | 0                                                                              |
| Réponses DDA sans enveloppe `simulated: true`       | 0                                                                              |
| Portes réglementaires franchies                     | Suivies dans `AUTHORIZATIONS_CHECKLIST.md` (toutes « À vérifier » aujourd'hui) |

---

## 12. Rapport de livraison — Phases 3 à 5 (2026-10-11)

**Tests exécutés** (tous verts) : 53 tests unitaires de paquets (dont les tests du registre contre PostgreSQL), 108 tests d'intégration API (10 fichiers, base PostgreSQL dédiée par suite), 3 scénarios Playwright.

**Fonctions simulées** (jamais de fonds réels) : partenaire de paiement sandbox (financements, règlements de transferts), taux FX indicatifs fixes, KYC/KYB et criblage sanctions `SIMULATED_*`, dépôts sandbox, paiements de factures, unités DDA et réserve déclarative, courriels écrits dans le journal.

**Revue adversariale** : trois relectures indépendantes (sécurité, invariants comptables, règles sandbox de l'interface) avant fusion ; les constats bloquants et importants ont été corrigés et couverts par des tests (détail : `SECURITY.md` §16), les points restants sont listés dans `SECURITY.md` §17.

**Risques de sécurité résiduels** : planificateur en mémoire (une seule réplique), limitation de débit par clé en mémoire (par réplique), stockage des documents sur disque local, pas de passkeys, API exécutée par `ts-node`, secrets `.env` gérés hors coffre, tests de charge non réalisés, aucune revue juridique des checklists de conformité, pas d'audit de sécurité indépendant. Détail : `SECURITY.md` §17.
