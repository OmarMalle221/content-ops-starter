# Canada — CANAFE / FINTRAC : entreprises de services monétaires et obligations LBC/FT

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il doit être validé par un conseiller juridique spécialisé en droit canadien de la lutte contre le blanchiment d'argent avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. Les seuils et délais indiqués comme « à confirmer » doivent être vérifiés dans la version en vigueur de la _Loi sur le recyclage des produits de la criminalité et le financement des activités terroristes_ (LRPCFAT) et de ses règlements, ainsi que dans les directives de CANAFE.

| Champ               | Valeur                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Autorité            | Centre d'analyse des opérations et déclarations financières du Canada (CANAFE / FINTRAC)                                                     |
| Texte principal     | LRPCFAT et règlements (notamment le _Règlement sur le recyclage des produits de la criminalité et le financement des activités terroristes_) |
| Statut DFN          | Sandbox — aucune inscription demandée, aucune activité réelle                                                                                |
| Porte réglementaire | R3 (`ROADMAP.md` §9)                                                                                                                         |

---

## 1. Qualification : DFN est-elle une entreprise de services monétaires (ESM) ?

Au sens de la LRPCFAT, une **entreprise de services monétaires** est une personne ou entité qui offre au public, notamment, l'un des services suivants : opérations de change, **remise ou transmission de fonds** par tout moyen ou par un intermédiaire, émission ou rachat de mandats-poste, chèques de voyage ou titres négociables semblables, **opérations en monnaie virtuelle** (depuis juin 2020), et services de financement participatif (ajout récent, à confirmer pour le périmètre exact).

| Module DFN            | Activité envisagée en phase live                                                                                          | Qualification probable                                                                                                    | À confirmer par le conseil                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A — Diaspora Protect  | Instruction à un partenaire agréé de recevoir les fonds d'un acheteur au Canada et de les libérer à un vendeur au Sénégal | Transmission de fonds transfrontalière, même si les fonds sont détenus par le partenaire : qualification ESM **probable** | Le modèle « instructions seulement, fonds détenus par un partenaire inscrit » exonère-t-il DFN ou crée-t-il une relation de mandataire (agent) ? |
| B — Diaspora Wallet   | Soldes multi-devises au nom des organisations                                                                             | Détention de fonds pour autrui + change implicite : ESM probable, et LAPD (voir `CANADA_BANQUE_DU_CANADA.md`)             | Un portefeuille purement comptable adossé à un compte en fiducie du partenaire change-t-il l'analyse ?                                           |
| C — Diaspora Transfer | Transferts internationaux avec conversion                                                                                 | Remise de fonds **et** change : ESM **certaine** si opérée par DFN                                                        | Qui est l'ESM : DFN, le partenaire, ou les deux ?                                                                                                |
| D — Diaspora Business | Factures, devis, rapports                                                                                                 | Pas une activité d'ESM en soi                                                                                             | —                                                                                                                                                |
| E — Diaspora API      | Accès programmatique aux modules                                                                                          | Suit la qualification du module sous-jacent                                                                               | Responsabilité LBC/FT des intégrateurs                                                                                                           |
| F — DDA (recherche)   | Aucune activité réelle                                                                                                    | Si un jour émis ou échangé : « opérations en monnaie virtuelle » → ESM                                                    | Hors périmètre ; ligne rouge                                                                                                                     |

**Position de travail** : préparer la plateforme comme si DFN devait s'inscrire comme ESM dès la première phase live des modules A ou C, sauf avis contraire écrit du conseil.

## 2. Inscription auprès de CANAFE

