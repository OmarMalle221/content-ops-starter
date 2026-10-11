# Vérification de l'identité (KYC) et des entreprises (KYB)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il doit être validé par un conseiller juridique dans chaque juridiction (Canada, Québec, Sénégal, Guinée) avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. En particulier, **les résultats produits par l'adaptateur sandbox ne constituent pas une vérification d'identité** et ne sont jamais présentés comme telle.

| Champ                               | Valeur                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code concerné                       | `packages/compliance/src/kyc/types.ts`, `sandbox.ts`, `registry.ts` ; modèles `IdentityVerification`, `BusinessVerification`, `Organization`, `Document` |
| Variables d'environnement réservées | `KYC_PROVIDER`, `KYC_PROVIDER_API_KEY`, `SANCTIONS_PROVIDER`, `SANCTIONS_PROVIDER_API_KEY`                                                               |
| Statut DFN                          | Sandbox — fournisseur `sandbox` uniquement ; statuts `SIMULATED_PASS` / `SIMULATED_FAIL`                                                                 |
| Porte réglementaire                 | R2 (`ROADMAP.md` §9)                                                                                                                                     |

---

## 1. Règle fondamentale : les résultats sandbox ne sont jamais présentés comme réels

| Mécanisme           | Détail                                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statuts dédiés      | `VerificationStatus` ne contient pas de `PASS` / `VERIFIED` ; seuls `SIMULATED_PASS` et `SIMULATED_FAIL` existent aujourd'hui, à côté de `NOT_STARTED`, `PENDING`, `REJECTED`, `EXPIRED` |
| Drapeau `simulated` | Toute réponse d'adaptateur porte `simulated: true` ; les fournisseurs sandbox déclarent `readonly simulated = true`                                                                      |
| Motifs explicites   | `reasons: ['SANDBOX: no real verification was performed']` ; `raw.notice` rappelle qu'aucun document n'a été vérifié                                                                     |
| Interface           | Badge « Vérification simulée — aucune vérification réelle » partout où un statut est affiché ; aucune coche verte « vérifié »                                                            |
| Fabrique            | `createKycProvider(code)` lève une exception pour tout code autre que `sandbox` ; introduire un fournisseur réel impose du code nouveau, une revue et un contrat                         |
| Données             | `IdentityVerification.provider = 'sandbox'`, `providerRef = 'sbx_id_…'`                                                                                                                  |
| Scénarios           | Le champ `sandboxOutcome: 'FAIL'` ou un nom contenant « FAIL » / « SANCTION » déclenche les chemins d'échec pour les démonstrations ; il est ignoré par tout fournisseur non sandbox     |

## 2. Obligations de vigilance (vue transversale)

