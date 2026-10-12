# Modèle de données — DFN (PostgreSQL 16, Prisma 6)

> Source de vérité : `packages/database/prisma/schema.prisma` (57 tables, migrations `20261011024233_init`, `20261011050000_phase3_5_wallet_transfer_business_api_dda`, `20261011150000_ledger_entry_seq`, `20261012010000_phase6_passkeys_storage_queues_gates`, `20261012020000_transaction_list_indexes`, `20261012030000_mfa_attempt_lockout` et `20261012040000_legacy_links_need_consent`). Conventions : clés UUID, horodatages UTC (`timestamptz`), états explicites (enums), montants `BigInt` en unités mineures + code ISO 4217 (ou `DDA` pour l'unité fictive), suppression logique (`deletedAt`) pour les utilisateurs, organisations, documents et bénéficiaires.

## Domaines

### Identité & accès

| Modèle                   | Rôle                                                                                                                                                                                            | Contraintes / index notables                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `User`                   | compte (argon2id `passwordHash`, `globalRole` USER/COMPLIANCE/ADMIN, MFA `mfaSecretEnc` chiffré, verrouillage `lockedUntil`, `securityPreferences` JSON, `deletionRequestedAt`, `anonymizedAt`) | `email` unique                                  |
| `Session`                | session serveur (`tokenHash` HMAC, `mfaVerified`, `expiresAt`, `revokedAt`)                                                                                                                     | `tokenHash` unique, index `userId`, `expiresAt` |
| `Organization`           | espace PERSONAL ou BUSINESS, pays, statut KYB                                                                                                                                                   | index `type`                                    |
| `OrganizationMember`     | appartenance + rôle OWNER/ADMIN/MEMBER/VIEWER                                                                                                                                                   | unique (`organizationId`,`userId`)              |
| `OrganizationInvitation` | invitation collaborateur (jeton haché, expiration)                                                                                                                                              | `tokenHash` unique                              |

### Vérification

| Modèle                 | Rôle                                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityVerification` | KYC — `provider` (sandbox), `status` NOT_STARTED/PENDING/**SIMULATED_PASS/SIMULATED_FAIL**/REJECTED/EXPIRED, données déclarées non sensibles, revue staff |
| `BusinessVerification` | KYB — même principe au niveau organisation                                                                                                                |
| `Counterparty`         | carnet d'adresses de contreparties par organisation, `linkedOrganizationId` optionnel vers l'espace DFN de la contrepartie (paiements par portefeuille)   |

### Diaspora Protect

| Modèle                                                | Rôle                                                                                                                           | Contraintes                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `Transaction`                                         | transaction commerciale : `reference` (`DFN-YYYY-XXXXXX`), montants, frais (`feeBps` 150), `status`, `releaseFrozen`, corridor | `reference` unique ; index (`buyerOrganizationId`,`status`), (`sellerOrganizationId`,`status`) |
| `TransactionParty`                                    | acheteur / vendeur, invitation (`inviteTokenHash`), organisation et utilisateur liés                                           | unique (`transactionId`,`role`), `inviteTokenHash` unique                                      |
| `Contract` / `ContractVersion` / `ContractAcceptance` | contrat numérique versionné (`terms` JSON, `bodyText`, `contentHash` SHA-256), acceptations horodatées avec IP/UA              | unique (`contractId`,`version`), unique (`contractVersionId`,`partyId`)                        |
| `Milestone`                                           | jalon : montant, preuves requises, statut PENDING→SUBMITTED→APPROVED→RELEASED, `ledgerTransactionId`                           | unique (`transactionId`,`sequence`)                                                            |
| `Evidence`                                            | lien document ↔ jalon ou litige                                                                                               | index                                                                                          |
| `Document`                                            | métadonnées de fichier chiffré (`storageKey` unique, `sha256`, MIME, taille, `retentionUntil`)                                 | index org/transaction/statut                                                                   |
| `Dispute` / `DisputeMessage` / `DisputeDecision`      | litige, échanges (notes internes staff), décisions motivées (issue, montants, `isFinal`, `executedAt`)                         | index statut                                                                                   |
| `TransactionEvent`                                    | historique immuable (type, acteur, payload) — publié sur le bus d'événements                                                   | index (`transactionId`,`createdAt`)                                                            |

### Registre financier

| Modèle                                           | Rôle                                                                                                                                                                                                                                                        | Contraintes                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Currency`                                       | CAD, USD, EUR, XOF, GNF (`kind = FIAT`) et `DDA` (`kind = SIMULATED_ASSET`, recherche uniquement) avec exposant                                                                                                                                             | PK `code`                                                          |
| `LedgerAccount`                                  | plan de comptes : `code` stable (`ESCROW:<tx>:<ccy>`, `WALLET:<org>:<ccy>`, `PROVIDER_SETTLEMENT:<provider>:<ccy>`, `PLATFORM_FEES:<ccy>`, `FX_CLEARING:<ccy>`, `DDA_ISSUANCE:DDA`, `DDA_HOLDING:<org>:DDA`), type, sens normal, `allowNegative`, `version` | `code` unique                                                      |
| `LedgerTransaction`                              | écriture : `idempotencyKey` unique, `kind`, `status` POSTED/REVERSED, `reversesId`                                                                                                                                                                          | `reversesId` unique                                                |
| `LedgerEntry`                                    | ligne débit/crédit (BigInt, devise) — jamais modifiée ; `seq` monotone (ordre d'insertion sous verrou de compte)                                                                                                                                            | `onDelete: Restrict`                                               |
| `BalanceSnapshot`                                | photos de solde (tâche `BALANCE_SNAPSHOTS`) prises sous verrou de compte, avec `lastSeq` (dernière ligne incluse) pour une réconciliation sans faux écarts                                                                                                  | index (`accountId`,`asOf`)                                         |
| `ReconciliationJob` / `ReconciliationDifference` | résultats de réconciliation (tâche `RECONCILIATION` ou lancement manuel)                                                                                                                                                                                    | —                                                                  |
| `Wallet`                                         | association organisation × devise → compte ledger                                                                                                                                                                                                           | unique (`organizationId`,`currencyCode`), `ledgerAccountId` unique |

### Partenaires, Wallet et transferts

| Modèle            | Rôle                                                                                                                                                                                                | Contraintes                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `PaymentProvider` | partenaire (seul `SANDBOX_PARTNER`, mode SANDBOX)                                                                                                                                                   | `code` unique                                          |
| `ProviderEvent`   | événements partenaire (financements, règlements de transferts), `idempotencyKey` unique (anti-rejeu)                                                                                                | —                                                      |
| `FundingRequest`  | instruction de financement (`reference` SBXF-…, statut PENDING/CONFIRMED/FAILED/EXPIRED/CANCELLED)                                                                                                  | `reference` unique                                     |
| `Beneficiary`     | bénéficiaire structuré d'une organisation : méthode (banque, mobile money…), pays, `accountIdentifierEnc` chiffré + version masquée, statut ACTIVE/REMOVED                                          | index (`organizationId`,`status`)                      |
| `FXQuote`         | devis FX simulé : devises, montants source/destination en unités mineures, taux rationnel (`rateNumerator`/`rateDenominator`), frais, `feeBps`, `expiresAt`, statut ACTIVE/USED/EXPIRED             | index (`organizationId`,`expiresAt`)                   |
| `Transfer`        | transfert : `reference`, devis, bénéficiaire, montants et frais, statut (`transferMachine`), `reviewReason`, `riskScore`, écritures source/destination, `externalRef`, `settledAt`, `failureReason` | `reference` unique ; index (`organizationId`,`status`) |
| `TransferEvent`   | historique immuable du transfert (type, acteur, payload)                                                                                                                                            | index (`transferId`,`createdAt`)                       |

### Diaspora Business

| Modèle                    | Rôle                                                                                                                                                                     | Contraintes                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `Invoice` / `InvoiceLine` | facture `INV-AAAA-0001` par organisation : client, devise, sous-total / taxes / total en unités mineures, échéance, statut (`invoiceMachine`), `transactionId` optionnel | unique (`organizationId`,`number`) |
| `InvoicePayment`          | paiement fictif (virement simulé, espèces, portefeuille → `ledgerTransactionId`), montant, référence                                                                     | index `invoiceId`                  |
| `Quote` / `QuoteLine`     | devis `QUO-AAAA-0001`, validité, statut (`quoteMachine`), `convertedInvoiceId`                                                                                           | unique (`organizationId`,`number`) |

### Gouvernance et exploitation

| Modèle                          | Rôle                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuditLog`                      | journal append-only (acteur, organisation, action, entité, IP/UA, métadonnées sans secrets)                                                          |
| `RiskAlert` / `RiskAlertAction` | alertes explicables (règle, gravité, score, `explanation` JSON) et historique des décisions                                                          |
| `Notification`                  | in-app (+ `sentAt` pour le canal courriel)                                                                                                           |
| `MaintenanceRun`                | exécution d'une tâche planifiée : nom, déclencheur, début/fin, statut RUNNING/COMPLETED/FAILED, résumé JSON — sert de verrou (`JOB_ALREADY_RUNNING`) |

### API partenaires

| Modèle                | Rôle                                                                                                                                                | Contraintes                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ApiCredential`       | clé API d'une organisation : `keyPrefix` affiché, `keyHash` SHA-256, scopes, `rateLimitPerMinute`, `expiresAt`, `lastUsedAt`, `revokedAt`, créateur | `keyHash` unique ; index (`organizationId`) |
| `ApiRequestLog`       | journal des appels par clé (méthode, chemin, statut, durée, IP, `requestId`)                                                                        | index (`credentialId`,`createdAt`)          |
| `IdempotencyRecord`   | réponse mémorisée d'une mutation : clé + organisation, empreinte de requête, statut et corps, `expiresAt` (`IDEMPOTENCY_TTL_HOURS`)                 | unique (`organizationId`,`key`)             |
| `WebhookSubscription` | abonnement : URL (https, hôtes privés refusés), `secretEnc` chiffré, événements, `isActive`, compteur d'échecs consécutifs                          | index (`organizationId`)                    |
| `WebhookDelivery`     | livraison : événement, charge, signature, statut PENDING/DELIVERED/FAILED/EXHAUSTED, tentatives, prochaine tentative, dernier code HTTP             | index (`status`,`nextAttemptAt`)            |

### Recherche DDA (administrateurs uniquement)

| Modèle                   | Rôle                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DigitalAssetSimulation` | opération simulée (MINT / TRANSFER / REDEEM / RESERVE_ADJUSTMENT / STRESS_TEST) : référence, organisations, montant en unités `DDA`, écriture ledger liée, réserve déclarative, métadonnées `simulated: true` + hypothèse |

### Phase 6 — authentification renforcée, exploitation et gouvernance

| Modèle                                   | Rôle                                                                                                                           | Contraintes / notes                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `WebAuthnCredential`                     | passkey d'un utilisateur : identifiant base64url, clé publique COSE, compteur de signatures, transports, appareil, `revokedAt` | `credentialId` unique ; supprimée à l'anonymisation                       |
| `AuthChallenge`                          | défi WebAuthn à usage unique (enrôlement, connexion, step-up) lié à l'utilisateur, à la session et à l'usage, expiration 5 min | `challenge` unique ; purgé par `AUTH_CLEANUP`                             |
| `MfaRecoveryCode`                        | code de secours haché (HMAC), `usedAt` à l'usage                                                                               | 10 par génération ; supprimés à la désactivation MFA et à l'anonymisation |
| `JobLease`                               | bail d'une tâche planifiée : propriétaire (`INSTANCE_ID`), exécution, battement de cœur, expiration                            | clé primaire `jobName`                                                    |
| `RegulatoryGate` / `RegulatoryGateEvent` | portes R1–R10 (suivi uniquement), premier et second approbateur, preuves, historique                                           | aucun statut ne fait sortir du mode sandbox                               |

Champs ajoutés : `User.mfaLastUsedStep` (anti-rejeu TOTP), `User.{mfaFailedCount, mfaLockedUntil}` (verrou des codes par compte), `RiskAlert.{assignedToUserId, assignedAt, dueAt, firstActionAt, slaBreachedAt}` (file de revue), `Document.{storageDriver, encryptionKeyId}`, `Counterparty.{linkStatus, linkRequestedOrganizationId, linkRequestedAt, linkDecidedAt, linkDecidedByUserId}` (`linkedOrganizationId` n'est renseigné que pendant `ACCEPTED` ; les liaisons antérieures au consentement sont remises en `PENDING`), `Invoice.taxBps` / `Quote.taxBps`, `MaintenanceRun.{instanceId, heartbeatAt}`, index `Transaction (buyerOrganizationId|sellerOrganizationId, updatedAt)` et `Transaction (updatedAt)` pour les listes.

## Invariants appliqués par le code

1. Somme des jalons = montant de la transaction (validation à la création) ; somme des lignes = sous-total d'une facture ou d'un devis.
2. Débits = crédits par écriture, une devise par écriture, montants > 0 — une écriture `DDA` ↔ fiat est structurellement impossible.
3. Un compte `allowNegative=false` ne passe jamais sous zéro (verrou ligne + vérification) : portefeuilles, séquestres, détentions DDA.
4. Transition d'état uniquement via les machines de `@dfn/shared` (`transaction`, `milestone`, `dispute`, `funding`, `transfer`, `invoice`, `quote`).
5. Clés d'idempotence ledger : `funding:<fundingRequestId>`, `release:<milestoneId>`, `dispute-release:<decisionId>`, `dispute-refund:<decisionId>`, `transfer:<transferId>:<jambe>`, `invoice-payment:<paymentId>`, `dda:<reference>`.
6. Accès inter-organisations → 404 ; une clé API n'atteint que l'organisation qui l'a émise.
7. Un devis FX expiré ne peut plus être autorisé ; un transfert `REVIEW_REQUIRED` n'est débité qu'après approbation staff.
8. Supply DDA = Σ des détentions : chaque mint / redeem passe par `DDA_ISSUANCE:DDA`.

## Conservation et anonymisation (politique proposée, voir `docs/compliance/DATA_PROTECTION.md`)

- Documents : `retentionUntil` = 7 ans (obligations LBC/FT à confirmer), suppression logique puis purge du blob.
- Sessions : purgées après expiration ; journal d'audit conservé 5 ans minimum.
- Utilisateur supprimé : la demande (`deletionRequestedAt`) est refusée tant que des transactions, organisations ou soldes sont ouverts ; après `ANONYMIZE_AFTER_DAYS`, la tâche `ANONYMIZE_DELETED` remplace e-mail (`deleted-<id>@anonymized.invalid`), nom, téléphone, MFA, mot de passe (aléatoire), préférences et données déclarées KYC, pose `deletedAt` / `anonymizedAt` et révoque les sessions ; **les écritures ledger, événements et journaux d'audit restent immuables** et liés à l'identifiant technique.
- Clés API révoquées et livraisons webhook : conservées pour la traçabilité, secrets chiffrés jamais réaffichés.
- Anonymisation (phase 6) : passkeys, codes de secours et défis supprimés ; demandes de lien en attente vers l'espace personnel révoquées.

## Migrations

`packages/database/prisma/migrations/*` — appliquer avec `pnpm db:migrate` (prod) ou `pnpm db:migrate:dev` (dev). Le seed `pnpm db:seed` crée les comptes de démonstration et trois transactions (financée, clôturée, en attente).