| Exigence                                    | Détail                                                                                                               | Correspondance produit                                                            | Statut                     |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| Inscription préalable                       | Inscription obligatoire **avant** d'offrir les services ; renouvellement périodique (tous les deux ans, à confirmer) | —                                                                                 | À vérifier                 |
| Renseignements à fournir                    | Structure, dirigeants, propriétaires, agents/mandataires, services offerts, volumes prévus, comptes bancaires        | Organigramme et liste des agents à établir                                        | À vérifier                 |
| Vérification de l'inscription du partenaire | Le partenaire de paiement doit lui-même être inscrit (ou être une entité financière assujettie)                      | Table `PaymentProvider` : prévoir champs `regulatoryRegistrationRef`, `regulator` | À vérifier                 |
| ESM étrangère (ESME)                        | Une entité hors Canada qui dirige ses services vers des personnes au Canada doit s'inscrire comme ESM étrangère      | Pertinent si une entité de groupe est établie au Sénégal                          | À confirmer par le conseil |
| Inadmissibilité                             | Certaines condamnations rendent inadmissible à l'inscription ; obligation de signaler les changements                | Procédure RH / gouvernance                                                        | À vérifier                 |
| Affichage et registre public                | CANAFE publie un registre des ESM inscrites                                                                          | Afficher le numéro d'inscription sur le site une fois obtenu (jamais avant)       | À vérifier                 |

## 3. Obligations d'une ESM

### 3.1 Programme de conformité

Les cinq éléments obligatoires d'un programme de conformité :

| Élément                          | Exigence                                                                               | Correspondance produit                                           | Statut     |
| -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- |
| Agent de conformité              | Nomination d'une personne responsable de la mise en œuvre                              | Rôle global `COMPLIANCE` ; responsable à nommer (`README.md` §5) | À vérifier |
| Politiques et procédures écrites | Approuvées par un dirigeant, tenues à jour                                             | Ébauche dans `AML_POLICY.md`                                     | Ébauche    |
| Évaluation des risques           | Clients, produits, zones géographiques, canaux de distribution, nouvelles technologies | Moteur de règles + matrice de risque par corridor (`CORRIDORS`)  | Ébauche    |
| Programme de formation           | Formation continue des employés, agents et mandataires                                 | À créer                                                          | À vérifier |
| Examen de l'efficacité           | Révision indépendante au moins tous les deux ans                                       | À planifier                                                      | À vérifier |

### 3.2 Vérification de l'identité (connaissance du client)

Détail dans `KYC_KYB.md`. Points propres à CANAFE :

