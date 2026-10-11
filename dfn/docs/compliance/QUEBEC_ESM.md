# Québec — Loi sur les entreprises de services monétaires (AMF)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il doit être validé par un conseiller juridique québécois avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. Les références « à confirmer » doivent être vérifiées dans la version en vigueur de la _Loi sur les entreprises de services monétaires_ (LESM), de son règlement d'application et des avis de l'Autorité des marchés financiers (AMF).

| Champ               | Valeur                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autorité            | Autorité des marchés financiers (AMF), avec vérification de probité par la Sûreté du Québec                                                       |
| Texte principal     | _Loi sur les entreprises de services monétaires_ (RLRQ, c. E-12.000001) et _Règlement d'application_                                              |
| Champ d'application | Toute personne ou entité qui offre au public québécois, **contre rémunération**, un service monétaire visé, qu'elle soit établie au Québec ou non |
| Statut DFN          | Sandbox — aucun permis demandé                                                                                                                    |
| Porte réglementaire | R5 (`ROADMAP.md` §9)                                                                                                                              |

---

## 1. Catégories de permis

| Catégorie                                                                                                            | Description                                                                   | Pertinence pour DFN                                                                   | Module |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| **Change de devises**                                                                                                | Échange d'une devise contre une autre                                         | **Élevée** si DFN propose une conversion CAD → XOF/GNF, même via un partenaire        | B, C   |
| **Transfert de fonds**                                                                                               | Réception de fonds pour les transmettre à un tiers, au Québec ou à l'étranger | **Élevée** : cœur des modules Protect et Transfer                                     | A, C   |
| Émission ou rachat de chèques de voyage, mandats ou traites                                                          | —                                                                             | Nulle                                                                                 | —      |
| Encaissement de chèques                                                                                              | —                                                                             | Nulle                                                                                 | —      |
| Exploitation de guichets automatiques                                                                                | —                                                                             | Nulle                                                                                 | —      |
| Monnaie virtuelle (catégorie plus récente : exploitation d'une plateforme / négociation ; portée exacte à confirmer) | Services liés à la monnaie virtuelle                                          | Nulle tant que le DDA reste une simulation interne ; **bloquante** si un jour échangé | F      |

Un permis est requis **par catégorie** exercée. Le permis est délivré à l'entreprise ; les établissements et les mandataires doivent être déclarés.

## 2. Qualification de DFN

| Scénario                                                                                                       | Analyse préliminaire                                                                                                                                                                                                         | À confirmer par le conseil                                           |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| DFN établie au Québec, utilisateurs au Québec, fonds détenus et transmis par un partenaire titulaire de permis | DFN reçoit une rémunération (frais 150 bps) pour un service dont l'objet est la transmission de fonds : permis « transfert de fonds » **probablement requis**, sauf si DFN est qualifiée de mandataire déclaré du partenaire | Statut de mandataire vs titulaire ; portée de l'exemption éventuelle |
| DFN hors Québec offrant le service à des résidents du Québec                                                   | La loi vise l'offre au public québécois : permis probablement requis                                                                                                                                                         | Critères de « offre au public » en ligne                             |
| Service uniquement destiné aux entreprises (B2B)                                                               | La loi ne distingue pas a priori particuliers et entreprises                                                                                                                                                                 | Confirmer                                                            |
| Conversion de devises affichée mais exécutée par le partenaire                                                 | Risque de qualification « change de devises » si DFN fixe le taux ou perçoit la marge                                                                                                                                        | Confirmer                                                            |

**Position de travail** : prévoir un permis dans les catégories « transfert de fonds » et, si une conversion est proposée, « change de devises », à moins qu'un avis écrit n'établisse un statut de mandataire ou une exemption.

## 3. Conditions de délivrance

| Condition                           | Détail                                                                                                                                                                                                                                 | Correspondance produit / organisation                                    | Statut     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| Demande à l'AMF                     | Formulaire, documents constitutifs, description des services, établissements, mandataires, comptes bancaires                                                                                                                           | Dossier d'entreprise                                                     | À vérifier |
| **Probité (fit-and-proper)**        | Rapport d'habilitation sécuritaire par la Sûreté du Québec sur l'entreprise, ses administrateurs, dirigeants, associés et personnes détenant une participation importante (seuil à confirmer), et sur certains employés et mandataires | Liste des personnes visées ; politique de vérification des antécédents   | À vérifier |
| Capacité financière et bonnes mœurs | Absence de faillite non libérée, d'infractions pertinentes                                                                                                                                                                             | Gouvernance                                                              | À vérifier |
| Mandataires                         | Déclaration de chaque mandataire et de chaque établissement ; responsabilité du titulaire                                                                                                                                              | Table `PaymentProvider` ne couvre pas les mandataires ; registre à créer | À faire    |
| Droits exigibles                    | Droits de délivrance et droits annuels (montants à confirmer)                                                                                                                                                                          | Budget                                                                   | À vérifier |
| Délais                              | Traitement de plusieurs mois (habilitation sécuritaire incluse)                                                                                                                                                                        | Planification                                                            | —          |

## 4. Obligations du titulaire

| Obligation                         | Détail                                                                                                                                   | Correspondance produit                                                                 | Statut                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------- |
| Affichage du permis                | Numéro de permis visible dans les établissements et sur les supports de communication                                                    | Pied de page du site, uniquement après délivrance                                      | À faire                   |
| Mise à jour des renseignements     | Avis à l'AMF des changements (administrateurs, dirigeants, mandataires, établissements, comptes) dans les délais prescrits (à confirmer) | Processus de gouvernance                                                               | À faire                   |
| Tenue de livres et registres       | Registres des opérations, des mandataires, des employés ; conservation (durée à confirmer, généralement alignée sur 5 ans)               | `Transaction`, `Transfer`, `LedgerTransaction`, `AuditLog` ; registres RH hors produit | Partiel                   |
| Rapports à l'AMF                   | Rapport annuel / déclarations périodiques, états financiers le cas échéant                                                               | Exports depuis le registre                                                             | À faire                   |
| Coopération aux inspections        | Accès aux locaux et aux documents                                                                                                        | Capacité d'export complet du dossier d'une transaction                                 | Préparation               |
| Interdiction d'exercer sans permis | Sanctions pénales et administratives                                                                                                     | Garde `DFN_MODE` empêche toute activité réelle                                         | Respecté par construction |
| Déclaration à Revenu Québec        | Certaines informations fiscales (à confirmer)                                                                                            | —                                                                                      | À vérifier                |

## 5. Correspondance modules ↔ catégories

| Module       | Catégorie(s) potentielle(s)           | Déclencheur                                                                      | Mesure préparatoire dans le produit                                                                                                                                  |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Protect  | Transfert de fonds                    | Réception de fonds d'un acheteur québécois pour libération à un vendeur étranger | Les fonds sont détenus par le partenaire (`PaymentProviderAdapter`) ; conserver la preuve du flux (`FundingRequest`, `ProviderEvent`, écritures `FUNDING`/`RELEASE`) |
| B — Wallet   | Transfert de fonds, change de devises | Soldes multi-devises, conversion                                                 | Comptes par devise, FX par deux écritures liées (aucun taux réel en sandbox)                                                                                         |
| C — Transfer | Transfert de fonds, change de devises | Transferts internationaux cotés                                                  | `FXQuote` conserve numérateur/dénominateur et frais : preuve de la rémunération et du taux                                                                           |
| D — Business | Aucune                                | —                                                                                | —                                                                                                                                                                    |
| E — API      | Suit le module                        | Les intégrateurs peuvent devenir mandataires                                     | Clés API tracées par organisation                                                                                                                                    |
| F — DDA      | Monnaie virtuelle                     | Jamais en sandbox                                                                | Ligne rouge (`STABLECOIN_RISKS.md`)                                                                                                                                  |

## 6. Interaction avec les autres régimes

| Régime                                | Interaction                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CANAFE                                | Cumulatif ; l'AMF et CANAFE échangent des renseignements ; le permis ESM n'exempte pas de l'inscription fédérale                     |
| LAPD (Banque du Canada)               | Cumulatif ; un titulaire de permis québécois peut aussi devoir s'enregistrer comme FSP                                               |
| Loi 25                                | Les renseignements personnels recueillis pour la probité et la connaissance du client sont soumis à la Loi 25 (`DATA_PROTECTION.md`) |
| Loi sur la protection du consommateur | Contrats à distance, divulgations ; voir `DISPUTE_HANDLING.md`                                                                       |

## 7. Checklist Québec

- [ ] Avis juridique sur la nécessité d'un permis par catégorie et sur le statut de mandataire.
- [ ] Identifier toutes les personnes soumises à l'habilitation sécuritaire ; recueillir leurs consentements.
- [ ] Constituer le dossier de demande : structure, services, établissements, mandataires, comptes bancaires.
- [ ] Créer le registre des mandataires et des établissements.
- [ ] Définir le processus d'avis de changement à l'AMF.
- [ ] Préparer les exports pour les rapports périodiques et les inspections.
- [ ] Prévoir l'affichage du numéro de permis **après** délivrance seulement.
- [ ] Vérifier que le partenaire de paiement détient lui-même les permis requis au Québec.
- [ ] Aligner la conservation des registres avec `DATA_PROTECTION.md`.

## 8. Questions ouvertes pour le conseil

1. DFN peut-elle opérer comme **mandataire** d'un partenaire titulaire de permis plutôt que comme titulaire ? Quelles conséquences pratiques (déclaration, responsabilité, affichage) ?
2. La perception de frais de plateforme suffit-elle à caractériser l'« offre contre rémunération » même si DFN ne touche jamais les fonds ?
3. Le séquestre conditionnel du module Protect relève-t-il de la catégorie « transfert de fonds » ou d'une autre qualification (dépôt, fiducie) ?
4. Quelle est la portée exacte de la catégorie relative à la monnaie virtuelle et à quelles activités de recherche interne pourrait-elle s'appliquer ?
5. Quels sont les seuils de participation déclenchant l'habilitation sécuritaire des actionnaires ?
6. Quels délais d'avis de changement et quelles durées de conservation s'appliquent en vertu du règlement actuel ?
7. Une entité étrangère du groupe (Sénégal) servant des bénéficiaires de transferts initiés au Québec est-elle visée ?

---

## Annexe A — Scénario d'illustration : qualification d'un flux Protect

| Étape | Fait                                                                                         | Lecture LESM (préliminaire)                                                                                |
| ----- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1     | Aminata (Montréal) crée une transaction de 2 500 CAD et accepte le contrat numérique         | Offre d'un service en ligne à une résidente du Québec                                                      |
| 2     | Le partenaire agréé émet des instructions de financement et reçoit les fonds                 | Réception de fonds par le partenaire (titulaire de permis)                                                 |
| 3     | DFN enregistre la confirmation et crédite le compte `ESCROW` du registre                     | Tenue d'un registre de suivi ; pas de détention de fonds par DFN                                           |
| 4     | Aminata approuve le jalon ; DFN instruit le partenaire de libérer 1 500 CAD à Moussa (Dakar) | Instruction de transmission de fonds à un tiers à l'étranger — cœur de la catégorie « transfert de fonds » |
| 5     | DFN prélève 1,5 % de frais                                                                   | Rémunération du service                                                                                    |
| 6     | Le partenaire convertit en XOF                                                               | Change exécuté par le partenaire ; si DFN affiche ou fixe le taux, analyse « change de devises »           |

Conclusion de travail : DFN est **au minimum** à analyser comme mandataire d'un titulaire et **probablement** comme titulaire de la catégorie « transfert de fonds » ; le conseil tranchera.

## Annexe B — Registres à tenir et correspondance avec le schéma

| Registre requis (à confirmer)                          | Contenu                                          | Source produit                                                   | À ajouter                                            |
| ------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- |
| Registre des opérations                                | Date, montant, devise, parties, mode de paiement | `Transaction`, `Transfer`, `LedgerTransaction`, `FundingRequest` | Export conforme au format AMF                        |
| Registre des mandataires                               | Identité, établissement, catégories, dates       | —                                                                | Table `Agent`                                        |
| Registre des employés affectés aux services monétaires | Identité, poste, habilitation                    | —                                                                | Hors produit (RH)                                    |
| Registre des comptes bancaires utilisés                | Institution, numéro, usage                       | `PaymentProvider.config`                                         | Champs dédiés chiffrés                               |
| Registre des plaintes                                  | Date, objet, traitement                          | `Dispute`, demandes d'assistance                                 | Table `Complaint` distincte des litiges contractuels |

## Annexe C — Chronologie indicative

| Étape                                                                    | Délai indicatif (à confirmer) |
| ------------------------------------------------------------------------ | ----------------------------- |
| Avis juridique sur les catégories et le statut                           | 4–6 semaines                  |
| Collecte des consentements et des pièces pour l'habilitation sécuritaire | 4 semaines                    |
| Dépôt de la demande                                                      | —                             |
| Habilitation sécuritaire par la Sûreté du Québec                         | Plusieurs mois                |
| Décision de l'AMF                                                        | Après habilitation            |
| Mise en place des registres et affichage                                 | Avant la première opération   |

## Annexe D — Glossaire

| Terme                    | Définition de travail                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| ESM (Québec)             | Entreprise de services monétaires au sens de la LESM ; notion distincte de l'ESM fédérale (CANAFE) bien que les activités se recoupent |
| Titulaire                | Entreprise détenant un permis dans une ou plusieurs catégories                                                                         |
| Mandataire               | Personne agissant pour le compte d'un titulaire dans la fourniture des services ; déclarée à l'AMF                                     |
| Habilitation sécuritaire | Vérification de probité réalisée par la Sûreté du Québec à la demande de l'AMF                                                         |
| Catégorie                | Type de service monétaire pour lequel un permis distinct est requis                                                                    |
