# Liste consolidée des autorisations, inscriptions et contrats à vérifier avant toute activité réelle

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Chaque ligne doit être confirmée, complétée ou invalidée par un conseiller juridique dans la juridiction concernée. Aucune autorisation n'est réputée obtenue ou inutile tant que la colonne « Statut » n'indique pas une référence d'autorisation ou un avis écrit archivé. Aucune réglementation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit.

| Champ                    | Valeur                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Statut global            | **Sandbox — toutes les lignes sont « À vérifier »** ; aucune demande déposée                                                                                                                           |
| Mise à jour              | 2026-10-11                                                                                                                                                                                             |
| Propriétaire du document | Responsable conformité (à nommer)                                                                                                                                                                      |
| Règle                    | Une phase live d'un module sur un corridor n'est autorisée que si **toutes** les lignes « Bloquant » applicables à ce module et à ce corridor sont au statut « Obtenu » ou « Non requis (avis écrit) » |

## 1. Légende

| Colonne | Valeurs                                                                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Niveau  | **Bloquant** : interdit toute activité réelle du module / corridor ; **Fort** : à obtenir avant ouverture au public mais n'interdit pas une phase pilote restreinte sous avis ; **Recommandé** : bonne pratique |
| Statut  | `À vérifier` (défaut) → `En analyse` → `Demande déposée` → `Obtenu <référence>` ou `Non requis (avis du <date>)`                                                                                                |
| Owner   | Rôle responsable du suivi                                                                                                                                                                                       |
| Modules | A Protect, B Wallet, C Transfer, D Business, E API, F DDA                                                                                                                                                       |

## 2. Canada (fédéral)

| #     | Autorisation / obligation                                                                              | Autorité                                      | Modules             | Corridors  | Niveau          | Owner                   | Statut     | Référence                       |
| ----- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------- | ---------- | --------------- | ----------------------- | ---------- | ------------------------------- |
| CA-01 | Avis juridique écrit sur la qualification des activités (ESM, FSP, séquestre)                          | Conseil externe                               | A, B, C             | Tous       | Bloquant        | Direction               | À vérifier | `README.md` §4, porte R1        |
| CA-02 | Inscription comme entreprise de services monétaires                                                    | CANAFE                                        | A, C (B selon avis) | Tous       | Bloquant        | Conformité              | À vérifier | `CANADA_CANAFE.md` §2           |
| CA-03 | Programme de conformité LBC/FT approuvé (agent, politiques, évaluation des risques, formation, examen) | CANAFE (exigence)                             | A, B, C             | Tous       | Bloquant        | Conformité              | À vérifier | `AML_POLICY.md`                 |
| CA-04 | Capacité de déclaration (DOD, télévirements ≥ 10 000 CAD, règle des 24 h, règle de voyage)             | CANAFE                                        | A, C                | Tous       | Bloquant        | Conformité + Ingénierie | À vérifier | `CANADA_CANAFE.md` §3.4–3.6     |
| CA-05 | Enregistrement comme fournisseur de services de paiement (LAPD) ou avis d'exclusion                    | Banque du Canada                              | A, B, C             | Tous       | Bloquant        | Conformité              | À vérifier | `CANADA_BANQUE_DU_CANADA.md` §3 |
| CA-06 | Cadre de protection des fonds des utilisateurs finaux (fiducie / assurance)                            | Banque du Canada                              | B (A, C selon avis) | Tous       | Bloquant        | Finance                 | À vérifier | `CANADA_BANQUE_DU_CANADA.md` §4 |
| CA-07 | Cadre de gestion des risques opérationnels et procédure d'incidents                                    | Banque du Canada                              | A, B, C             | Tous       | Bloquant        | Sécurité                | À vérifier | `CANADA_BANQUE_DU_CANADA.md` §5 |
| CA-08 | Conformité LPRPDE (politique, registre des atteintes 24 mois, contrats sous-traitants)                 | Commissariat à la protection de la vie privée | Tous                | Tous       | Bloquant        | Responsable PRP         | À vérifier | `DATA_PROTECTION.md` §2.1       |
| CA-09 | Criblage des sanctions et procédure de gel / déclaration                                               | Autorités compétentes                         | A, B, C             | Tous       | Bloquant        | Conformité              | À vérifier | `CANADA_CANAFE.md` §3.8         |
| CA-10 | Inscription ESM étrangère pour une entité du groupe hors Canada (si applicable)                        | CANAFE                                        | A, C                | SN, GN, CI | Fort            | Conformité              | À vérifier | `CANADA_CANAFE.md` §2           |
| CA-11 | Analyse valeurs mobilières / cadre stablecoin pour tout DDA réel                                       | ACVM, cadre fédéral                           | F                   | —          | Bloquant absolu | Direction               | À vérifier | `STABLECOIN_RISKS.md` §7        |

