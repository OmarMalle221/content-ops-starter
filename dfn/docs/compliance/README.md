# Dossier de conformité — Diaspora Financial Network (Diaspora Trust)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il a été rédigé par l'équipe produit pour organiser le travail de mise en conformité et doit être revu, complété et validé par des conseillers juridiques qualifiés dans chaque juridiction concernée (Canada fédéral, Québec, Sénégal / UEMOA, Guinée) avant toute activité réelle.

> **Aucune réglementation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit.** Le fait que la plateforme dispose, par exemple, d'un adaptateur KYC, d'un moteur de règles de risque ou d'un journal d'audit ne signifie pas que les obligations de vérification de l'identité, de surveillance ou de conservation des documents sont remplies. Seuls un avis juridique écrit, les autorisations des autorités compétentes et des contrats signés avec des partenaires agréés peuvent établir la conformité.

---

## 1. Rappel du statut de la plateforme

| Élément                      | Situation actuelle                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Mode d'exécution             | `sandbox` uniquement (`DFN_MODE=sandbox`, garde au démarrage de l'API)                                                 |
| Fonds                        | Aucun fonds réel ; toutes les valeurs sont fictives ; bandeau « Données fictives — Aucun fonds réel » sur chaque écran |
| Vérification d'identité      | Adaptateur sandbox ; résultats `SIMULATED_PASS` / `SIMULATED_FAIL` jamais présentés comme réels                        |
| Criblage sanctions           | Adaptateur sandbox ; statuts `CLEAR_SIMULATED` / `POTENTIAL_MATCH_SIMULATED`                                           |
| Partenaire de paiement       | Simulateur `SANDBOX_PARTNER` ; aucune intégration bancaire                                                             |
| Autorisations réglementaires | **Aucune** inscription, aucun permis, aucun agrément n'a été demandé ni obtenu                                         |
| Activité commerciale         | Aucune ; démonstrations et tests uniquement                                                                            |

Toute phase « live » est conditionnée aux portes réglementaires R1 à R10 décrites dans `ROADMAP.md` §9 et détaillées dans `AUTHORIZATIONS_CHECKLIST.md`.

## 2. Index des documents

| Document                                                       | Objet                                                                                                                                                | Juridiction / thème               | Statut              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------- |
| [`CANADA_CANAFE.md`](./CANADA_CANAFE.md)                       | Entreprises de services monétaires, programme LBC/FT, déclarations à CANAFE, règle des 24 heures, règle de voyage                                    | Canada fédéral — LRPCFAT          | Préparation         |
| [`CANADA_BANQUE_DU_CANADA.md`](./CANADA_BANQUE_DU_CANADA.md)   | Loi sur les activités associées aux paiements de détail (LAPD / RPAA) : enregistrement des FSP, protection des fonds, risque opérationnel, incidents | Canada fédéral — Banque du Canada | Préparation         |
| [`QUEBEC_ESM.md`](./QUEBEC_ESM.md)                             | Loi sur les entreprises de services monétaires : catégories de permis, probité, rapports                                                             | Québec — AMF                      | Préparation         |
| [`SENEGAL_BCEAO.md`](./SENEGAL_BCEAO.md)                       | Cadre UEMOA : monnaie électronique, transfert rapide d'argent, partenariat bancaire, réglementation des changes, localisation des données            | Sénégal / UEMOA — BCEAO           | Préparation         |
| [`GUINEE_BCRG.md`](./GUINEE_BCRG.md)                           | Agrément des prestataires de paiement / monnaie électronique, contrôle des changes GNF, modèle de partenariat                                        | Guinée — BCRG                     | Préparation         |
| [`KYC_KYB.md`](./KYC_KYB.md)                                   | Vigilance à l'égard de la clientèle (CDD/EDD), PPE, bénéficiaires effectifs, interface fournisseur, minimisation                                     | Transversal                       | Préparation         |
| [`AML_POLICY.md`](./AML_POLICY.md)                             | Ébauche de programme LBC/FT : gouvernance, approche par les risques, moteur de règles explicable, files de revue, contestation                       | Transversal                       | Ébauche             |
| [`DATA_PROTECTION.md`](./DATA_PROTECTION.md)                   | LPRPDE, Loi 25, loi sénégalaise 2008-12 (CDP), Guinée ; inventaire des données, rétention, droits, transferts, incidents, EFVP                       | Transversal                       | Préparation         |
| [`DISPUTE_HANDLING.md`](./DISPUTE_HANDLING.md)                 | Politique de traitement des litiges Diaspora Protect, protection du consommateur, médiation externe                                                  | Transversal / Québec              | Ébauche             |
| [`STABLECOIN_RISKS.md`](./STABLECOIN_RISKS.md)                 | Recherche DDA : réserves, liquidité, dé-ancrage, risques opérationnels, paysage réglementaire, lignes rouges                                         | Recherche                         | Analyse             |
| [`AUTHORIZATIONS_CHECKLIST.md`](./AUTHORIZATIONS_CHECKLIST.md) | Tableau consolidé des autorisations, inscriptions et contrats à vérifier par juridiction et par module                                               | Transversal                       | Tout « À vérifier » |

