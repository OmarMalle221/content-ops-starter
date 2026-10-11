# Guinée — Banque Centrale de la République de Guinée (BCRG)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il doit être validé par un conseiller juridique exerçant en Guinée avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. Les références de textes, montants et délais signalés « à confirmer » doivent être vérifiés auprès de la BCRG et dans la législation guinéenne en vigueur ; la documentation publique est moins accessible que pour l'UEMOA et plusieurs références ci-dessous sont volontairement laissées ouvertes.

| Champ                                              | Valeur                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autorités                                          | Banque Centrale de la République de Guinée (BCRG) : agrément et supervision des établissements de crédit, des établissements de monnaie électronique et des bureaux de change ; CENTIF-Guinée (renseignement financier) ; ministère de l'Économie et des Finances                                                                                                                                    |
| Textes principaux (références exactes à confirmer) | Loi bancaire guinéenne (réglementation des établissements de crédit) ; instruction(s) de la BCRG relative(s) à la monnaie électronique et aux services de paiement ; réglementation des changes de la BCRG ; loi relative à la lutte contre le blanchiment de capitaux et le financement du terrorisme ; loi relative à la cybersécurité et à la protection des données à caractère personnel (2016) |
| Monnaie                                            | Franc guinéen (GNF), exposant 0 dans le produit (`CURRENCIES.GNF`)                                                                                                                                                                                                                                                                                                                                   |
| Corridor                                           | Canada → Guinée (expansion), États-Unis → Guinée (recherche)                                                                                                                                                                                                                                                                                                                                         |
| Statut DFN                                         | Sandbox — aucun agrément, aucun partenariat                                                                                                                                                                                                                                                                                                                                                          |
| Porte réglementaire                                | R6 (`ROADMAP.md` §9)                                                                                                                                                                                                                                                                                                                                                                                 |

---

## 1. Spécificités du contexte guinéen