| Obligation                                                       | Contenu                                                                                                                                               | Juridictions                                | Correspondance produit                                                                                                                                  | Statut      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Identification et vérification des personnes physiques (CDD)** | Nom, date de naissance, adresse, document d'identité vérifié par une méthode admise (document photo, double processus, agent)                         | CANAFE ; loi 2018-03 (SN) ; loi LBC/FT (GN) | `IdentityVerification` (`documentType`, `issuingCountry`, `dateOfBirth` optionnelle), `Document(kind = IDENTITY)` chiffré ; **adresse postale absente** | Partiel     |
| **Vérification des entités (KYB)**                               | Existence juridique, nom légal, numéro d'immatriculation, dirigeants, nature de l'activité                                                            | Toutes                                      | `BusinessVerification`, `Organization.legalName / registrationNumber`, `Document(kind = BUSINESS_REGISTRATION)`, `businessType`                         | Partiel     |
| **Bénéficiaires effectifs**                                      | Identifier les personnes physiques détenant ou contrôlant 25 % ou plus (Canada) ; seuil à confirmer pour SN/GN ; mesures raisonnables de confirmation | Toutes                                      | **Absent du schéma** → ajouter une structure `beneficialOwners[]` dans `declaredData` ou un modèle dédié                                                | À faire     |
| **Personnes politiquement exposées (PPE/PPV) et DOI**            | Détermination, approbation par la direction, origine des fonds, surveillance renforcée                                                                | Toutes                                      | `SanctionsProvider` extensible aux listes PPE ; champ de statut PPE à ajouter                                                                           | À faire     |
| **Vigilance renforcée (EDD)**                                    | Clients à risque élevé : pays, montants, PPE, activité inhabituelle                                                                                   | Toutes                                      | `VerificationLevel.ENHANCED`, recommandation `MANUAL_REVIEW` du moteur de risque                                                                        | Préparation |
| **Criblage sanctions**                                           | Listes ONU, canadiennes, UEMOA/nationales ; avant la relation et périodiquement                                                                       | Toutes                                      | `SanctionsProvider.screen()` (sandbox) ; re-criblage périodique à planifier                                                                             | Sandbox     |
| **Tiers et mandataires**                                         | Déterminer si le client agit pour un tiers                                                                                                            | CANAFE                                      | Champ à ajouter au flux de création de transaction                                                                                                      | À faire     |
| **Surveillance continue**                                        | Mise à jour des informations, cohérence des opérations avec le profil                                                                                 | Toutes                                      | `averageAmountMinor`, règles `AMOUNT_VS_PROFILE`, `VELOCITY_24H`                                                                                        | Préparation |
| **Expiration et renouvellement**                                 | Revalidation périodique selon le risque                                                                                                               | Toutes                                      | `IdentityVerification.expiresAt`, statut `EXPIRED`                                                                                                      | Préparation |
| **Conservation**                                                 | 5 ans (Canada, à confirmer par type) ; durées UEMOA/Guinée à confirmer                                                                                | Toutes                                      | `retentionUntil` sur `Document` ; politique dans `DATA_PROTECTION.md`                                                                                   | Partiel     |

## 3. Niveaux de vérification dans le produit

| Niveau (`VerificationLevel`) | Déclencheur produit                                                                                                                                                      | Contenu attendu en phase live                                                                | Effet dans le produit                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `BASIC`                      | Toute partie à une transaction Protect avant financement                                                                                                                 | Document d'identité vérifié + criblage sanctions                                             | Lève l'alerte `UNVERIFIED_HIGH_VALUE` lorsque `identityVerified = true`                           |
| `ENHANCED`                   | Montant ≥ seuil interne (`HIGH_VALUE_THRESHOLDS_MINOR` : 15 000 CAD/USD, 12 000 EUR, 7 500 000 XOF, 100 000 000 GNF), PPE, pays à risque, recommandation `MANUAL_REVIEW` | Justificatif d'adresse, origine des fonds, bénéficiaires effectifs, revue humaine documentée | Blocage du financement tant que la revue n'est pas conclue (décision humaine, jamais automatique) |

Les seuils internes sont des paramètres produit et **ne sont pas des seuils réglementaires** ; ils devront être alignés avec les obligations confirmées par le conseil.

## 4. Flux de vérification

```
Utilisateur ──► Téléverse la pièce (Document chiffré, kind=IDENTITY)
           ──► Soumet la déclaration (submitIdentityVerificationSchema)
API        ──► Crée IdentityVerification(PENDING, provider=KYC_PROVIDER)
           ──► Appelle KycProvider.startIdentityCheck({ documentId, … })   ← jamais les octets du fichier
Fournisseur──► Retourne IdentityCheckResult { status, simulated, reasons, providerRef }
API        ──► Enregistre providerResponse (sans données brutes), met à jour status
           ──► Évalue le risque, notifie l'utilisateur
Conformité ──► Peut approuver/rejeter manuellement (reviewVerificationSchema : décision + notes ≥ 3 caractères)
```

Points de contrôle :