## 3. Conventions utilisées

| Convention                     | Signification                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Seuil à confirmer**          | L'équipe n'est pas certaine du montant, du délai ou de la référence exacte ; le conseil doit le confirmer avant usage. |
| **À confirmer par le conseil** | Point d'interprétation juridique ouvert.                                                                               |
| **Correspondance produit**     | Fonctionnalité existante qui _prépare_ une obligation sans la satisfaire.                                              |
| Statut « À vérifier »          | Valeur par défaut de toute autorisation dans la checklist consolidée.                                                  |
| Références de code             | Chemins relatifs à la racine du dépôt (`packages/…`, `apps/…`).                                                        |

## 4. Principes de conformité intégrés au produit

Ces principes sont des **choix de conception** ; ils facilitent une future conformité mais ne la constituent pas.

1. **Fonds réels toujours détenus par un prestataire agréé** — la plateforme n'est pas conçue pour détenir des fonds ; elle émet des instructions et enregistre des événements (`packages/payment-adapters/src/types.ts`).
2. **Score de risque consultatif** — recommandation `NONE` / `MONITOR` / `MANUAL_REVIEW` ; jamais de refus ni de confiscation automatique (`packages/compliance/src/risk/engine.ts`).
3. **Explicabilité** — chaque signal de risque porte les faits qui l'ont déclenché (`RiskSignal.explanation`), consultables par la personne concernée en cas de contestation.
4. **Traçabilité** — journal d'audit, historique immuable des transactions, décisions motivées de litige, contre-passations comptables.
5. **Minimisation** — aucune donnée brute de pièce d'identité en base (`IdentityVerification.declaredData` ne contient que le type et le pays émetteur) ; documents chiffrés et à accès contrôlé.
6. **Transparence sandbox** — vocabulaire `SIMULATED_*`, bandeau permanent, en-tête `x-dfn-mode`.

## 5. Gouvernance de ce dossier

| Rôle                                                                | Responsabilité                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Responsable produit                                                 | Tenue à jour des correspondances produit ↔ obligations, mise à jour à chaque phase |
| Responsable conformité (à nommer)                                   | Validation des checklists, relation avec les conseils et les autorités              |
| Conseil juridique externe (à mandater par juridiction)              | Avis écrits, confirmation des seuils, qualification des activités                   |
| Responsable de la protection des renseignements personnels (Loi 25) | `DATA_PROTECTION.md`, registre des incidents, EFVP                                  |
| Ingénierie                                                          | Mise en œuvre des exigences confirmées, tests, revue du garde `DFN_MODE`            |

Chaque document comporte une section « Questions ouvertes pour le conseil » ; ces questions sont consolidées lors de la revue trimestrielle du dossier. Les décisions prises sont consignées dans `docs/decisions/` (ADR) lorsqu'elles ont un impact sur l'architecture.

## 6. Historique

| Date       | Version | Changement                                             |
| ---------- | ------- | ------------------------------------------------------ |
| 2026-10-11 | 1.0     | Création du dossier à l'issue des Phases 0–2 (sandbox) |

## 7. Glossaire commun

| Terme                  | Définition de travail                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Sandbox                | Mode d'exécution unique de la plateforme : données fictives, aucun fonds réel, partenaires simulés                     |
| Paiement conditionnel  | Mécanisme du module Protect : fonds reçus par un partenaire agréé et libérés par jalons sur approbation                |
| Partenaire agréé       | Banque, institution de paiement, ESM ou EME disposant des autorisations nécessaires pour détenir et déplacer des fonds |
| Porte réglementaire    | Condition (avis, autorisation, contrat) à franchir avant toute phase live ; liste dans `ROADMAP.md` §9                 |
| Correspondance produit | Fonctionnalité qui prépare une obligation sans la satisfaire                                                           |
| LBC/FT                 | Lutte contre le blanchiment de capitaux et le financement du terrorisme                                                |
| KYC / KYB              | Connaissance du client (personne physique) / de l'entreprise                                                           |
| EFVP                   | Évaluation des facteurs relatifs à la vie privée (Loi 25)                                                              |
| ADR                    | Architecture Decision Record, dans `docs/decisions/`                                                                   |
