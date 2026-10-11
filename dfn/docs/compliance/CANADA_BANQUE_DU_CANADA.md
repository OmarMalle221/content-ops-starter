# Canada — Banque du Canada : Loi sur les activités associées aux paiements de détail (LAPD / RPAA)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il doit être validé par un conseiller juridique avant toute activité réelle. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. Les délais et montants signalés « à confirmer » doivent être vérifiés dans la LAPD, le _Règlement sur les activités associées aux paiements de détail_ et les lignes directrices de surveillance publiées par la Banque du Canada.

| Champ               | Valeur                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autorité            | Banque du Canada (surveillance), ministre des Finances (sécurité nationale)                                                                                                                         |
| Texte principal     | _Loi sur les activités associées aux paiements de détail_ (LAPD ; _Retail Payment Activities Act_, RPAA) et son règlement                                                                           |
| Entrée en vigueur   | Enregistrement des fournisseurs de services de paiement (FSP) ouvert en novembre 2024 ; exigences de protection des fonds et de gestion des risques opérationnels applicables depuis septembre 2025 |
| Statut DFN          | Sandbox — aucun enregistrement demandé                                                                                                                                                              |
| Porte réglementaire | R4 (`ROADMAP.md` §9)                                                                                                                                                                                |

---

## 1. Qui est visé

Un **fournisseur de services de paiement (FSP)** est une personne ou entité qui exécute une **fonction de paiement** dans le cadre d'un service ou d'une activité commerciale, pour des transferts électroniques de fonds en monnaie fiduciaire (pas les cryptoactifs non adossés), lorsqu'elle a un établissement au Canada ou dirige ses services vers des utilisateurs finaux au Canada.

Les cinq fonctions de paiement :

| #   | Fonction de paiement                                                                                           | Illustration                     |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| F1  | Fourniture ou tenue d'un compte détenu au nom d'un ou plusieurs utilisateurs finaux                            | Portefeuille, compte de paiement |
| F2  | Détention de fonds au nom d'un utilisateur final jusqu'à leur retrait ou transfert                             | Solde prépayé, fonds en attente  |
| F3  | Initiation d'un transfert électronique de fonds à la demande d'un utilisateur final                            | Service d'initiation de paiement |
| F4  | Autorisation d'un transfert électronique de fonds ou transmission, réception ou facilitation d'une instruction | Passerelle, agrégateur           |
| F5  | Prestation de services de compensation ou de règlement                                                         | Infrastructure de règlement      |

Exclusions notables (à confirmer dans le texte) : banques et autres entités déjà encadrées par un régime fédéral/provincial équivalent, opérations incidentes à un service non lié aux paiements, systèmes fermés (cartes-cadeaux à usage restreint), opérations en titres, retraits en espèces aux guichets, transferts entre entités du même groupe.

## 2. Analyse d'applicabilité par module DFN