- L'adaptateur reçoit une **référence** de document (`documentId`) et non le fichier ; un fournisseur réel accédera au fichier via un flux signé à durée limitée, ou recevra le téléversement directement côté client (à décider lors de l'intégration).
- Toute décision manuelle est journalisée (`reviewedById`, `reviewNotes`, `reviewedAt`) et auditée.
- Un échec (`SIMULATED_FAIL`, futur `REJECTED`) n'entraîne jamais de confiscation : la transaction reste `AWAITING_FUNDING` et l'utilisateur peut resoumettre ou contester (`AML_POLICY.md` §8).

## 5. Interface d'intégration d'un fournisseur (référence `packages/compliance/src/kyc/types.ts`)

| Interface / type                                                          | Rôle                                                                                                                                                                                               | Points d'attention pour un fournisseur réel                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KycProvider { code, simulated, startIdentityCheck, startBusinessCheck }` | Contrat d'identité et d'entreprise                                                                                                                                                                 | `simulated` doit être `false` ; `code` identifie le fournisseur dans `IdentityVerification.provider`                                                                        |
| `IdentityCheckInput`                                                      | `userId`, `firstName`, `lastName`, `country`, `documentType` (`PASSPORT`, `NATIONAL_ID`, `DRIVER_LICENSE`, `RESIDENCE_PERMIT`), `issuingCountry`, `dateOfBirth?`, `documentId?`, `sandboxOutcome?` | Ajouter l'adresse et le canal de capture ; ignorer `sandboxOutcome`                                                                                                         |
| `IdentityCheckResult`                                                     | `provider`, `providerRef`, `status` (`PENDING`, `SIMULATED_PASS`, `SIMULATED_FAIL`, `REJECTED`), `simulated`, `checkedAt`, `reasons[]`, `raw`                                                      | **Étendre `KycOutcomeStatus`** avec des statuts réels (`VERIFIED`, `FAILED`, `NEEDS_REVIEW`) lors de l'intégration ; `raw` ne doit contenir aucune donnée brute de document |
| `BusinessCheckInput`                                                      | `organizationId`, `legalName`, `registrationNumber`, `registrationCountry`, `businessType`, `registrationDocumentId?`                                                                              | Ajouter dirigeants et bénéficiaires effectifs                                                                                                                               |
| `SanctionsProvider { code, simulated, screen }`                           | Criblage par nom, pays, date de naissance                                                                                                                                                          | Ajouter listes PPE, identifiant de criblage pour re-criblage périodique                                                                                                     |
| `SanctionsScreeningResult`                                                | `status` (`CLEAR_SIMULATED`, `POTENTIAL_MATCH_SIMULATED`, `CLEAR`, `POTENTIAL_MATCH`), `matches[]` (`list`, `name`, `score`)                                                                       | Une `POTENTIAL_MATCH` crée une `RiskAlert` HIGH et une revue humaine ; jamais de blocage automatique définitif                                                              |
| `createKycProvider(code)` / `createSanctionsProvider(code)`               | Fabriques pilotées par `KYC_PROVIDER` / `SANCTIONS_PROVIDER`                                                                                                                                       | Enregistrer le nouveau fournisseur derrière une condition explicite et une entrée dans `AUTHORIZATIONS_CHECKLIST.md`                                                        |

### Variables d'environnement réservées

| Variable                     | Valeur sandbox | Valeur future                      | Remarques                                                                       |
| ---------------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `KYC_PROVIDER`               | `sandbox`      | Code du fournisseur contractualisé | Toute autre valeur fait échouer le démarrage tant que l'adaptateur n'existe pas |
| `KYC_PROVIDER_API_KEY`       | vide           | Secret du fournisseur              | Jamais journalisé (redaction pino) ; rotation documentée                        |
| `SANCTIONS_PROVIDER`         | `sandbox`      | Code du fournisseur de listes      | Peut être distinct du fournisseur KYC                                           |
| `SANCTIONS_PROVIDER_API_KEY` | vide           | Secret                             | Idem                                                                            |

