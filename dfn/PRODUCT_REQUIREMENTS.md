# Diaspora Financial Network (DFN) — Exigences produit

> **Nom commercial :** Diaspora Trust  
> **Mode d'exécution :** `sandbox` uniquement — « Données fictives — Aucun fonds réel »  
> **Version du document :** 1.0 (itération Phases 0–2) — 2026-10-11  
> **Public :** équipe produit, ingénierie, conformité, partenaires potentiels

Ce document décrit _ce que_ la plateforme fait et _pourquoi_. Les choix techniques sont consignés dans `docs/decisions/` (ADR), la sécurité dans `SECURITY.md`, le calendrier dans `ROADMAP.md` et les obligations réglementaires dans `docs/compliance/`.

---

## 1. Vision

Les échanges commerciaux entre l'Afrique et sa diaspora (achat d'un véhicule, d'un terrain, de marchandises, prestation d'un artisan, paiement d'un fournisseur) souffrent d'un déficit de confiance : l'acheteur paie à l'aveugle, le vendeur livre sans garantie d'être payé, et aucun des deux ne dispose d'un historique vérifiable en cas de litige.

DFN construit une **infrastructure de transactions commerciales internationales vérifiées** :

- un **paiement conditionnel** (workflow de type séquestre) libéré jalon par jalon sur présentation de preuves ;
- un **contrat numérique** horodaté et hashé, accepté par les deux parties ;
- une **traçabilité comptable** à double entrée, idempotente et réversible ;
- une **conformité explicable** : vérification d'identité, score de risque consultatif, files de revue humaines ;
- un **cadre de litiges** avec gel automatique des libérations et décision motivée.

Corridor de lancement : **Canada → Sénégal**. Expansion : Guinée, Côte d'Ivoire, Europe → Afrique, États-Unis → Afrique (voir `packages/shared/src/countries.ts`, `CORRIDORS`).

### Principes non négociables

| #   | Principe                                                       | Traduction produit                                                                                                                                                                                        |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Sandbox uniquement                                             | Chaque écran, chaque e-mail, chaque réponse API porte la mention « Données fictives — Aucun fonds réel » (`SANDBOX_DISCLAIMER`, en-tête `x-dfn-mode`). L'API refuse de démarrer si `DFN_MODE != sandbox`. |
| P2  | Les fonds réels sont toujours détenus par un prestataire agréé | La plateforme n'émet que des instructions et enregistre des événements partenaires (`PaymentProviderAdapter`). Aucun adaptateur « live » n'existe dans ce dépôt.                                          |
| P3  | Aucune vérification simulée n'est présentée comme réelle       | Statuts `SIMULATED_PASS` / `SIMULATED_FAIL`, champ `simulated: true`, badge « simulé » dans l'interface.                                                                                                  |
| P4  | Le score de risque est consultatif                             | Jamais de refus, de blocage ou de confiscation automatique ; recommandation `NONE` / `MONITOR` / `MANUAL_REVIEW` traitée par un humain.                                                                   |
| P5  | Registre comptable inviolable                                  | Double entrée, montants `BigInt` en unités mineures, clé d'idempotence, contre-passations au lieu de suppressions, verrouillage de lignes.                                                                |
| P6  | Autorisation côté serveur                                      | Matrice RBAC unique (`packages/shared/src/permissions.ts`), isolation stricte par organisation.                                                                                                           |

---

## 2. Personas