| Module                | Activité envisagée en phase live                                                                                           | Fonctions potentiellement exécutées                                                                                           | Analyse préliminaire                                                                                                         | À confirmer par le conseil                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Diaspora Protect  | Instructions de réception et de libération de fonds exécutées par un partenaire agréé ; registre de séquestre tenu par DFN | F3, F4 (initiation / transmission d'instructions) ; F1/F2 si le séquestre est juridiquement un compte au nom de l'utilisateur | **Enregistrement probable** si DFN transmet des instructions de paiement, même sans détenir les fonds                        | Le partenaire bancaire couvre-t-il DFN ? L'exclusion « incidente » est-elle plaidable ? Qui est l'« utilisateur final » dans un paiement à deux parties ? |
| B — Diaspora Wallet   | Soldes au nom des organisations                                                                                            | F1, F2                                                                                                                        | **Enregistrement très probable** si DFN tient les comptes et que les fonds correspondants sont détenus pour les utilisateurs | Si les fonds sont dans un compte en fiducie du partenaire, DFN reste-t-elle FSP pour F1 ?                                                                 |
| C — Diaspora Transfer | Initiation de transferts internationaux                                                                                    | F3, F4                                                                                                                        | **Enregistrement probable**                                                                                                  | Articulation avec l'inscription ESM (CANAFE) et le permis AMF                                                                                             |
| D — Diaspora Business | Factures, devis, rapports                                                                                                  | Aucune                                                                                                                        | Non visé en soi                                                                                                              | —                                                                                                                                                         |
| E — Diaspora API      | Accès programmatique                                                                                                       | Suit le module appelé                                                                                                         | Les intégrateurs peuvent eux-mêmes être FSP                                                                                  | Responsabilités respectives                                                                                                                               |
| F — DDA               | Aucune activité réelle                                                                                                     | Hors champ (cryptoactif) tant qu'aucune unité n'existe                                                                        | Non visé                                                                                                                     | Si adossé à une monnaie fiduciaire : analyse spécifique (`STABLECOIN_RISKS.md`)                                                                           |

## 3. Enregistrement

| Exigence                                       | Détail                                                                                                                                                                                               | Correspondance produit                             | Statut      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------- |
| Demande d'enregistrement avant d'exercer       | Dossier en ligne : identité, structure, propriétaires, activités, volumes, mesures de protection des fonds et cadre de risque opérationnel, compte(s) utilisés pour les fonds des utilisateurs       | —                                                  | À vérifier  |
| Examen de sécurité nationale                   | Le ministre des Finances peut examiner la demande ; délais variables                                                                                                                                 | —                                                  | À vérifier  |
| Droits d'enregistrement et cotisation annuelle | Montants fixés par règlement (à confirmer)                                                                                                                                                           | Budget à prévoir                                   | À vérifier  |
| Registre public                                | La Banque du Canada publie la liste des FSP enregistrés et refusés                                                                                                                                   | Afficher le statut uniquement après enregistrement | À vérifier  |
| Avis de changement                             | Changements aux renseignements fournis : délai d'avis (à confirmer) ; **changement important** aux activités ou à la protection des fonds : avis préalable (au moins 5 jours ouvrables, à confirmer) | Processus de gestion du changement lié aux ADR     | À faire     |
| Rapport annuel                                 | Dû au plus tard le 31 mars pour l'année civile précédente (à confirmer) : volumes, valeurs, incidents, protection des fonds, cadre de risque                                                         | Exports depuis le registre et `ReconciliationJob`  | À faire     |
| FSP étranger                                   | Entité sans établissement au Canada dirigeant ses services vers des utilisateurs au Canada : également visée                                                                                         | Pertinent pour une entité du groupe au Sénégal     | À confirmer |

## 4. Protection des fonds des utilisateurs finaux

Applicable à tout FSP qui détient des fonds (F2) : les fonds doivent être protégés contre la faillite du FSP et disponibles pour les utilisateurs.

| Exigence                            | Options prévues par la loi                                                                                                                | Correspondance produit                                                                               | Statut                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------- |
| Méthode de protection               | (a) compte en fiducie séparé auprès d'une institution admissible ; (b) assurance ou garantie au profit des utilisateurs ; (c) combinaison | Le modèle DFN prévoit que le **partenaire agréé** détient les fonds ; à démontrer contractuellement  | À vérifier            |
| Cadre écrit de protection des fonds | Politique décrivant comptes, flux, rapprochements, responsabilités                                                                        | À rédiger ; le registre fournit la base de rapprochement                                             | À faire               |
| Rapprochement des fonds             | Rapprochement régulier entre les comptes externes et les passifs envers les utilisateurs                                                  | `LedgerService.reconcile()`, `BalanceSnapshot`, comptes `PROVIDER_SETTLEMENT` vs `ESCROW` + `WALLET` | Préparation (sandbox) |
| Fonds détenus en devises            | Protection applicable à toutes les devises détenues                                                                                       | Comptes par devise (`LedgerAccount.currencyCode`)                                                    | Préparation           |
| Revue indépendante                  | Revue périodique du cadre (fréquence à confirmer, par exemple tous les trois ans)                                                         | À planifier                                                                                          | À vérifier            |
| Information aux utilisateurs        | Explication de la méthode de protection                                                                                                   | Page d'aide + conditions d'utilisation                                                               | À faire               |

## 5. Gestion des risques opérationnels et réponse aux incidents

| Exigence                                   | Détail                                                                                                                                                                                              | Correspondance produit                                                          | Statut     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------- |
| Cadre de gestion des risques opérationnels | Objectifs, identification des risques, contrôles, tests, responsabilités, revue annuelle                                                                                                            | `SECURITY.md` constitue l'ébauche technique ; gouvernance à formaliser          | Ébauche    |
| Continuité et reprise                      | Plans testés ; objectifs de reprise                                                                                                                                                                 | `SECURITY.md` §12 (RPO 24 h / RTO 8 h en sandbox, à réviser)                    | Ébauche    |
| Tiers et sous-traitants                    | Gestion des risques liés aux fournisseurs (hébergeur, partenaire, KYC)                                                                                                                              | Registre des fournisseurs à créer                                               | À faire    |
| Signalement des incidents                  | Avis à la Banque du Canada **sans délai** après avoir déterminé qu'un incident a un impact important sur un utilisateur final, un autre FSP ou un système de paiement ; avis aux personnes touchées | Journal d'incidents + procédure ; les `AuditLog` et logs pino servent de source | À faire    |
| Rapport d'incident                         | Contenu : nature, impact, mesures prises, prévention                                                                                                                                                | Modèle à rédiger                                                                | À faire    |
| Revue indépendante du cadre                | Fréquence à confirmer                                                                                                                                                                               | À planifier                                                                     | À vérifier |

## 6. Pouvoirs de surveillance et sanctions

Demandes de renseignements, examens, avis de violation, pénalités administratives pécuniaires (barème à confirmer), publication, révocation d'enregistrement. Un FSP exerçant sans enregistrement s'expose à des pénalités.

## 7. Articulation avec les autres régimes

| Régime                                   | Articulation                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| CANAFE (ESM)                             | Régimes cumulatifs : l'enregistrement LAPD ne remplace pas l'inscription ESM et inversement (`CANADA_CANAFE.md`) |
| AMF Québec (ESM)                         | Permis provincial cumulatif pour les activités offertes au Québec (`QUEBEC_ESM.md`)                              |
| Protection des renseignements personnels | LPRPDE / Loi 25 pour les données traitées (`DATA_PROTECTION.md`)                                                 |
| Partenaire bancaire                      | Le contrat doit préciser qui exécute quelles fonctions de paiement et qui est enregistré pour quoi               |

## 8. Chronologie indicative pour une phase live au Canada

| Étape                                                                         | Délai indicatif (à confirmer) | Dépendance         |
| ----------------------------------------------------------------------------- | ----------------------------- | ------------------ |
| Avis juridique sur l'applicabilité par module                                 | 4–8 semaines                  | Porte R1           |
| Rédaction du cadre de protection des fonds et du cadre de risque opérationnel | 8–12 semaines                 | Contrat partenaire |
| Dépôt de la demande d'enregistrement                                          | —                             | Dossiers ci-dessus |
| Examen par la Banque du Canada et éventuel examen de sécurité nationale       | Plusieurs mois                | —                  |
| Mise en place du rapport annuel et du processus d'incidents                   | Avant la première opération   | —                  |

## 9. Checklist LAPD

- [ ] Obtenir un avis juridique sur les fonctions de paiement exécutées par DFN pour chaque module.
- [ ] Déterminer, avec le partenaire, qui s'enregistre pour F1–F5 et le consigner au contrat.
- [ ] Rédiger le cadre de protection des fonds (comptes en fiducie / assurance) et le faire valider.
- [ ] Formaliser le cadre de gestion des risques opérationnels à partir de `SECURITY.md`.
- [ ] Mettre en place la procédure de signalement d'incidents (critères d'impact important, modèle d'avis, responsables).
- [ ] Préparer l'extraction des données du rapport annuel (volumes, valeurs par devise et corridor, incidents).
- [ ] Créer le registre des tiers et sous-traitants.
- [ ] Planifier les revues indépendantes et la revue annuelle du cadre.
- [ ] Déposer la demande d'enregistrement et budgéter les droits.
- [ ] Ne publier aucune mention d'enregistrement avant confirmation.

## 10. Questions ouvertes pour le conseil

1. Dans le module Protect, l'acheteur et le vendeur sont-ils tous deux des « utilisateurs finaux » de DFN ? Cela modifie-t-il l'analyse de F1/F2 ?
2. Le registre comptable de séquestre tenu par DFN, adossé à un compte en fiducie du partenaire, constitue-t-il la « tenue d'un compte » (F1) ?
3. L'exclusion des activités incidentes peut-elle s'appliquer au module Business si la facturation reste indépendante des paiements ?
4. Quels sont, dans la version en vigueur du règlement, les délais exacts d'avis de changement, de changement important et de rapport annuel ?
5. Quelle est la fréquence exacte des revues indépendantes des cadres de protection des fonds et de risque opérationnel ?
6. Un FSP étranger du groupe (Sénégal) qui ne sert que des bénéficiaires est-il visé ?
7. Comment articuler les exigences de protection des fonds de la LAPD avec les exigences de cantonnement de la BCEAO pour un même flux ?

---

## Annexe A — Correspondance exigences LAPD ↔ schéma de données

| Exigence                                               | Entités / champs existants                                                                               | À ajouter                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Identification des fonds détenus pour les utilisateurs | `LedgerAccount(type=LIABILITY)` codes `ESCROW:*`, `WALLET:*` ; `Wallet`                                  | Étiquette `safeguarded = true` sur les comptes de passif couverts par le cadre ; référence du compte en fiducie externe |
| Fonds détenus chez le partenaire                       | `LedgerAccount(type=ASSET)` code `PROVIDER_SETTLEMENT:*` ; `PaymentProvider`                             | `PaymentProvider.trustAccountRef`, `institution`, `safeguardingMethod` (fiducie / assurance)                            |
| Rapprochement                                          | `ReconciliationJob`, `ReconciliationDifference`, `BalanceSnapshot`                                       | Import du relevé partenaire ; écart « externe vs passif total » ; fréquence quotidienne                                 |
| Volumes et valeurs pour le rapport annuel              | `LedgerTransaction(kind, postedAt)`, `LedgerEntry(currencyCode, amountMinor)`, `Transfer`, `Transaction` | Vue agrégée par mois, devise, corridor, fonction de paiement ; conversion en CAD au taux de référence                   |
| Incidents                                              | `AuditLog`, logs pino                                                                                    | Table `OperationalIncident` (détection, impact, utilisateurs touchés, notifications, clôture)                           |
| Tiers et sous-traitants                                | —                                                                                                        | Registre `ThirdPartyProvider` (service, criticité, contrat, revue)                                                      |
| Changements importants                                 | ADR, `AUTHORIZATIONS_CHECKLIST.md`                                                                       | Journal des changements notifiés                                                                                        |

## Annexe B — Données du rapport annuel (préparation)

| Donnée attendue (à confirmer dans le formulaire officiel) | Source produit                                     | Fréquence de calcul |
| --------------------------------------------------------- | -------------------------------------------------- | ------------------- |
| Nombre et valeur des transferts par fonction de paiement  | `Transaction` financées/réglées, `Transfer` réglés | Mensuelle           |
| Valeur moyenne et maximale des fonds détenus              | `BalanceSnapshot` sur les comptes de passif        | Quotidienne         |
| Nombre d'utilisateurs finaux                              | `User`, `Organization` actifs                      | Mensuelle           |
| Devises                                                   | `Currency.isActive`, `LedgerEntry.currencyCode`    | —                   |
| Incidents déclarés et non déclarés                        | `OperationalIncident`                              | Continue            |
| Méthode de protection des fonds et comptes                | Configuration + `PaymentProvider`                  | Annuelle            |
| Revue du cadre de risque                                  | Documentation                                      | Annuelle            |

## Annexe C — Glossaire

| Terme                | Définition de travail                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| FSP / PSP            | Fournisseur de services de paiement visé par la LAPD                                                                         |
| Fonction de paiement | L'une des cinq fonctions (compte, détention de fonds, initiation, autorisation/transmission, compensation/règlement)         |
| Utilisateur final    | Personne ou entité qui utilise un service de paiement en tant que payeur ou bénéficiaire                                     |
| Protection des fonds | Mesures (fiducie, assurance/garantie) garantissant la disponibilité des fonds des utilisateurs en cas d'insolvabilité du FSP |
| Incident             | Événement ayant un impact important sur les utilisateurs, d'autres FSP ou un système de paiement                             |
| Changement important | Modification des activités ou de la protection des fonds devant être notifiée préalablement                                  |