| Obligation                                                                                    | Déclencheur typique pour une ESM                                                                                                                             | Correspondance produit                                                                                                                                    | Statut             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Vérifier l'identité des personnes                                                             | Télévirement de 1 000 CAD ou plus (à confirmer), opération de change de 3 000 CAD ou plus (seuil à confirmer), toute opération douteuse, relation d'affaires | `IdentityVerification`, méthodes de vérification admises (document d'identité photo, double processus, crédit) à mettre en œuvre par un fournisseur agréé | Sandbox uniquement |
| Vérifier l'existence des entités                                                              | Relation d'affaires avec une personne morale                                                                                                                 | `BusinessVerification`, `Organization.registrationNumber`                                                                                                 | Sandbox uniquement |
| Bénéficiaires effectifs                                                                       | Obtenir et confirmer les personnes détenant ou contrôlant 25 % ou plus                                                                                       | Champ à ajouter dans `declaredData` ; voir `KYC_KYB.md`                                                                                                   | À faire            |
| Personnes politiquement vulnérables (PPV) et dirigeants d'organisations internationales (DOI) | Détermination lors de certains télévirements de 100 000 CAD ou plus (seuil à confirmer) et en relation d'affaires                                            | Interface `SanctionsProvider` extensible aux listes PPE                                                                                                   | À faire            |
| Tiers                                                                                         | Déterminer si un tiers agit pour le client                                                                                                                   | Champ à prévoir dans le flux de création de transaction                                                                                                   | À faire            |
| Relation d'affaires et surveillance continue                                                  | Dès la deuxième opération nécessitant vérification (ou selon le cas) ; tenir le dossier à jour                                                               | Historique des transactions par organisation, `averageAmountMinor`                                                                                        | Partiel            |

### 3.3 Tenue de documents

| Document à conserver                                                 | Durée                                                         | Correspondance produit                                                           | Statut  |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------- |
| Dossiers de vérification d'identité                                  | 5 ans après la dernière opération (à confirmer selon le type) | `IdentityVerification`, `BusinessVerification`, `Document` avec `retentionUntil` | Partiel |
| Relevés d'opérations (télévirements, change, opérations importantes) | 5 ans                                                         | `Transaction`, `Transfer`, `FXQuote`, `LedgerTransaction` immuables              | Partiel |
| Relevés de réception de fonds                                        | 5 ans                                                         | `FundingRequest`, `ProviderEvent`                                                | Partiel |
| Copies des déclarations transmises                                   | 5 ans                                                         | À créer (table de déclarations)                                                  | À faire |
| Dossiers de formation et d'examen de l'efficacité                    | 5 ans                                                         | Hors produit                                                                     | À faire |

### 3.4 Déclarations à CANAFE

| Déclaration                                                           | Déclencheur                                                                                                          | Délai                                              | Correspondance produit                                                                                             | Statut                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **DOI — Déclaration d'opérations importantes en espèces (LCTR)**      | Réception de **10 000 CAD ou plus en espèces** en une opération ou en plusieurs dans 24 heures                       | 15 jours civils (à confirmer)                      | DFN ne prévoit pas d'espèces ; déclaration improbable mais à documenter                                            | N/A sauf changement de modèle |
| **DOD — Déclaration d'opérations douteuses (STR)**                    | Motifs raisonnables de soupçonner un lien avec le blanchiment ou le financement du terrorisme ; **aucun seuil**      | « Dès que possible » après avoir établi les motifs | Files `RiskAlert` (`CONFIRMED`), notes de revue, export du dossier ; la décision de déclarer reste humaine         | Préparation                   |
| **Déclaration de télévirements (EFTR)**                               | Télévirements internationaux de **10 000 CAD ou plus**, entrants ou sortants, y compris par agrégation sur 24 heures | 5 jours ouvrables (à confirmer)                    | `Transfer`, `Transaction.originCountry/destinationCountry`, montants en unités mineures ; agrégation à implémenter | À faire (Phase 4)             |
| **Déclaration d'opérations importantes en monnaie virtuelle (LVCTR)** | 10 000 CAD ou plus en monnaie virtuelle                                                                              | 15 jours civils (à confirmer)                      | Hors périmètre (DDA jamais réel)                                                                                   | N/A                           |
| **Déclaration de biens appartenant à un groupe terroriste**           | Connaissance de biens appartenant à une entité inscrite                                                              | Immédiatement                                      | Procédure manuelle à rédiger                                                                                       | À faire                       |
| **Directives ministérielles**                                         | Mesures visant certains pays ou entités                                                                              | Variable                                           | Paramétrage des corridors (`corridorSupported`)                                                                    | À faire                       |

### 3.5 Règle des 24 heures

Plusieurs opérations de même nature totalisant 10 000 CAD ou plus, effectuées dans une période de **24 heures consécutives** par ou pour la même personne ou entité, sont traitées comme une seule opération aux fins des déclarations (DOI, EFTR, LVCTR).

| Exigence                                                      | Correspondance produit                                                                                                         | Statut  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Agrégation par donneur d'ordre, par bénéficiaire et par tiers | Index `Transaction(buyerOrganizationId, status)`, `Transfer(organizationId, status)` ; requête d'agrégation glissante à écrire | À faire |
| Fenêtre glissante de 24 heures                                | Règle `VELOCITY_24H` compte le nombre de transactions ; une règle de **somme** sur 24 h doit être ajoutée (`AML_POLICY.md`)    | À faire |
| Conservation de la logique d'agrégation documentée            | Politique écrite                                                                                                               | À faire |

### 3.6 Règle de voyage (télévirements)

Pour un télévirement (seuil de 1 000 CAD, à confirmer), l'ESM qui l'initie doit inclure les informations du donneur d'ordre (nom, adresse, numéro de compte ou de référence) et du bénéficiaire (nom, numéro de compte), et l'ESM qui le reçoit doit prendre des mesures raisonnables pour s'assurer que ces informations sont présentes ; un télévirement incomplet doit faire l'objet d'une politique écrite (prise de mesures, risque, déclaration).

| Exigence                                    | Correspondance produit                                                                                       | Statut      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| Capture des informations du donneur d'ordre | `User` (nom, pays, téléphone), `Organization` (nom légal), adresse postale **absente du schéma** → à ajouter | À faire     |
| Capture des informations du bénéficiaire    | `Transfer.beneficiary` (JSON structuré), `TransactionParty`                                                  | Partiel     |
| Transmission au partenaire                  | À prévoir dans l'adaptateur partenaire live                                                                  | À faire     |
| Politique sur les télévirements incomplets  | Détour `REVIEW_REQUIRED` de la machine à états `Transfer`                                                    | Préparation |

### 3.7 Monnaie virtuelle

Depuis juin 2020, les personnes qui font le commerce de monnaie virtuelle sont des ESM : obligations de vérification d'identité, règle de voyage (1 000 CAD, à confirmer), LVCTR, tenue de documents. **DFN n'exerce aucune activité en monnaie virtuelle.** Le programme DDA est purement interne et ne crée aucune unité échangeable (`STABLECOIN_RISKS.md`). Toute évolution vers une émission ou un échange réel déclencherait l'ensemble de ces obligations et exigerait un avis juridique préalable.

### 3.8 Sanctions et gel des avoirs

Obligations distinctes (Loi sur les Nations Unies, Loi sur les mesures économiques spéciales, Code criminel) : vérifier les listes consolidées, geler les biens, déclarer mensuellement à l'organisme compétent (à confirmer). Correspondance produit : `SanctionsProvider` (sandbox), `LedgerAccount.status = FROZEN`. Statut : à faire avec un fournisseur de listes.

## 4. Sanctions en cas de manquement

Pénalités administratives pécuniaires, publication des manquements, poursuites pénales pour défaut d'inscription ou de déclaration. Montants : à confirmer dans la grille en vigueur de CANAFE.

## 5. Checklist CANAFE

- [ ] Obtenir un avis juridique écrit sur la qualification ESM de chaque module (porte R1/R3).
- [ ] Décider de l'entité qui s'inscrira (DFN Canada, filiale, partenaire) et du modèle mandant/mandataire.
- [ ] Nommer l'agent de conformité ; documenter ses pouvoirs.
- [ ] Rédiger et faire approuver les politiques et procédures (`AML_POLICY.md` → version finale).
- [ ] Réaliser l'évaluation des risques par corridor, produit, canal et clientèle.
- [ ] Contractualiser un fournisseur de vérification d'identité et de criblage (`KYC_KYB.md`).
- [ ] Ajouter au schéma : adresse postale, bénéficiaires effectifs, statut PPV/DOI, tiers, références de déclarations.
- [ ] Implémenter l'agrégation sur 24 heures (nombre **et** somme) et la règle de voyage dans le module Transfer.
- [ ] Mettre en place l'export des dossiers de DOD depuis les `RiskAlert` confirmées et la table de suivi des déclarations.
- [ ] Définir la politique de conservation sur 5 ans et l'aligner avec `DATA_PROTECTION.md`.
- [ ] Construire le programme de formation et planifier l'examen biennal de l'efficacité.
- [ ] Vérifier l'inscription CANAFE du partenaire de paiement avant signature.
- [ ] Déposer la demande d'inscription ; n'afficher le numéro qu'après confirmation.

## 6. Questions ouvertes pour le conseil

1. Le modèle « DFN émet des instructions, le partenaire inscrit détient et transmet les fonds » fait-il de DFN une ESM, un mandataire du partenaire, ou ni l'un ni l'autre ?
2. Le paiement conditionnel du module Protect (fonds reçus puis libérés sur approbation de jalons) est-il analysé comme une remise de fonds, un service de séquestre, ou une combinaison ?
3. Quels seuils exacts s'appliquent aujourd'hui à la vérification d'identité pour les télévirements et les opérations de change, et à la détermination PPV/DOI ?
4. Les délais de transmission (DOD, EFTR) et la durée de conservation (5 ans) sont-ils inchangés dans la réglementation en vigueur ?
5. Une entité du groupe établie au Sénégal doit-elle s'inscrire comme ESM étrangère si elle sert des bénéficiaires et non des donneurs d'ordre au Canada ?
6. Les frais de plateforme (150 bps) perçus par DFN modifient-ils la qualification de l'activité ?
7. Les intégrateurs du module API (Phase 5) deviennent-ils des agents de DFN au sens de la LRPCFAT ?
8. Quelles obligations de déclaration de sanctions s'appliquent à une ESM (fréquence, destinataire) ?

---

## Annexe A — Correspondance détaillée obligations ↔ schéma de données

| Obligation CANAFE            | Entités / champs existants                                                                                                                       | Champs ou tables à ajouter                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Identification des personnes | `User.firstName/lastName/country/phone`, `IdentityVerification.declaredData` (type, pays émetteur, date de naissance), `Document(kind=IDENTITY)` | `User.address` (rue, ville, province, code postal, pays), `IdentityVerification.method` (méthode admise), `occupation`                      |
| Identification des entités   | `Organization.legalName/registrationNumber/country`, `BusinessVerification.declaredData.businessType`                                            | `Organization.natureOfBusiness`, `directors[]`, `beneficialOwners[]` (nom, date de naissance, adresse, % détenu)                            |
| PPV / DOI                    | —                                                                                                                                                | `User.pepStatus`, `pepDeterminedAt`, `pepSourceOfFunds`                                                                                     |
| Tiers                        | —                                                                                                                                                | `Transaction.thirdParty` (nom, adresse, relation)                                                                                           |
| Relevé de télévirement       | `Transfer.*`, `Transaction.originCountry/destinationCountry`, `amountMinor`, `currencyCode`, `FXQuote.rateNumerator/rateDenominator`             | `Transfer.originatorSnapshot`, `beneficiarySnapshot` (règle de voyage), `executedAt`                                                        |
| Agrégation 24 h              | `Transaction.createdAt`, index `buyerOrganizationId, status`                                                                                     | Vue matérialisée ou requête `SUM(amountMinor) OVER 24h` par personne/entité et par devise ; conversion en CAD au taux du jour pour le seuil |
| Déclarations transmises      | —                                                                                                                                                | Table `RegulatoryReport` (type, autorité, référence, date, auteur, pièces, statut)                                                          |
| Conservation 5 ans           | `Document.retentionUntil`, `TransactionEvent`, `AuditLog`                                                                                        | Politique de rétention par entité (`DATA_PROTECTION.md`)                                                                                    |
| Sanctions                    | `RiskAlert`, `LedgerAccount.status=FROZEN`                                                                                                       | `SanctionsScreening` (date, listes, résultat, identifiant de re-criblage)                                                                   |

## Annexe B — Glossaire

| Terme                 | Définition de travail                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ESM / MSB             | Entreprise de services monétaires ; entité assujettie à la LRPCFAT offrant change, remise de fonds, monnaie virtuelle, etc. |
| DOD / STR             | Déclaration d'opérations douteuses (Suspicious Transaction Report)                                                          |
| DOI / LCTR            | Déclaration d'opérations importantes en espèces (Large Cash Transaction Report)                                             |
| EFTR                  | Déclaration de télévirements internationaux de 10 000 CAD ou plus                                                           |
| LVCTR                 | Déclaration d'opérations importantes en monnaie virtuelle                                                                   |
| PPV / DOI (personnes) | Personne politiquement vulnérable (nationale ou étrangère) / dirigeant d'une organisation internationale                    |
| Règle des 24 heures   | Agrégation des opérations d'une même personne/entité sur 24 heures consécutives pour les seuils de déclaration              |
| Règle de voyage       | Obligation d'accompagner un télévirement des informations du donneur d'ordre et du bénéficiaire                             |
| Relation d'affaires   | Relation établie avec un client après certaines opérations, déclenchant la surveillance continue                            |