## 3. Québec

| #     | Autorisation / obligation                                                                                                  | Autorité                 | Modules             | Corridors | Niveau          | Owner           | Statut     | Référence                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------- | --------- | --------------- | --------------- | ---------- | ----------------------------- |
| QC-01 | Permis d'entreprise de services monétaires — catégorie transfert de fonds (ou avis de statut de mandataire)                | AMF                      | A, C (B selon avis) | Tous      | Bloquant        | Conformité      | À vérifier | `QUEBEC_ESM.md` §1–3          |
| QC-02 | Permis — catégorie change de devises (si conversion proposée)                                                              | AMF                      | B, C                | Tous      | Bloquant        | Conformité      | À vérifier | `QUEBEC_ESM.md` §1            |
| QC-03 | Habilitation sécuritaire des dirigeants, administrateurs, actionnaires visés                                               | Sûreté du Québec via AMF | A, B, C             | Tous      | Bloquant        | Direction       | À vérifier | `QUEBEC_ESM.md` §3            |
| QC-04 | Désignation du responsable de la protection des renseignements personnels, EFVP, registre des incidents, politique publiée | CAI (Loi 25)             | Tous                | Tous      | Bloquant        | Responsable PRP | À vérifier | `DATA_PROTECTION.md` §2.2, §8 |
| QC-05 | Conformité des CGU et de la politique de litiges à la Loi sur la protection du consommateur                                | OPC                      | A, D                | Tous      | Fort            | Juridique       | À vérifier | `DISPUTE_HANDLING.md` §10     |
| QC-06 | Catégorie monnaie virtuelle (LESM) pour tout DDA réel                                                                      | AMF                      | F                   | —         | Bloquant absolu | Direction       | À vérifier | `QUEBEC_ESM.md` §1            |

## 4. Sénégal / UEMOA

| #     | Autorisation / obligation                                                                                                  | Autorité                                      | Modules | Corridors  | Niveau   | Owner           | Statut     | Référence                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------- | ---------- | -------- | --------------- | ---------- | ------------------------- |
| SN-01 | Avis juridique local sur le statut de prestataire technique sans agrément propre                                           | Conseil local                                 | A, B, C | → SN, → CI | Bloquant | Direction       | À vérifier | `SENEGAL_BCEAO.md` §1     |
| SN-02 | Contrat avec une banque ou un EME agréé par la BCEAO (réception, cantonnement, paiement, remboursement)                    | BCEAO (agrément du partenaire)                | A, B, C | → SN, → CI | Bloquant | Partenariats    | À vérifier | `SENEGAL_BCEAO.md` §7     |
| SN-03 | Vérification de l'agrément du partenaire et de sa capacité change                                                          | BCEAO                                         | A, B, C | → SN, → CI | Bloquant | Conformité      | À vérifier | `SENEGAL_BCEAO.md` §2     |
| SN-04 | Procédure de change et de transferts sortants (remboursements) conforme au règlement des relations financières extérieures | Ministère des Finances / BCEAO via partenaire | A, C    | → SN, → CI | Bloquant | Finance         | À vérifier | `SENEGAL_BCEAO.md` §4     |
| SN-05 | Coopération LBC/FT via le partenaire (CENTIF), conservation, gel des avoirs                                                | CENTIF                                        | A, B, C | → SN       | Bloquant | Conformité      | À vérifier | `SENEGAL_BCEAO.md` §5     |
| SN-06 | Déclaration / autorisation des traitements et des transferts de données (loi 2008-12)                                      | CDP                                           | Tous    | → SN       | Bloquant | Responsable PRP | À vérifier | `DATA_PROTECTION.md` §2.3 |
| SN-07 | Analyse de localisation des données et secret bancaire                                                                     | BCEAO / CDP                                   | Tous    | → SN       | Fort     | Sécurité        | À vérifier | `SENEGAL_BCEAO.md` §6     |
| SN-08 | Convention de sous-agent si points de retrait                                                                              | Banque partenaire / BCEAO                     | A, C    | → SN       | Fort     | Partenariats    | À vérifier | `SENEGAL_BCEAO.md` §3     |
| SN-09 | Opposabilité du contrat numérique et mentions locales                                                                      | Conseil local                                 | A       | → SN       | Fort     | Juridique       | À vérifier | `DISPUTE_HANDLING.md` §10 |
| CI-01 | Réplication des lignes SN-01 à SN-09 pour la Côte d'Ivoire (autorités nationales : ARTCI pour les données)                 | BCEAO, ARTCI                                  | A, B, C | → CI       | Bloquant | Conformité      | À vérifier | `SENEGAL_BCEAO.md` §9     |