### Critères de sélection d'un fournisseur

- Couverture documentaire : passeports et cartes nationales du Canada, du Sénégal, de la Guinée, de la Côte d'Ivoire ; permis de conduire canadiens ; titres de séjour.
- Méthodes admises par CANAFE (document photo avec vérification d'authenticité, double processus) et par les autorités UEMOA/BCRG.
- Registres d'entreprises : Registraire des entreprises du Québec / Corporations Canada ; RCCM (Sénégal, Guinée) — disponibilité d'accès automatisé à confirmer.
- Localisation du traitement, sous-traitants, certifications de sécurité, durée de conservation chez le fournisseur, possibilité de suppression.
- Contrat de sous-traitance conforme à la Loi 25 et à la loi 2008-12 ; EFVP préalable (`DATA_PROTECTION.md`).

## 6. Minimisation des données

| Principe                                        | Mise en œuvre actuelle                                                                                                                                         | Évolution                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Aucune donnée brute de pièce d'identité en base | `declaredData` : type de document, pays émetteur, date de naissance optionnelle ; les octets du document sont dans le stockage chiffré, jamais dans PostgreSQL | Conserver la règle ; stocker chez le fournisseur uniquement si le contrat l'exige |
| Référence plutôt que copie                      | `providerRef` et `providerResponse` filtrés                                                                                                                    | Normaliser `providerResponse` pour exclure images, numéros complets de documents  |
| Accès restreint                                 | `admin:verifications` (COMPLIANCE, ADMIN) ; téléchargement journalisé                                                                                          | Journal d'accès aux documents d'identité exporté mensuellement                    |
| Durée limitée                                   | `expiresAt`, `retentionUntil`                                                                                                                                  | Purge/anonymisation automatisée                                                   |
| Collecte proportionnée                          | `BASIC` ne demande que le strict nécessaire                                                                                                                    | `ENHANCED` justifié par le risque et documenté                                    |

## 7. Correspondance modules ↔ exigences KYC/KYB

| Module       | Qui doit être vérifié                                           | Quand                                                      | Niveau                                   |
| ------------ | --------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| A — Protect  | Acheteur et vendeur (personnes), organisations `BUSINESS` (KYB) | Avant financement ; avant première libération au plus tard | `BASIC`, `ENHANCED` selon montant/risque |
| B — Wallet   | Titulaire de l'organisation, bénéficiaires effectifs            | Avant tout solde réel                                      | `BASIC` + bénéficiaires effectifs        |
| C — Transfer | Donneur d'ordre ; informations bénéficiaire (règle de voyage)   | Avant autorisation ; `REVIEW_REQUIRED` si incomplet        | Selon seuils confirmés                   |
| D — Business | Organisation (KYB) et membres `OWNER` / `ADMIN`                 | À la création de l'organisation `BUSINESS`                 | KYB                                      |
| E — API      | Organisation détentrice de la clé                               | Avant émission de la clé                                   | KYB                                      |
| F — DDA      | N/A (aucune activité réelle)                                    | —                                                          | —                                        |

## 8. Checklist KYC/KYB

- [ ] Avis juridique sur les méthodes de vérification admises par juridiction et sur les seuils de déclenchement.
- [ ] Sélectionner et contractualiser un fournisseur KYC/KYB et un fournisseur de listes (sanctions, PPE) ; EFVP préalable.
- [ ] Étendre `KycOutcomeStatus` et `VerificationStatus` avec des statuts réels distincts des statuts simulés ; adapter l'interface (badges).
- [ ] Ajouter au schéma : adresse postale, bénéficiaires effectifs, statut PPE, tiers, canal de capture, identifiant de re-criblage.
- [ ] Définir la politique de niveaux (`BASIC` / `ENHANCED`) alignée sur les seuils confirmés.
- [ ] Mettre en place le re-criblage périodique et le renouvellement (`expiresAt`).
- [ ] Documenter la procédure de revue manuelle, la contestation et les délais de réponse.
- [ ] Journaliser et exporter les accès aux documents d'identité.
- [ ] Former les agents de conformité à l'usage des outils et aux biais.
- [ ] Vérifier que la redaction pino couvre toutes les nouvelles variables et champs.

## 9. Questions ouvertes pour le conseil

1. Quelles méthodes de vérification d'identité à distance sont admises au Sénégal et en Guinée pour un prestataire technique agissant pour un établissement agréé ?
2. Qui, de DFN ou du partenaire, est responsable de la vérification de chaque partie dans un flux Canada → Sénégal, et les résultats peuvent-ils être partagés ?
3. Quel seuil de détention définit le bénéficiaire effectif dans l'UEMOA et en Guinée ?
4. Les pièces d'identité des utilisateurs sénégalais peuvent-elles être traitées par un fournisseur situé hors du Sénégal (autorisation CDP) ?
5. Quelle durée de conservation des dossiers KYC s'applique dans chaque juridiction, et prime-t-elle sur le droit à l'effacement ?
6. Une vérification `BASIC` effectuée par un fournisseur est-elle suffisante pour une relation d'affaires continue au sens de CANAFE ?

---

## Annexe A — Étapes d'intégration d'un fournisseur réel (procédure cible)

| #   | Étape                                                                                                                     | Livrable                                                                        | Responsable                 |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| 1   | Avis juridique et EFVP                                                                                                    | Documents signés                                                                | Conformité, responsable PRP |
| 2   | Contrat et annexe de sécurité / sous-traitance                                                                            | Contrat signé, référence dans `AUTHORIZATIONS_CHECKLIST.md` (TR-02, TR-03)      | Direction                   |
| 3   | Implémentation de l'adaptateur (`KycProvider`, `SanctionsProvider`) avec `simulated = false`                              | Paquet ou module dédié, tests contractuels contre le bac à sable du fournisseur | Ingénierie                  |
| 4   | Extension des statuts (`VERIFIED`, `FAILED`, `NEEDS_REVIEW`) dans `KycOutcomeStatus`, `VerificationStatus` et l'interface | Migration Prisma, badges distincts des statuts simulés                          | Ingénierie                  |
| 5   | Enregistrement conditionnel dans `createKycProvider` / `createSanctionsProvider`                                          | Code revu par deux personnes                                                    | Ingénierie                  |
| 6   | Redaction des nouveaux champs dans les logs ; rotation des secrets documentée                                             | Configuration pino, runbook                                                     | Sécurité                    |
| 7   | Procédure de revue manuelle et de contestation                                                                            | Guide analyste                                                                  | Conformité                  |
| 8   | Recette : jeux de test sans données réelles, puis pilote restreint                                                        | Rapport de recette                                                              | Produit                     |
| 9   | Mise à jour de ce document et de `AML_POLICY.md`                                                                          | Version datée                                                                   | Produit                     |

## Annexe B — Textes d'interface (sandbox) à conserver

| Contexte                             | Texte FR                                                                               | Texte EN                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Statut `SIMULATED_PASS`              | « Vérification simulée réussie — aucune vérification réelle n'a été effectuée »        | "Simulated verification passed — no real verification was performed" |
| Statut `SIMULATED_FAIL`              | « Vérification simulée échouée — scénario de démonstration »                           | "Simulated verification failed — demonstration scenario"             |
| Statut `PENDING`                     | « Vérification en attente (sandbox) »                                                  | "Verification pending (sandbox)"                                     |
| Criblage `CLEAR_SIMULATED`           | « Criblage simulé : aucune correspondance (liste de test) »                            | "Simulated screening: no match (test list)"                          |
| Criblage `POTENTIAL_MATCH_SIMULATED` | « Criblage simulé : correspondance potentielle sur une liste de test — revue humaine » | "Simulated screening: potential match on a test list — human review" |
