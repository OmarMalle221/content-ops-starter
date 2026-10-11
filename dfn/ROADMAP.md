# Diaspora Financial Network — Feuille de route

> Mode : `sandbox` uniquement — « Données fictives — Aucun fonds réel ».  
> Dernière mise à jour : 2026-10-11 (fin de l'itération Phases 0–2).

Cette feuille de route décrit les phases de construction de la plateforme, ce qui est livré, ce qui vient ensuite, les dépendances entre phases et — surtout — les **portes réglementaires** qui conditionnent toute phase « live ». Aucune date ferme n'est donnée pour les phases live : elles dépendent d'autorisations externes que l'équipe ne contrôle pas.

---

## 1. Vue d'ensemble

| Phase | Intitulé                                | Statut                                   | Contenu principal                                                                                                                                                                                                 |
| ----- | --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Cadrage et socle technique              | **TERMINÉ**                              | Monorepo pnpm, schéma Prisma, conventions, ADR, environnement local                                                                                                                                               |
| 1     | Fondations                              | **TERMINÉ**                              | Authentification (sessions + MFA TOTP), organisations, RBAC, journal d'audit, design system, bandeau sandbox                                                                                                      |
| 2     | Diaspora Protect complet                | **TERMINÉ**                              | Transactions, invitations, contrats, jalons, documents chiffrés, litiges avec gel des libérations, notifications ; **noyau du registre** et **partenaire de paiement sandbox** livrés parce que Protect en dépend |
| 3     | Wallet, Business, KYC contractualisable | **SUIVANT**                              | UI Wallet multi-devises, retraits simulés, factures/devis/rapports, adaptateurs KYC/sanctions prêts pour un fournisseur agréé, files de revue enrichies                                                           |
| 4     | Diaspora Transfer                       | Planifié                                 | Cotation FX, machine à états `Transfer`, revue `REVIEW_REQUIRED`, prestataire simulé puis — sous conditions — partenaire agréé                                                                                    |
| 5     | API publique et recherche DDA           | Planifié                                 | Clés API, scopes, webhooks signés, idempotence, OpenAPI ; simulation DDA strictement interne                                                                                                                      |
| Live  | Activité réelle                         | **Bloqué** par les portes réglementaires | Uniquement après autorisations, contrats partenaires et audit de sécurité indépendant                                                                                                                             |

---

## 2. Phase 0 — Cadrage et socle technique (TERMINÉ)

| Livrable                                                                                                                                                     | État  | Emplacement                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------------------- |
| Monorepo pnpm (`apps/api`, `apps/web`, `packages/*`), TypeScript strict, Prettier, ESLint                                                                    | Livré | racine, `tsconfig.base.json`                                                      |
| Schéma PostgreSQL / Prisma 6 (identité, organisations, vérification, Protect, registre, partenaires, transferts, gouvernance, API, DDA) + migration initiale | Livré | `packages/database/prisma/schema.prisma`, `prisma/migrations/20261011024233_init` |
| Énumérations partagées miroir du schéma, codes d'erreur stables, utilitaires monétaires `BigInt`, pays et corridors                                          | Livré | `packages/shared/src/{enums,errors,money,countries}.ts`                           |
| Machines à états explicites (`Transaction`, `Milestone`, `Dispute`, `FundingRequest`, `Transfer`)                                                            | Livré | `packages/shared/src/state-machines/`                                             |
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
| MFA TOTP (`otplib`), secret chiffré AES-256-GCM, `Session.mfaVerified`, code `MFA_REQUIRED`                      | Livré | Passkeys : évolution Phase 3+                    |
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
| Moteur de risque explicable (8 règles) et files `RiskAlert` avec actions `START_REVIEW` / `CONFIRM` / `DISMISS` / `CONTEST`                                              | Livré | `packages/compliance/src/risk`          |
| Historique immuable `TransactionEvent`, notifications in-app + e-mail (journal)                                                                                          | Livré | `TransactionEventType`                  |
| Tâches planifiées BullMQ : expiration des invitations et financements, réconciliation périodique                                                                         | Livré | Repli en mémoire sans Redis             |
| Tests : unitaires (packages), intégration API (`TEST_DATABASE_URL`), e2e Playwright du scénario à 12 étapes et du scénario de litige                                     | Livré | `PRODUCT_REQUIREMENTS.md` §6            |

## 5. Phase 3 — Wallet, Business, KYC contractualisable (SUIVANT)

| Livrable                                                                                                                                                                  | Dépend de                              | Critère de sortie                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| UI Diaspora Wallet : soldes par devise dérivés du registre, historique paginé, export CSV                                                                                 | Phase 2 (registre)                     | Aucun solde stocké hors registre ; export cohérent avec `getBalance`             |
| Retraits simulés (`WITHDRAWAL`) vers le partenaire sandbox, file d'exécution                                                                                              | Partenaire sandbox                     | Idempotence et réconciliation sans écart                                         |
| Dépôts sandbox administrés (`sandboxDepositSchema`) avec piste d'audit                                                                                                    | RBAC `sandbox:partner_simulate`        | Visible dans `AuditLog`                                                          |
| Diaspora Business : factures, devis, rapports par période, numérotation séquentielle par organisation                                                                     | Organisations                          | Génération PDF, lien facture ↔ transaction                                      |
| Adaptateur KYC/sanctions pour un fournisseur agréé (interface `KycProvider` / `SanctionsProvider`), activé uniquement par `KYC_PROVIDER` ≠ `sandbox` **et** contrat signé | `packages/compliance/src/kyc/types.ts` | Résultats non simulés distingués (`simulated = false`), revue manuelle conservée |
| Files de revue conformité enrichies : SLA, assignation, filtres, export                                                                                                   | Phase 2                                | Aucune décision sans `note`                                                      |
| Passkeys (WebAuthn) en complément de la TOTP                                                                                                                              | Phase 1                                | Enrôlement + authentification sans régression                                    |
| Stockage objet S3-compatible chiffré (remplace `STORAGE_DIR`)                                                                                                             | Phase 2                                | Clés gérées par KMS, rotation documentée                                         |
| Tests de charge et de concurrence étendus (registre, files)                                                                                                               | —                                      | Objectifs `PRODUCT_REQUIREMENTS.md` §5                                           |

## 6. Phase 4 — Diaspora Transfer (Planifié)

| Livrable                                                                                           | Dépend de                  | Notes                                                                       |
| -------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| Parcours `CREATED → QUOTED → AUTHORIZED → PROCESSING → SETTLED` avec `REVIEW_REQUIRED`             | `transferMachine`, Phase 3 | Toute cotation est simulée tant qu'aucun partenaire FX n'est contractualisé |
| Cotation FX en fractions entières, expiration, frais explicites                                    | `FXQuote`                  | Deux écritures liées via compte de compensation                             |
| Bénéficiaires structurés, règle de voyage (informations donneur d'ordre / bénéficiaire) préparée   | `CANADA_CANAFE.md`         | Champs présents même en sandbox                                             |
| Détection de structuration (règle des 24 heures) dans le moteur de risque                          | `AML_POLICY.md`            | Agrégation par personne / entité                                            |
| Prestataire simulé de transfert, puis adaptateur partenaire agréé derrière une porte réglementaire | Portes §9                  | Jamais activé sans autorisation                                             |

## 7. Phase 5 — API publique et recherche DDA (Planifié)

| Livrable                                                                                            | Dépend de             | Notes                                                           |
| --------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| Clés API (`ApiCredential`), scopes, rotation, révocation                                            | Phase 1               | Hash stocké, préfixe affiché                                    |
| Webhooks sortants signés (`WebhookSubscription`), tentatives avec repli exponentiel, rejeu protégé  | `signature.ts`        | Secret chiffré au repos                                         |
| Idempotence sur toutes les créations, limitation de débit par clé, quotas                           | Phase 1               | En-tête `Idempotency-Key`                                       |
| OpenAPI publié, portail développeur, environnement bac à sable séparé                               | `openapi:export`      | Toujours sandbox                                                |
| Simulation DDA interne (`DigitalAssetSimulation`), tableau de bord de recherche, rapport de risques | `STABLECOIN_RISKS.md` | Lignes rouges absolues : pas de token public, pas d'argent réel |

---

## 8. Dépendances entre phases

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
                          │            │           │
                          │            │           └─ partenaire FX/transfert (porte R3, R4)
                          │            └─ fournisseur KYC agréé (porte R2)
                          └─ registre + partenaire sandbox (livrés en Phase 2)

Toute phase « live » ──► portes R1 à R7 toutes franchies
```

- Le registre et le partenaire sandbox ont été avancés de la Phase 3 à la Phase 2 : Protect ne peut pas être démontré sans séquestre comptable ni confirmation de financement.
- Le module Transfer réutilise le moteur de risque et la file `REVIEW_REQUIRED` ; il n'est pas démarré avant la stabilisation des files de revue (Phase 3).
- L'API publique expose des parcours déjà éprouvés en interface ; elle ne précède jamais un module.

---

## 9. Portes réglementaires avant toute phase live

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

Franchir une porte signifie : document signé, référence d'autorisation ou avis écrit archivé, décision consignée dans un ADR et modification du garde `DFN_MODE` revue par deux personnes.

---

## 10. Indicateurs de suivi

| Indicateur                                   | Cible fin Phase 3                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Scénarios e2e verts (12 étapes + litige)     | 100 % à chaque fusion                                                          |
| Écarts de réconciliation en recette          | 0                                                                              |
| Couverture tests `packages/financial-ledger` | ≥ 90 % lignes                                                                  |
| Alertes de risque traitées sans note         | 0                                                                              |
| Pages sans bandeau sandbox                   | 0                                                                              |
| Portes réglementaires franchies              | Suivies dans `AUTHORIZATIONS_CHECKLIST.md` (toutes « À vérifier » aujourd'hui) |