## 5. Guinée

| #     | Autorisation / obligation                                                     | Autorité                      | Modules | Corridors | Niveau   | Owner           | Statut     | Référence           |
| ----- | ----------------------------------------------------------------------------- | ----------------------------- | ------- | --------- | -------- | --------------- | ---------- | ------------------- |
| GN-01 | Avis juridique local et références exactes des textes BCRG                    | Conseil local                 | A, B, C | → GN      | Bloquant | Direction       | À vérifier | `GUINEE_BCRG.md` §2 |
| GN-02 | Rencontre / déclaration auprès de la BCRG sur le modèle prestataire technique | BCRG                          | A, B, C | → GN      | Bloquant | Conformité      | À vérifier | `GUINEE_BCRG.md` §8 |
| GN-03 | Contrat avec un établissement agréé (banque / EME)                            | BCRG (agrément du partenaire) | A, B, C | → GN      | Bloquant | Partenariats    | À vérifier | `GUINEE_BCRG.md` §6 |
| GN-04 | Procédure de change GNF et de sorties de devises (remboursements)             | BCRG via partenaire           | A, C    | → GN      | Bloquant | Finance         | À vérifier | `GUINEE_BCRG.md` §3 |
| GN-05 | Coopération LBC/FT (CENTIF-Guinée)                                            | CENTIF-GN                     | A, B, C | → GN      | Bloquant | Conformité      | À vérifier | `GUINEE_BCRG.md` §4 |
| GN-06 | Formalités de protection des données (loi de 2016)                            | Autorité à confirmer          | Tous    | → GN      | Bloquant | Responsable PRP | À vérifier | `GUINEE_BCRG.md` §5 |

## 6. Europe et États-Unis (corridors d'expansion / recherche — analyse non commencée)