| #   | Persona                                                                                        | Rôle système                                                   | Besoin principal                                                                                  | Peur principale                                        |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | **Aminata**, 34 ans, infirmière à Montréal, achète une voiture d'occasion à Dakar pour sa mère | `USER`, org `PERSONAL` (CA), rôle `OWNER`, partie `BUYER`      | Payer uniquement quand la voiture est livrée et conforme                                          | Virer 4 000 CAD et ne jamais voir le véhicule          |
| 2   | **Moussa**, 41 ans, concessionnaire à Dakar                                                    | `USER`, org `BUSINESS` (SN), `OWNER`, partie `SELLER`          | Être certain que l'argent existe avant d'expédier                                                 | Livrer et ne jamais être payé ; subir un litige abusif |
| 3   | **Fatou**, 29 ans, entrepreneure à Toronto, importe du tissu et des cosmétiques                | `USER`, org `BUSINESS` (CA), `OWNER`, `BUYER` récurrente       | Gérer plusieurs transactions en parallèle, archiver factures et preuves                           | Perdre la trace des documents douaniers                |
| 4   | **Ibrahima**, 52 ans, fournisseur agricole à Conakry (corridor d'expansion)                    | `USER`, org `BUSINESS` (GN), `SELLER`                          | Recevoir des paiements en GNF via un partenaire local                                             | Taux de change opaque, délais                          |
| 5   | **Khady**, 38 ans, directrice d'une PME de BTP à Abidjan avec 6 collaborateurs                 | `OWNER` d'une org `BUSINESS` (CI)                              | Donner des accès différenciés à son équipe (Diaspora Business)                                    | Qu'un employé engage l'entreprise sans contrôle        |
| 6   | **Cheikh**, 27 ans, comptable de la PME de Khady                                               | `MEMBER` puis `VIEWER`                                         | Consulter soldes, rapports, exporter l'historique                                                 | Modifier une transaction par erreur                    |
| 7   | **Marie**, 45 ans, agente de conformité DFN                                                    | `COMPLIANCE`                                                   | Traiter les files de revue (vérifications, alertes de risque, litiges) avec un historique complet | Prendre une décision sans justification traçable       |
| 8   | **Omar**, 36 ans, administrateur plateforme                                                    | `ADMIN`                                                        | Gérer les utilisateurs, simuler le partenaire sandbox, consulter l'audit                          | Une action irréversible sans piste d'audit             |
| 9   | **Sékou**, 31 ans, développeur chez un intégrateur logistique (Phase 5)                        | Clé API `ApiCredential` avec scopes                            | Créer des transactions et recevoir des webhooks signés                                            | Rejouer un paiement par erreur (idempotence)           |
| 10  | **Auditrice externe / régulateur**                                                             | Accès lecture via `COMPLIANCE` (`admin:audit`, `admin:ledger`) | Reconstituer n'importe quel flux de bout en bout                                                  | Des données supprimées ou modifiées a posteriori       |

---

## 3. Modules

| Module | Nom                          | Priorité | Statut (cette itération)                                                                    | Dépendances                                                          |
| ------ | ---------------------------- | -------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A      | Diaspora Protect             | **P0**   | **Implémenté** (Phase 2)                                                                    | Ledger core, partenaire sandbox, KYC sandbox, moteur de risque       |
| B      | Diaspora Wallet              | P1       | Noyau ledger implémenté ; UI/retraits planifiés (Phase 3)                                   | Ledger core                                                          |
| C      | Diaspora Transfer            | P1       | Schéma + machine à états réservés (Phase 4)                                                 | Partenaire de paiement, cotation FX                                  |
| D      | Diaspora Business            | P1       | Organisations multi-utilisateurs implémentées ; factures/devis/rapports planifiés (Phase 3) | RBAC, Wallet                                                         |
| E      | Diaspora API                 | P2       | Schéma `ApiCredential` / `WebhookSubscription` réservé (Phase 5)                            | Idempotence, signature HMAC                                          |
| F      | Diaspora Digital Asset (DDA) | P3       | Recherche / sandbox uniquement ; schéma `DigitalAssetSimulation` réservé (Phase 5)          | Aucune dépendance de production — jamais en production dans ce dépôt |

### 3.1 Module A — Diaspora Protect (P0)

Paiement conditionnel entre un acheteur et un vendeur situés dans deux pays différents.

- Création de transaction : titre, description, catégorie (`VEHICLE`, `GOODS`, `SERVICES`, `REAL_ESTATE`, `OTHER`), devise (`CAD`, `USD`, `EUR`, `XOF`, `GNF`), montant en chaîne décimale convertie en unités mineures, corridor origine → destination (différents obligatoirement), 1 à 12 jalons, preuves requises par jalon (`DocumentKind`).
- Invitation du vendeur par e-mail avec jeton haché et expiration ; inscription directe depuis l'invitation.
- Contrat numérique généré depuis le gabarit `DFN_PROTECT_CONDITIONAL_PAYMENT` v`1.0.0-sandbox` (FR/EN), versionné, hashé SHA-256 (`ContractVersion.contentHash`), accepté par chaque partie avec IP, user-agent et horodatage (`ContractAcceptance`).
- Vérification d'identité (KYC) et d'entreprise (KYB) via l'adaptateur sandbox, statut visible sur la transaction.
- Demande de financement : instructions fictives du partenaire simulé (référence `SBXF-…`, expiration 72 h), confirmation par webhook simulé signé HMAC-SHA256 et idempotent (`ProviderEvent.idempotencyKey`).
- Exécution par jalons : soumission avec documents, demande de modifications, approbation, libération ; chaque libération produit une écriture `RELEASE` + `FEE` dans le registre.
- Frais de plateforme simulés : `feeBps = 150` (1,5 %) par défaut, arrondi demi-supérieur en entiers.
- Documents chiffrés au repos (AES-256-GCM), hash SHA-256, revue par la conformité (`PENDING_REVIEW` → `ACCEPTED` / `REJECTED`).
- Litiges : ouverture par l'une des parties lorsque des fonds sont détenus, gel automatique des libérations (`releaseFrozen`), messages, preuves, décision motivée, appel, exécution comptable de l'issue.
- Historique immuable (`TransactionEvent`), notifications in-app et e-mail (journal en sandbox).
- Annulation sans mouvement de fonds tant que la transaction n'est pas financée ; remboursement intégral possible après financement en dehors d'un litige.

### 3.2 Module B — Diaspora Wallet (P1)

- Soldes multi-devises **simulés**, dérivés exclusivement du registre (`Wallet.ledgerAccountId` → `LedgerAccount` de type `LIABILITY`, code `WALLET:<org>:<ccy>`). Aucun solde n'est stocké en dur.
- Un portefeuille par couple (organisation, devise) ; création paresseuse à la première libération.
- Historique des écritures paginé, instantanés (`BalanceSnapshot`) et réconciliation (`ReconciliationJob`).
- Dépôts sandbox par un `ADMIN` (`sandbox:partner_simulate`) pour les démonstrations.
- Planifié : retraits simulés vers le partenaire (`WITHDRAWAL`), conversion FX par deux écritures liées via un compte de compensation.

### 3.3 Module C — Diaspora Transfer (P1, Phase 4)

- Machine à états : `CREATED → QUOTED → AUTHORIZED → PROCESSING → SETTLED`, avec sorties `FAILED`, `EXPIRED`, `CANCELLED` et détour `REVIEW_REQUIRED` (revue humaine avant autorisation).
- Cotation FX (`FXQuote`) exprimée en fraction entière (`rateNumerator / rateDenominator`), frais et montant destination en unités mineures, expiration.
- Bénéficiaire structuré (`Transfer.beneficiary`), motif d'échec explicite.
- Exécution par un prestataire simulé ; tout prestataire réel suppose les autorisations listées dans `docs/compliance/AUTHORIZATIONS_CHECKLIST.md`.

### 3.4 Module D — Diaspora Business (P1)

- Organisations `PERSONAL` (créée automatiquement à l'inscription) et `BUSINESS` (nom légal, numéro d'immatriculation, site web, vérification KYB).
- Membres et rôles `OWNER` / `ADMIN` / `MEMBER` / `VIEWER`, invitations par jeton, journal d'audit par organisation.
- Carnet de contreparties (`Counterparty`).
- Planifié (Phase 3) : factures, devis, rapports d'activité exportables, filtres par période et par devise.

### 3.5 Module E — Diaspora API (P2, Phase 5)

- Clés API par organisation (`keyPrefix` affiché, `keyHash` stocké), scopes, révocation, dernière utilisation.
- Webhooks sortants signés (`WebhookSubscription.secretEnc`, signature `HMAC-SHA256(timestamp.rawBody)`), rejeu protégé par horodatage.
- Idempotence obligatoire sur toute création (`Idempotency-Key`), limitation de débit, documentation OpenAPI exportée (`openapi:export`).

### 3.6 Module F — Diaspora Digital Asset « DDA » (P3, recherche)

- Simulation interne d'unités comptables (`DigitalAssetSimulation` : `MINTED`, `TRANSFERRED`, `REDEEMED`, `VOID`) adossée à l'hypothèse de travail **1 DDA = 1 USD**, **jamais présentée comme garantie**.
- Aucun déploiement sur une blockchain publique, aucun échange contre un actif réel, aucune annonce d'émission. Analyse de risques dans `docs/compliance/STABLECOIN_RISKS.md`.

---

## 4. Workflows du Module A

### 4.1 Cycle de vie nominal en 11 étapes

| Étape | Acteur                                                                         | Action                                                                                        | État transaction                                        | Effets système                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | Acheteur                                                                       | Crée la transaction (brouillon) avec jalons et conditions                                     | `DRAFT`                                                 | `Transaction`, `Milestone[]`, `TransactionParty(BUYER)`, événement `transaction.created`, évaluation de risque `transaction.created`                                                                                                 |
| 2     | Acheteur                                                                       | Envoie l'invitation au vendeur                                                                | `PENDING_ACCEPTANCE`                                    | `TransactionParty(SELLER, INVITED)` avec `inviteTokenHash` + expiration, e-mail (journal en sandbox), événement `transaction.party_invited`                                                                                          |
| 3     | Vendeur                                                                        | Ouvre le lien, s'inscrit ou se connecte, accepte l'invitation en choisissant son organisation | `ACCEPTED`                                              | Partie `ACCEPTED`, `sellerOrganizationId` renseigné, événement `transaction.party_accepted`                                                                                                                                          |
| 4     | Système                                                                        | Génère le contrat numérique à partir des conditions                                           | `ACCEPTED`                                              | `Contract` + `ContractVersion` v1 (`templateCode`, `templateVersion`, `terms`, `bodyText`, `contentHash`), événement `contract.generated`                                                                                            |
| 5     | Acheteur puis vendeur                                                          | Acceptent les conditions                                                                      | `ACCEPTED` → `AWAITING_FUNDING` après la 2e acceptation | `ContractAcceptance` (IP, UA, horodatage), `Contract.status = ACCEPTED`, événement `contract.accepted`                                                                                                                               |
| 6     | Parties                                                                        | Soumettent leur vérification d'identité si elle est exigée                                    | `AWAITING_FUNDING`                                      | `IdentityVerification` via adaptateur sandbox → `SIMULATED_PASS` / `SIMULATED_FAIL`, événements `verification.required` / `verification.completed`                                                                                   |
| 7     | Acheteur                                                                       | Demande les instructions de financement                                                       | `AWAITING_FUNDING`                                      | `FundingRequest(PENDING)` avec référence `SBXF-…`, instructions fictives, expiration 72 h, événement `funding.requested`                                                                                                             |
| 8     | Partenaire simulé (déclenché par un `ADMIN` ou `SANDBOX_AUTO_CONFIRM_FUNDING`) | Confirme la réception des fonds                                                               | `FUNDED`                                                | `ProviderEvent` idempotent, `FundingRequest(CONFIRMED)`, écriture ledger `FUNDING` (débit `PROVIDER_SETTLEMENT`, crédit `ESCROW:<tx>`), événement `funding.confirmed`                                                                |
| 9     | Vendeur                                                                        | Téléverse les preuves et soumet le jalon                                                      | `IN_PROGRESS`                                           | `Document` chiffré + `Evidence`, `Milestone(SUBMITTED)`, événements `document.uploaded`, `milestone.submitted`, règle `DOCUMENT_REUSE` évaluée                                                                                       |
| 10    | Acheteur                                                                       | Inspecte ; approuve ou demande des modifications                                              | `IN_PROGRESS`                                           | `Milestone(APPROVED)` ou `(CHANGES_REQUESTED)` avec note, événements correspondants                                                                                                                                                  |
| 11    | Système                                                                        | Libère le jalon approuvé ; après le dernier jalon, règle la transaction                       | `IN_PROGRESS` → `SETTLED`                               | Écritures `RELEASE` (débit `ESCROW`, crédit `WALLET:<vendeur>`) et `FEE` (crédit `PLATFORM_FEES`), `Milestone(RELEASED)`, exécution simulée du partenaire (`executeRelease`), événements `milestone.released`, `transaction.settled` |

Règles transversales :

- Toute transition passe par `transactionMachine.assertTransition` ; une transition invalide renvoie `INVALID_TRANSITION`.
- Une libération est refusée (`RELEASE_FROZEN`) tant que `releaseFrozen = true`.
- Une annulation n'est possible que dans `DRAFT`, `PENDING_ACCEPTANCE`, `ACCEPTED`, `AWAITING_FUNDING` (`CANCELLABLE_TRANSACTION_STATES`) : aucun fonds n'a été reçu.
- Les invitations et demandes de financement expirent (`EXPIRED`) via des tâches planifiées (BullMQ).

### 4.2 Gestion des litiges

| Étape | Acteur              | Action                                                                                                                                 | États                                                                     | Effets                                                                                                                                       |
| ----- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | Acheteur ou vendeur | Ouvre une contestation (motif, description ≥ 20 caractères, jusqu'à 10 preuves) alors que la transaction est `FUNDED` ou `IN_PROGRESS` | Transaction → `DISPUTED`, Dispute `OPEN`                                  | `releaseFrozen = true`, événements `dispute.opened`, `release.frozen`, règle `MULTI_DISPUTE_ACCOUNT` évaluée, notification de l'autre partie |
| D2    | Les deux parties    | Échangent des messages et déposent des preuves                                                                                         | `OPEN`                                                                    | `DisputeMessage` (publics), `Evidence`                                                                                                       |
| D3    | Conformité          | Prend en charge le dossier                                                                                                             | `UNDER_REVIEW`                                                            | `assignedToUserId`, notes internes (`internal = true`, jamais visibles des parties)                                                          |
| D4    | Conformité          | Rend une décision motivée                                                                                                              | `DECIDED`                                                                 | `DisputeDecision` (`outcome`, montants, `rationale` ≥ 20 caractères, `isFinal`), `appealDeadline` si non finale                              |
| D5    | Partie perdante     | Demande une révision (motifs) avant l'échéance                                                                                         | `APPEALED`                                                                | Nouvelle décision requise ; une décision `isFinal = true` clôt la voie d'appel interne                                                       |
| D6    | Système             | Exécute la décision finale                                                                                                             | `CLOSED` ; transaction → `SETTLED`, `REFUNDED`, `IN_PROGRESS` ou `FUNDED` | Écritures `RELEASE` / `REFUND` selon l'issue, `releaseFrozen = false`, événements `dispute.decided`, `release.unfrozen`, `dispute.closed`    |

Issues possibles : `RELEASE_TO_SELLER`, `REFUND_TO_BUYER`, `SPLIT` (montants vendeur et acheteur obligatoires, somme égale au solde séquestré), `DISMISSED` (la transaction reprend son cours). Politique détaillée : `docs/compliance/DISPUTE_HANDLING.md`.

### 4.3 Machines à états (source : `packages/shared/src/state-machines/index.ts`)

| Entité             | Transitions autorisées                                                                                                                                                                                                                                                                                                   | États terminaux                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Transaction        | `DRAFT→PENDING_ACCEPTANCE/CANCELLED` ; `PENDING_ACCEPTANCE→ACCEPTED/CANCELLED/EXPIRED` ; `ACCEPTED→AWAITING_FUNDING/CANCELLED` ; `AWAITING_FUNDING→FUNDED/CANCELLED/EXPIRED` ; `FUNDED→IN_PROGRESS/DISPUTED/REFUNDED/SETTLED` ; `IN_PROGRESS→DISPUTED/SETTLED/REFUNDED` ; `DISPUTED→IN_PROGRESS/FUNDED/SETTLED/REFUNDED` | `SETTLED`, `REFUNDED`, `CANCELLED`, `EXPIRED` |
| Milestone          | `PENDING→SUBMITTED/CANCELLED/REFUNDED` ; `SUBMITTED→APPROVED/CHANGES_REQUESTED/CANCELLED/REFUNDED` ; `CHANGES_REQUESTED→SUBMITTED/CANCELLED/REFUNDED` ; `APPROVED→RELEASED/REFUNDED`                                                                                                                                     | `RELEASED`, `REFUNDED`, `CANCELLED`           |
| Dispute            | `OPEN→UNDER_REVIEW/CLOSED` ; `UNDER_REVIEW→DECIDED/CLOSED` ; `DECIDED→APPEALED/CLOSED` ; `APPEALED→DECIDED/CLOSED`                                                                                                                                                                                                       | `CLOSED`                                      |
| FundingRequest     | `PENDING→CONFIRMED/FAILED/EXPIRED/CANCELLED`                                                                                                                                                                                                                                                                             | `CONFIRMED`, `FAILED`, `EXPIRED`, `CANCELLED` |
| Transfer (Phase 4) | `CREATED→QUOTED/CANCELLED/EXPIRED` ; `QUOTED→AUTHORIZED/EXPIRED/CANCELLED/REVIEW_REQUIRED` ; `AUTHORIZED→PROCESSING/CANCELLED/REVIEW_REQUIRED` ; `REVIEW_REQUIRED→AUTHORIZED/CANCELLED/FAILED` ; `PROCESSING→SETTLED/FAILED`                                                                                             | `SETTLED`, `FAILED`, `EXPIRED`, `CANCELLED`   |

---

## 5. Exigences non fonctionnelles

| Domaine                 | Exigence                                                                                                                            | Vérification                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sécurité                | Voir `SECURITY.md` : argon2id, sessions en base, MFA TOTP, RBAC serveur, CSP, chiffrement des documents, limitation de débit        | Revue de sécurité à chaque phase, tests d'intégration des gardes                                                    |
| Intégrité financière    | Chaque écriture est équilibrée, idempotente, en `BigInt` ; aucune suppression ; réconciliation sans écart                           | Tests unitaires `validateEntries`, tests de concurrence (postings parallèles sur le même compte), job `reconcile()` |
| Traçabilité             | Toute action métier produit un `AuditLog` et/ou un `TransactionEvent` horodaté avec acteur, IP et user-agent                        | Scénario d'acceptation étape 12                                                                                     |
| Disponibilité (sandbox) | Objectif 99 % en heures ouvrées ; dégradation gracieuse si Redis est absent (files en mémoire + avertissement)                      | Démarrage sans `REDIS_URL`                                                                                          |
| Performance             | Liste de transactions paginée (≤ 100 par page) < 500 ms p95 sur 100 000 transactions ; écriture ledger < 100 ms p95 hors contention | Tests de charge Phase 3                                                                                             |
| Internationalisation    | FR par défaut, EN disponible ; formats monétaires `fr-CA` ; `XOF` et `GNF` sans décimales                                           | Tests `formatMoney`                                                                                                 |
| Accessibilité           | WCAG 2.1 AA sur les parcours critiques (inscription, transaction, litige)                                                           | Audit manuel + axe                                                                                                  |
| Portabilité             | Monorepo pnpm, Node ≥ 22, PostgreSQL, Redis ; un seul `.env`                                                                        | `pnpm dev` démarre web + API                                                                                        |
| Observabilité           | Logs structurés pino avec `requestId`, redaction des données sensibles ; métriques de files BullMQ                                  | Revue des logs en recette                                                                                           |
| Résidence des données   | Déploiement initial au Canada ; contraintes UEMOA/Sénégal analysées dans `docs/compliance/DATA_PROTECTION.md`                       | Décision avant toute phase live                                                                                     |

---

## 6. Critères d'acceptation

### 6.1 Scénario obligatoire de bout en bout (12 étapes)

Le scénario doit être rejouable en e2e (Playwright) et en intégration API (supertest) sur une base de test vierge.

| #   | Étape                                                                                                                                                                  | Résultat attendu                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Aminata s'inscrit (`CA`, mot de passe ≥ 12 caractères avec minuscule, majuscule, chiffre, acceptation des conditions) puis active la MFA TOTP                          | `User` créé, org `PERSONAL` créée avec rôle `OWNER`, `mfaEnabled = true`, `mfaSecretEnc` chiffré, `Session.mfaVerified = true` après saisie du code                                                                                                                                            |
| 2   | Elle se déconnecte et se reconnecte ; 5 tentatives avec un mauvais mot de passe sur un autre compte                                                                    | Cookie `dfn_session` httpOnly ; le compte visé passe `lockedUntil` non nul, réponse `ACCOUNT_LOCKED`, alerte `REPEATED_LOGIN_FAILURES` créée                                                                                                                                                   |
| 3   | Elle crée une transaction `VEHICLE`, `CA → SN`, `2500.00 CAD`, 2 jalons (`1500.00` « Expédition », `1000.00` « Réception et inspection »), vendeur `moussa@example.sn` | Transaction `PENDING_ACCEPTANCE`, `amountMinor = 250000n`, `feeMinor = 3750n` (150 bps), somme des jalons = montant, e-mail d'invitation journalisé                                                                                                                                            |
| 4   | Moussa ouvre le lien d'invitation, s'inscrit (`SN`, org `BUSINESS`) et accepte                                                                                         | Transaction `ACCEPTED`, partie `SELLER` `ACCEPTED`, `sellerOrganizationId` renseigné                                                                                                                                                                                                           |
| 5   | Le contrat v1 est généré ; Aminata puis Moussa acceptent                                                                                                               | `Contract.status = ACCEPTED`, deux `ContractAcceptance`, `contentHash` identique au re-calcul `hashContract(...)`, transaction `AWAITING_FUNDING`                                                                                                                                              |
| 6   | Chaque partie soumet une vérification d'identité (sandbox)                                                                                                             | Statut `SIMULATED_PASS`, badge « Vérification simulée — aucune vérification réelle » visible ; un test avec `sandboxOutcome = FAIL` donne `SIMULATED_FAIL`                                                                                                                                     |
| 7   | Aminata demande les instructions de financement                                                                                                                        | `FundingRequest(PENDING)` avec référence `SBXF-<ref>-XXXXXX`, instructions contenant « Do not send money », expiration à +72 h                                                                                                                                                                 |
| 8   | Omar (`ADMIN`) simule la confirmation partenaire ; le même webhook est rejoué                                                                                          | Première requête : `ProviderEvent(PROCESSED)`, transaction `FUNDED`, écriture `FUNDING` ; rejeu : aucune nouvelle écriture (`replayed = true`), solde `ESCROW:<tx>:CAD = 250000n`                                                                                                              |
| 9   | Moussa téléverse un PDF `PROOF_OF_SHIPMENT` (≤ 15 Mo) et soumet le jalon 1                                                                                             | `Document.encrypted = true`, `sha256` calculé, `Milestone 1 = SUBMITTED`, transaction `IN_PROGRESS` ; un fichier `.exe` renommé `.pdf` est rejeté (`UNSUPPORTED_FILE`)                                                                                                                         |
| 10  | Aminata approuve le jalon 1                                                                                                                                            | `Milestone 1 = RELEASED`, écritures `RELEASE` + `FEE`, solde `WALLET:<orgMoussa>:CAD` crédité du net, `PLATFORM_FEES:CAD` crédité de la part de frais, `executeRelease` renvoie `EXECUTED_SIMULATED`                                                                                           |
| 11  | Moussa soumet le jalon 2 avec un `INSPECTION_REPORT` ; Aminata demande des modifications puis approuve la re-soumission                                                | Jalon 2 : `SUBMITTED → CHANGES_REQUESTED → SUBMITTED → APPROVED → RELEASED` ; transaction `SETTLED`, `ESCROW:<tx>:CAD = 0n`                                                                                                                                                                    |
| 12  | Marie (`COMPLIANCE`) exécute la réconciliation et consulte l'audit                                                                                                     | `ReconciliationJob(COMPLETED)`, `differencesFound = 0`, débits globaux = crédits globaux par devise ; chaque étape ci-dessus apparaît dans `TransactionEvent` et `AuditLog` ; le bandeau sandbox est présent sur chaque page visitée et l'en-tête `x-dfn-mode: sandbox` sur chaque réponse API |

### 6.2 Scénario de litige

| #   | Étape                                                                                                                   | Résultat attendu                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Reprendre le scénario à l'étape 9 (jalon 1 soumis) ; Aminata ouvre une contestation `NOT_AS_DESCRIBED` avec deux photos | Dispute `OPEN`, transaction `DISPUTED`, `releaseFrozen = true`, événement `release.frozen`                                                                                                                                                                                    |
| L2  | Aminata tente d'approuver le jalon 1 ; Moussa tente de soumettre le jalon 2                                             | Approbation refusée `RELEASE_FROZEN` ; soumission acceptée (les preuves restent possibles) mais aucune libération                                                                                                                                                             |
| L3  | Moussa répond avec un message et un `BILL_OF_LADING`                                                                    | `DisputeMessage` visible des deux parties, `Evidence` liée au litige                                                                                                                                                                                                          |
| L4  | Marie prend le dossier et ajoute une note interne                                                                       | `UNDER_REVIEW`, `assignedToUserId = Marie`, la note `internal = true` n'apparaît pas dans la réponse API des parties                                                                                                                                                          |
| L5  | Marie décide `SPLIT` : `1000.00` vendeur / `500.00` acheteur, `isFinal = false`                                         | `DisputeDecision` enregistrée avec `rationale`, `appealDeadline` fixée ; une décision `SPLIT` sans les deux montants est rejetée en validation                                                                                                                                |
| L6  | Moussa fait appel avec ses motifs                                                                                       | Dispute `APPEALED`, notification à Marie                                                                                                                                                                                                                                      |
| L7  | Marie confirme la décision avec `isFinal = true`                                                                        | Dispute `DECIDED` → `CLOSED`, écritures `RELEASE` (1000.00 → wallet Moussa, frais prélevés) et `REFUND` (500.00 → wallet Aminata), `releaseFrozen = false`, jalon 1 `RELEASED`, jalon 2 `REFUNDED`, transaction `SETTLED` ou `REFUNDED` selon le solde restant, `ESCROW = 0n` |
| L8  | Réconciliation et audit                                                                                                 | Aucun écart ; l'historique des décisions (première décision + décision finale) est intégralement conservé ; aucune ligne supprimée                                                                                                                                            |

### 6.3 Critères transversaux

- Un utilisateur d'une organisation A qui requête une transaction de l'organisation B reçoit `404 NOT_FOUND` (jamais `403`).
- Un `VIEWER` ne peut ni créer de transaction ni téléverser de document (`403 FORBIDDEN`).
- Toute route de mutation sans session valide renvoie `401 UNAUTHENTICATED` ; sans MFA validée lorsque la MFA est activée, `MFA_REQUIRED`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` passent ; le test de concurrence du registre (N libérations simultanées du même séquestre) ne produit jamais de solde négatif.

---

## 7. Hors périmètre explicite en sandbox

| Élément                                                                                 | Raison                                                                                                   | Référence                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Tout mouvement de fonds réels, toute intégration bancaire ou de paiement live           | Absence d'agrément / d'inscription (CANAFE, Banque du Canada, AMF, BCEAO, BCRG) et de contrat partenaire | `docs/compliance/AUTHORIZATIONS_CHECKLIST.md` |
| Vérification d'identité réelle, criblage sanctions réel                                 | Aucun fournisseur contractualisé ; les résultats sandbox sont marqués simulés                            | `docs/compliance/KYC_KYB.md`                  |
| Déclarations réglementaires (DOD/STR, DOI/LCTR, télévirements)                          | Aucune activité réelle à déclarer ; les files de revue préparent le processus                            | `docs/compliance/CANADA_CANAFE.md`            |
| Émission d'un jeton, déploiement sur une blockchain publique, échange DDA ↔ actif réel | Lignes rouges du programme de recherche                                                                  | `docs/compliance/STABLECOIN_RISKS.md`         |
| Cartes de paiement, crédit, épargne rémunérée, assurance                                | Hors mission ; activités réglementées distinctes                                                         | —                                             |
| Conversion de devises à taux réel                                                       | Les cotations FX sont simulées ; aucune promesse de taux                                                 | Module C                                      |
| Décisions automatiques de refus, de blocage ou de confiscation                          | Principe P4 ; revue humaine obligatoire                                                                  | `docs/compliance/AML_POLICY.md`               |
| Suppression physique de données financières                                             | Principe P5 ; anonymisation et contre-passation uniquement                                               | `docs/compliance/DATA_PROTECTION.md`          |
| Garantie de disponibilité contractuelle (SLA)                                           | Environnement de démonstration                                                                           | —                                             |