| Caractéristique                                                                                            | Conséquence pour DFN                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| La Guinée n'est pas membre de l'UEMOA ; elle dispose de sa propre banque centrale et de sa propre monnaie  | Le cadre BCEAO (`SENEGAL_BCEAO.md`) ne s'applique pas ; analyse distincte                                |
| Le GNF n'est pas librement convertible ; le marché des changes est administré par la BCRG                  | Les cotations CAD/GNF dépendent du partenaire local ; volatilité et spreads à expliquer aux utilisateurs |
| Forte pénétration de la monnaie électronique (opérateurs télécoms adossés à des banques)                   | Canal de paiement final probable pour les vendeurs                                                       |
| Membre du GIABA (Groupe intergouvernemental d'action contre le blanchiment d'argent en Afrique de l'Ouest) | Standards GAFI appliqués via les évaluations mutuelles ; attentes de vigilance comparables               |
| Documentation réglementaire moins accessible en ligne                                                      | Nécessité d'un conseil local et d'échanges directs avec la BCRG                                          |

## 2. Agrément des prestataires de monnaie électronique et de services de paiement

| Exigence                   | Contenu (à confirmer)                                                                                                                                            | Correspondance produit                                                                              | Statut      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------- |
| Agrément BCRG              | Les émetteurs de monnaie électronique sont agréés par la BCRG, souvent en partenariat avec une banque ; capital minimum et conditions de gouvernance à confirmer | DFN ne sollicite pas d'agrément propre ; partenaire requis                                          | À vérifier  |
| Cantonnement des fonds     | Dépôt des contreparties de la monnaie électronique auprès d'une banque (taux de couverture à confirmer)                                                          | Compte `PROVIDER_SETTLEMENT:<partenaire>:GNF`                                                       | Préparation |
| Plafonds                   | Plafonds d'encours et de transaction selon le niveau de KYC (montants à confirmer)                                                                               | Seuil interne `UNVERIFIED_HIGH_VALUE` = 100 000 000 GNF (non réglementaire) ; plafonds à paramétrer | À faire     |
| Identification des clients | Pièce d'identité nationale, passeport ; identification simplifiée sous plafonds                                                                                  | `IdentityVerification` (`documentType`, `issuingCountry = GN`)                                      | Préparation |
| Reporting                  | États périodiques à la BCRG                                                                                                                                      | Exports                                                                                             | À faire     |
| Agents et distributeurs    | Réseau d'agents sous responsabilité de l'établissement agréé                                                                                                     | Hors périmètre DFN                                                                                  | N/A         |
| Prestataire technique      | Les prestataires techniques interviennent sous contrat avec l'établissement agréé ; obligation éventuelle de déclaration à confirmer                             | Position cible de DFN                                                                               | À confirmer |

## 3. Contrôle des changes (GNF)

| Point                     | Contenu (à confirmer)                                                                                        | Impact sur DFN                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Intermédiaires agréés     | Opérations de change réservées aux banques et bureaux de change agréés par la BCRG                           | DFN n'exécute aucune conversion ; le partenaire cote et exécute                                                                                |
| Transferts entrants       | Rapatriement via banques ; conversion en GNF généralement requise pour les résidents (modalités à confirmer) | Les vendeurs reçoivent du GNF ; un solde en devise étrangère pour une organisation guinéenne est à analyser                                    |
| Transferts sortants       | Soumis à justificatifs, plafonds et parfois autorisation préalable                                           | Remboursements vers le Canada (`REFUND_TO_BUYER`) : procédure et délais à prévoir ; risque de blocage à expliquer dans la politique de litiges |
| Taux de change            | Taux de référence BCRG et taux bancaires ; écart à surveiller                                                | `FXQuote` conserve numérateur/dénominateur et frais ; aucune promesse de taux en sandbox                                                       |
| Déclarations statistiques | À la charge des intermédiaires agréés                                                                        | Fourniture des données par DFN                                                                                                                 |
| Comptes en devises        | Ouverture par des résidents soumise à conditions                                                             | Module Wallet multi-devises limité au GNF pour les organisations guinéennes sauf avis contraire                                                |

## 4. LBC/FT en Guinée

| Exigence                       | Détail (à confirmer)                                                                                                        | Correspondance produit                                                         | Statut      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- |
| Loi LBC/FT en vigueur          | Assujettissement des établissements financiers et EME ; vigilance, conservation, déclarations de soupçon à la CENTIF-Guinée | `AML_POLICY.md`, `RiskAlert`                                                   | Préparation |
| Vigilance renforcée            | Transactions transfrontalières, PPE, montants élevés                                                                        | Règles `UNVERIFIED_HIGH_VALUE`, `NEW_ACCOUNT_HIGH_VALUE`, `GEOGRAPHY_MISMATCH` | Préparation |
| Gel des avoirs                 | Listes ONU et nationales                                                                                                    | `SanctionsProvider` (sandbox), `LedgerAccount.status = FROZEN`                 | À faire     |
| Coopération avec le partenaire | Transmission des dossiers et des justificatifs                                                                              | Exports de transaction (contrat, preuves, événements)                          | Préparation |

## 5. Protection des données

| Point                                                                               | Contenu (à confirmer)                                                                                                                                                                              | Impact                                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Loi de 2016 sur la cybersécurité et la protection des données à caractère personnel | Principes de licéité, finalité, proportionnalité ; déclaration des traitements ; encadrement des transferts internationaux ; autorité de contrôle désignée (nom et pouvoirs effectifs à confirmer) | Voir `DATA_PROTECTION.md` §2.4 ; formalités à prévoir avant de traiter des données de résidents guinéens |
| Localisation                                                                        | Exigences éventuelles d'hébergement local pour les données financières (à confirmer)                                                                                                               | Option d'hébergement régional à l'étude                                                                  |

## 6. Modèle de partenariat

Le modèle est identique à celui décrit dans `SENEGAL_BCEAO.md` §7 : le partenaire agréé (banque ou EME) reçoit les fonds, les cantonne, paie les vendeurs en GNF et exécute les remboursements ; DFN fournit l'orchestration, le contrat numérique, les preuves et le registre de suivi.

| Élément spécifique à la Guinée | Contenu                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change                         | Clause précisant le mécanisme de cotation CAD → GNF, la date de fixation du taux (à la libération du jalon) et la répartition du risque de change entre les parties |
| Remboursements                 | Procédure détaillée pour les sorties de devises après litige, incluant les justificatifs (contrat, décision de litige) et les délais                                |
| Canal de paiement              | Paiement du vendeur par virement bancaire ou par porte-monnaie électronique ; frais et délais                                                                       |
| Continuité                     | Mesures en cas d'indisponibilité du partenaire ou de restriction de change                                                                                          |

## 7. Correspondance modules ↔ cadre guinéen

| Module       | Activité en Guinée                          | Statut requis (partenaire)     | Point d'attention                                  |
| ------------ | ------------------------------------------- | ------------------------------ | -------------------------------------------------- |
| A — Protect  | Paiement du vendeur en GNF après libération | Banque ou EME agréé            | Date de fixation du taux ; remboursements sortants |
| B — Wallet   | Solde GNF d'une organisation guinéenne      | Compte réel chez le partenaire | Pas de solde en devise étrangère sans avis         |
| C — Transfer | Transfert entrant converti en GNF           | Banque                         | Taux administré, délais                            |
| D — Business | Facturation                                 | Aucun                          | Mentions légales locales                           |
| E — API      | Intégrateurs locaux                         | Selon usage                    | Contrats                                           |
| F — DDA      | Aucune                                      | —                              | Ligne rouge                                        |

## 8. Checklist Guinée

- [ ] Mandater un conseil juridique local ; obtenir les références exactes des textes BCRG applicables (monnaie électronique, services de paiement, change).
- [ ] Rencontrer la BCRG pour présenter le modèle « prestataire technique » et confirmer l'absence de besoin d'agrément propre ou la procédure de déclaration.
- [ ] Sélectionner un partenaire agréé ; vérifier son agrément et sa capacité à exécuter des transferts entrants, des paiements en GNF et des remboursements sortants.
- [ ] Documenter la procédure de change (taux, moment de fixation, frais) et l'intégrer au contrat numérique et aux écrans.
- [ ] Paramétrer les plafonds réglementaires par niveau d'identification.
- [ ] Analyser les formalités de protection des données et la localisation.
- [ ] Préparer la coopération LBC/FT avec la CENTIF-Guinée via le partenaire.
- [ ] Mettre à jour `AUTHORIZATIONS_CHECKLIST.md` à chaque confirmation.

## 9. Questions ouvertes pour le conseil

1. Quels textes régissent aujourd'hui l'émission de monnaie électronique et les services de paiement en Guinée, et prévoient-ils un statut ou une déclaration pour les prestataires techniques étrangers ?
2. Quelles sont les règles exactes de conversion obligatoire des transferts entrants et de sortie de devises pour les remboursements ?
3. Une organisation guinéenne peut-elle voir affiché par DFN un solde en CAD/USD/EUR adossé à un compte du partenaire ?
4. Quels seuils de vigilance, de déclaration et quelle durée de conservation prévoit la loi LBC/FT guinéenne ?
5. Quelle autorité est effectivement compétente pour la protection des données et quelles formalités s'imposent avant tout traitement ?
6. Le contrat numérique de paiement conditionnel soumis au droit québécois est-il opposable à un vendeur guinéen, et quelles mentions locales sont requises ?

---

## Annexe A — Flux Canada → Guinée : qui fait quoi (modèle cible, à valider)

| Étape | Acteur                                 | Action                                                                              | Statut réglementaire mobilisé                | Trace produit                          |
| ----- | -------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------- |
| 1     | Acheteur (CA)                          | Accepte le contrat et demande les instructions de financement                       | —                                            | `ContractAcceptance`, `FundingRequest` |
| 2     | Partenaire canadien                    | Reçoit les CAD en fiducie, notifie DFN                                              | ESM CANAFE / FSP LAPD                        | `ProviderEvent`, écriture `FUNDING`    |
| 3     | DFN                                    | Tient le séquestre comptable                                                        | Prestataire technique                        | `ESCROW:<tx>:CAD`                      |
| 4     | Acheteur                               | Approuve le jalon                                                                   | —                                            | `Milestone(APPROVED)`                  |
| 5     | DFN                                    | Instruit la libération ; le taux CAD → GNF est fixé à cet instant par le partenaire | Prestataire technique                        | `executeRelease`, `FXQuote`            |
| 6     | Partenaire canadien → banque guinéenne | Transfert international                                                             | Intermédiaire agréé BCRG ; conversion en GNF | `ExecutionResult.externalRef`          |
| 7     | Banque / EME guinéen                   | Identifie le vendeur, crédite compte ou porte-monnaie                               | Agrément BCRG ; KYC ; LBC/FT                 | Événement `release.executed`           |
| 8     | Vendeur (GN)                           | Reçoit les GNF                                                                      | —                                            | Notification                           |
| 9     | Litige                                 | Remboursement sortant soumis au contrôle des changes                                | Autorisation / justificatifs BCRG            | `DisputeDecision`, écriture `REFUND`   |

## Annexe B — Différences avec le cadre UEMOA à expliquer aux utilisateurs

| Sujet                            | UEMOA (Sénégal, Côte d'Ivoire)           | Guinée                                            |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| Monnaie                          | XOF, parité fixe avec l'euro             | GNF, taux administré et variable                  |
| Banque centrale                  | BCEAO (supranationale)                   | BCRG (nationale)                                  |
| Cadre monnaie électronique       | Instructions BCEAO harmonisées           | Textes nationaux BCRG                             |
| Convertibilité                   | Hors zone : non ; dans la zone : commune | Contrôle des changes national strict              |
| Délai de remboursement sortant   | Justificatifs ; procédures bancaires     | Potentiellement plus long ; autorisation possible |
| Risque de change pour le vendeur | Faible (parité EUR)                      | Plus élevé ; date de fixation du taux cruciale    |

## Annexe C — Informations à afficher dans le produit pour le corridor Guinée (préparation)

| Écran                                | Mention                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Création de transaction (devise GNF) | « Le montant en GNF est indicatif en sandbox ; en phase live, le taux serait fixé par le partenaire au moment de la libération » |
| Contrat numérique                    | Clause sur la répartition du risque de change et sur les délais de remboursement sortant                                         |
| Litige                               | « Un remboursement vers le Canada peut être soumis à des formalités de change et à des délais »                                  |
| Bandeau                              | « Données fictives — Aucun fonds réel » (toujours)                                                                               |

## Annexe D — Glossaire

| Terme               | Définition de travail                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| BCRG                | Banque Centrale de la République de Guinée                                                                                 |
| GNF                 | Franc guinéen                                                                                                              |
| CENTIF-GN           | Cellule nationale de traitement des informations financières de Guinée                                                     |
| GIABA               | Groupe intergouvernemental d'action contre le blanchiment d'argent en Afrique de l'Ouest (organisme régional de type GAFI) |
| EME                 | Établissement émetteur de monnaie électronique agréé                                                                       |
| Intermédiaire agréé | Banque ou bureau de change habilité par la BCRG aux opérations de change                                                   |