| #     | Autorisation / obligation                                                                                                                                                | Autorité                      | Modules    | Corridors       | Niveau   | Owner           | Statut     | Référence |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ---------- | --------------- | -------- | --------------- | ---------- | --------- |
| EU-01 | Qualification au regard de la directive sur les services de paiement (agrément d'établissement de paiement ou agent) et de la réglementation LBC/FT ; MiCA pour tout DDA | ACPR (France), BNB (Belgique) | A, B, C, F | FR/BE → SN/CI   | Bloquant | Direction       | À vérifier | À créer   |
| EU-02 | Conformité RGPD (base légale, transferts hors UE)                                                                                                                        | CNIL, APD                     | Tous       | FR/BE → Afrique | Bloquant | Responsable PRP | À vérifier | À créer   |
| US-01 | Inscription MSB fédérale (FinCEN) et licences de transmission de fonds par État                                                                                          | FinCEN, régulateurs d'État    | A, B, C    | US → SN/GN      | Bloquant | Direction       | À vérifier | À créer   |
| US-02 | Conformité sanctions (OFAC)                                                                                                                                              | OFAC                          | A, B, C    | US → Afrique    | Bloquant | Conformité      | À vérifier | À créer   |

## 7. Contrats et prérequis transversaux

| #     | Élément                                                                                                                           | Contrepartie                                | Modules       | Niveau     | Owner        | Statut     | Référence                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------- | ---------- | ------------ | ---------- | ------------------------------- |
| TR-01 | Contrat de partenaire de paiement (Canada) : réception des fonds, fiducie, exécution, événements signés, rapprochement, incidents | Banque / institution de paiement canadienne | A, B, C       | Bloquant   | Partenariats | À vérifier | `CANADA_BANQUE_DU_CANADA.md` §4 |
| TR-02 | Contrat fournisseur KYC/KYB (couverture CA, SN, GN, CI ; sous-traitance données ; EFVP)                                           | Fournisseur                                 | A, B, C, D, E | Bloquant   | Conformité   | À vérifier | `KYC_KYB.md` §5                 |
| TR-03 | Contrat fournisseur de listes sanctions / PPE                                                                                     | Fournisseur                                 | A, B, C       | Bloquant   | Conformité   | À vérifier | `KYC_KYB.md` §5                 |
| TR-04 | Audit de sécurité indépendant (test d'intrusion, revue du registre et des gardes)                                                 | Cabinet                                     | Tous          | Bloquant   | Sécurité     | À vérifier | `SECURITY.md` §14               |
| TR-05 | Assurance responsabilité civile professionnelle et cyber                                                                          | Assureur                                    | Tous          | Fort       | Finance      | À vérifier | —                               |
| TR-06 | CGU, politique de confidentialité, politique de litiges, contrat numérique validés (FR/EN, Québec, SN, GN)                        | Conseil                                     | A, D          | Fort       | Juridique    | À vérifier | `DISPUTE_HANDLING.md`           |
| TR-07 | Conventions de médiation externe                                                                                                  | Organismes de médiation                     | A             | Recommandé | Juridique    | À vérifier | `DISPUTE_HANDLING.md` §10       |
| TR-08 | Contrats hébergeur / stockage / e-mail avec clauses de protection des données et localisation                                     | Fournisseurs                                | Tous          | Bloquant   | Sécurité     | À vérifier | `DATA_PROTECTION.md` §3         |
| TR-09 | Nomination formelle : agent de conformité, responsable PRP, responsable sécurité                                                  | Interne                                     | Tous          | Bloquant   | Direction    | À vérifier | `README.md` §5                  |
| TR-10 | Revue à deux personnes et ADR pour toute modification du garde `DFN_MODE` ou des fabriques d'adaptateurs                          | Interne                                     | Tous          | Bloquant   | Ingénierie   | À vérifier | `SECURITY.md` §15               |
| TR-11 | Pour l'API (Phase 5) : contrats d'intégrateurs, qualification mandataire / FSP                                                    | Intégrateurs                                | E             | Fort       | Partenariats | À vérifier | `CANADA_CANAFE.md` §6           |

## 8. Matrice de synthèse module × corridor (lignes bloquantes à franchir)

| Module     | CA → SN                                                                            | CA → GN                                  | CA → CI                     | FR/BE → SN/CI            | US → SN/GN               |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------- | ------------------------ | ------------------------ |
| A Protect  | CA-01…09, QC-01, 03, 04, SN-01…06, TR-01…04, 08, 09, 10                            | CA-01…09, QC-01, 03, 04, GN-01…06, TR-\* | CA-01…09, QC-_, CI-01, TR-_ | EU-01, 02 + côté Afrique | US-01, 02 + côté Afrique |
| B Wallet   | A + CA-06, QC-02 (si change)                                                       | Idem                                     | Idem                        | Idem                     | Idem                     |
| C Transfer | A + CA-04 (télévirements), QC-02, SN-04                                            | A + GN-04                                | A + CI-01                   | EU-\*                    | US-\*                    |
| D Business | CA-08, QC-04, QC-05, TR-06, 08                                                     | Idem                                     | Idem                        | EU-02                    | —                        |
| E API      | Lignes du module appelé + TR-11                                                    | Idem                                     | Idem                        | Idem                     | Idem                     |
| F DDA      | **Aucune activité réelle autorisée** — CA-11, QC-06 + avis spécifiques ; porte R10 | Idem                                     | Idem                        | EU-01 (MiCA)             | Idem                     |

## 9. Procédure de mise à jour

1. Toute confirmation (avis, référence d'autorisation, contrat signé) est archivée dans le coffre documentaire de la conformité et référencée dans la colonne « Référence ».
2. Le statut est modifié par le responsable conformité uniquement, avec date.
3. Une revue trimestrielle vérifie l'exhaustivité ; les nouvelles exigences (textes modifiés) ajoutent des lignes, jamais n'en suppriment sans avis écrit.
4. Avant toute phase live : extraction de la matrice §8 pour le module et le corridor concernés, signée par la direction, le responsable conformité et le responsable sécurité, et consignée dans un ADR.

## 10. Suivi dans l'application

> **Suivi uniquement — aucun statut ne permet d'activer des fonds réels ; `DFN_MODE` reste `sandbox`.** Le registre applicatif ne remplace ni ce document, ni les avis juridiques, ni la procédure du §9 : il en trace l'avancement.

| Élément                  | Fonctionnement                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Écran                    | Administration → « Portes réglementaires » (`/admin/gates`) : registre R1 à R10 (ROADMAP §10), historique de chaque porte, fournisseurs configurés et portes qu'ils exigeraient                                                                                      |
| Droits                   | Lecture : conformité et administrateurs ; écriture : administrateurs uniquement                                                                                                                                                                                      |
| Statuts                  | `Non commencée` → `En cours` → `Seconde approbation attendue` → `Satisfaite (suivi)` ; `Révoquée` possible depuis les trois derniers (approbations effacées), puis reprise en `En cours`                                                                             |
| Double validation        | Deux approbations par deux administrateurs différents, chacune avec une note et une référence de preuve obligatoires (texte : identifiant d'archive du coffre documentaire, numéro de dossier — aucun fichier n'est déposé dans l'application)                       |
| Traçabilité              | Chaque transition crée un événement horodaté (auteur, statut avant/après, note), une entrée du journal d'audit (avec la référence de preuve) et une notification à tous les administrateurs                                                                          |
| Lien avec ce document    | Les lignes du présent document se rattachent aux portes par la colonne « Référence » (par ex. CA-01 → R1) ; la référence de preuve saisie dans le registre doit pointer vers la pièce archivée conformément au §9.1                                                  |
| Fournisseurs partenaires | Les variables `KYC_PROVIDER`, `SANCTIONS_PROVIDER`, `PAYMENT_PROVIDER`, `FX_PROVIDER`, `PAYOUT_PROVIDER` n'acceptent que `sandbox` ; tout autre code empêche le démarrage de l'API (`PROVIDER_NOT_ACTIVATABLE`), même si toutes les portes requises sont satisfaites |

Références techniques : ADR-0012 (`docs/decisions/ADR-0012-portes-reglementaires-partenaires.md`) et contrats de référence des partenaires (`docs/architecture/PARTNER_ADAPTERS.md`).

---

## Annexe A — Séquencement recommandé pour le corridor de lancement (CA → SN, module A)

| Ordre | Lignes                                                      | Raison                                                                            |
| ----- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1     | CA-01, SN-01, TR-09                                         | Les avis juridiques et les nominations déterminent tout le reste                  |
| 2     | TR-02, TR-03, QC-04, CA-08, SN-06                           | Fournisseurs KYC/sanctions et conformité données : préalables aux pilotes         |
| 3     | TR-01, SN-02, SN-03                                         | Contrats partenaires (Canada et Sénégal) ; définissent qui s'enregistre pour quoi |
| 4     | CA-02, CA-03, CA-04, CA-09, QC-01, QC-03                    | Inscriptions et permis fondés sur la structure contractuelle retenue              |
| 5     | CA-05, CA-06, CA-07                                         | Enregistrement FSP et cadres LAPD                                                 |
| 6     | SN-04, SN-05, SN-07, SN-09                                  | Procédures opérationnelles côté Sénégal                                           |
| 7     | TR-04, TR-05, TR-06, TR-08, TR-10                           | Audit de sécurité, assurance, CGU, hébergement, gouvernance du garde              |
| 8     | Signature de la matrice §8 et ADR de sortie du mode sandbox | Décision formelle                                                                 |

## Annexe B — Modèle de fiche de suivi d'une autorisation

| Champ                                                    | Contenu                                             |
| -------------------------------------------------------- | --------------------------------------------------- |
| Identifiant                                              | Ex. `CA-02`                                         |
| Intitulé                                                 | Inscription comme entreprise de services monétaires |
| Autorité / contrepartie                                  | CANAFE                                              |
| Fondement juridique (référence confirmée par le conseil) | —                                                   |
| Modules / corridors concernés                            | A, C / tous                                         |
| Niveau                                                   | Bloquant                                            |
| Owner                                                    | Responsable conformité                              |
| Avis juridique                                           | Référence, date, auteur                             |
| Pièces du dossier                                        | Liste                                               |
| Date de dépôt                                            | —                                                   |
| Référence d'autorisation                                 | —                                                   |
| Date d'obtention / de renouvellement                     | —                                                   |
| Conditions particulières                                 | —                                                   |
| Statut                                                   | `À vérifier`                                        |
| Historique                                               | Date, changement, auteur                            |

## Annexe C — Glossaire des owners

| Owner           | Rôle                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| Direction       | Direction générale ; décisions d'engagement et de sortie du mode sandbox |
| Conformité      | Responsable / agent de conformité (à nommer)                             |
| Responsable PRP | Responsable de la protection des renseignements personnels (Loi 25)      |
| Sécurité        | Responsable de la sécurité de l'information                              |
| Finance         | Direction financière (protection des fonds, comptes, assurances)         |
| Partenariats    | Responsable des relations avec les partenaires financiers                |
| Juridique       | Conseil interne ou externe coordonnant les avis                          |
| Ingénierie      | Responsable technique (garde `DFN_MODE`, adaptateurs, exports)           |
| Produit         | Responsable produit (mise à jour des correspondances produit)            |
