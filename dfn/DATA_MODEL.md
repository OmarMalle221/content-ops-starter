# Modèle de données — DFN (PostgreSQL 16, Prisma 6)

> Source de vérité : `packages/database/prisma/schema.prisma` (41 tables). Conventions : clés UUID, horodatages UTC (`timestamptz`), états explicites (enums), montants `BigInt` en unités mineures + code ISO 4217, suppression logique (`deletedAt`) pour les utilisateurs, organisations et documents.

## Domaines

### Identité & accès

| Modèle                   | Rôle                                                                                                                         | Contraintes / index notables                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `User`                   | compte (argon2id `passwordHash`, `globalRole` USER/COMPLIANCE/ADMIN, MFA `mfaSecretEnc` chiffré, verrouillage `lockedUntil`) | `email` unique                                  |
| `Session`                | session serveur (`tokenHash` HMAC, `mfaVerified`, `expiresAt`, `revokedAt`)                                                  | `tokenHash` unique, index `userId`, `expiresAt` |
| `Organization`           | espace PERSONAL ou BUSINESS, pays, statut KYB                                                                                | index `type`                                    |
| `OrganizationMember`     | appartenance + rôle OWNER/ADMIN/MEMBER/VIEWER                                                                                | unique (`organizationId`,`userId`)              |
| `OrganizationInvitation` | invitation collaborateur (jeton haché, expiration)                                                                           | `tokenHash` unique                              |

### Vérification

| `IdentityVerification` | KYC — `provider` (sandbox), `status` NOT_STARTED/PENDING/**SIMULATED_PASS/SIMULATED_FAIL**/REJECTED/EXPIRED, données déclarées non sensibles, revue staff |
| `BusinessVerification` | KYB — même principe au niveau organisation |
| `Counterparty` | carnet d'adresses de contreparties par organisation |

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
| `TransactionEvent`                                    | historique immuable (type, acteur, payload)                                                                                    | index (`transactionId`,`createdAt`)                                                            |

### Registre financier

| Modèle                                           | Rôle                                                                                                                                                                                      | Contraintes                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `Currency`                                       | CAD, USD, EUR, XOF, GNF avec exposant                                                                                                                                                     | PK `code`                                                          |
| `LedgerAccount`                                  | plan de comptes : `code` stable (`ESCROW:<tx>:<ccy>`, `WALLET:<org>:<ccy>`, `PROVIDER_SETTLEMENT:<provider>:<ccy>`, `PLATFORM_FEES:<ccy>`), type, sens normal, `allowNegative`, `version` | `code` unique                                                      |
| `LedgerTransaction`                              | écriture : `idempotencyKey` unique, `kind`, `status` POSTED/REVERSED, `reversesId`                                                                                                        | `reversesId` unique                                                |
| `LedgerEntry`                                    | ligne débit/crédit (BigInt, devise) — jamais modifiée                                                                                                                                     | `onDelete: Restrict`                                               |
| `BalanceSnapshot`                                | photos de solde pour la continuité                                                                                                                                                        | index (`accountId`,`asOf`)                                         |
| `ReconciliationJob` / `ReconciliationDifference` | résultats de réconciliation                                                                                                                                                               | —                                                                  |
| `Wallet`                                         | association organisation × devise → compte ledger                                                                                                                                         | unique (`organizationId`,`currencyCode`), `ledgerAccountId` unique |

### Partenaires & transferts

| `PaymentProvider` | partenaire (seul `SANDBOX_PARTNER`, mode SANDBOX) |
| `ProviderEvent` | événements partenaire, `idempotencyKey` unique (anti-rejeu) |
| `FundingRequest` | instruction de financement (`reference` SBXF-…, statut PENDING/CONFIRMED/FAILED/EXPIRED/CANCELLED) |
| `FXQuote`, `Transfer` | **réservés phase 4** (machine à états déjà définie) |

### Gouvernance

| `AuditLog` | journal append-only (acteur, organisation, action, entité, IP/UA, métadonnées sans secrets) |
| `RiskAlert` / `RiskAlertAction` | alertes explicables (règle, gravité, score, `explanation` JSON) et historique des décisions |
| `Notification` | in-app (+ `sentAt` pour le canal courriel) |
| `ApiCredential`, `WebhookSubscription` | **réservés phase 5** |
| `DigitalAssetSimulation` | **réservé phase 5** (DDA, recherche uniquement) |

## Invariants appliqués par le code

1. Somme des jalons = montant de la transaction (validation à la création).
2. Débits = crédits par écriture, une devise par écriture, montants > 0.
3. Un compte `allowNegative=false` ne passe jamais sous zéro (verrou ligne + vérification).
4. Transition d'état uniquement via les machines de `@dfn/shared`.
5. Clés d'idempotence : `funding:<fundingRequestId>`, `release:<milestoneId>`, `dispute-release:<decisionId>`, `dispute-refund:<decisionId>`.
6. Accès inter-organisations → 404.

## Conservation et anonymisation (politique proposée, voir `docs/compliance/DATA_PROTECTION.md`)

- Documents : `retentionUntil` = 7 ans (obligations LBC/FT à confirmer), suppression logique puis purge du blob.
- Sessions : purgées après expiration ; journal d'audit conservé 5 ans minimum.
- Utilisateur supprimé : `deletedAt` + anonymisation différée des champs d'identité (migration prévue), les écritures ledger restent immuables.

## Migrations

`packages/database/prisma/migrations/*` — appliquer avec `pnpm db:migrate` (prod) ou `pnpm db:migrate:dev` (dev). Le seed `pnpm db:seed` crée les comptes de démonstration et trois transactions (financée, clôturée, en attente).
