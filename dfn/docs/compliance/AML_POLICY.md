# Ébauche de programme de lutte contre le blanchiment d'argent et le financement du terrorisme (LBC/FT)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il s'agit d'une ébauche de programme destinée à être complétée, adaptée à chaque juridiction (Canada, Québec, Sénégal / UEMOA, Guinée) et approuvée par la direction après validation par un conseiller juridique. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. En mode sandbox, aucune opération réelle n'est surveillée et aucune déclaration n'est transmise à une autorité.

| Champ                 | Valeur                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code concerné         | `packages/compliance/src/risk/{types,rules,engine}.ts` ; modèles `RiskAlert`, `RiskAlertAction`, `AuditLog`                                              |
| Principe directeur    | Le score de risque est **consultatif** : il déclenche une revue humaine, jamais un refus définitif, un blocage permanent ni une confiscation automatique |
| Statut                | Ébauche v0.1 — sandbox                                                                                                                                   |
| Portes réglementaires | R3, R6 (`ROADMAP.md` §9)                                                                                                                                 |

---

## 1. Gouvernance

| Rôle                                 | Responsabilités                                                                                                  | Correspondance produit                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Conseil d'administration / direction | Approuve le programme, alloue les ressources, reçoit un rapport trimestriel                                      | —                                                                                                                           |
| Agent de conformité (à nommer)       | Met en œuvre le programme, supervise les files de revue, décide des déclarations, point de contact des autorités | Rôle global `COMPLIANCE` (permissions `admin:verifications`, `admin:disputes`, `admin:risk`, `admin:audit`, `admin:ledger`) |
| Analystes conformité                 | Traitent les alertes, documentent les décisions, préparent les dossiers                                          | `RiskAlertAction` (`START_REVIEW`, `CONFIRM`, `DISMISS`, `CONTEST`) avec note obligatoire (≥ 3 caractères)                  |
| Administrateur plateforme            | Gestion des comptes (suspension motivée), simulation sandbox                                                     | `ADMIN` (`admin:users`, `sandbox:partner_simulate`) ; `updateUserStatusSchema` exige une raison                             |
| Ingénierie                           | Maintient le moteur de règles, les exports, la piste d'audit ; ne modifie une règle que par revue de code        | `riskRules`, tests unitaires                                                                                                |
| Réviseur indépendant                 | Examine l'efficacité du programme (fréquence : au moins tous les deux ans au Canada)                             | Accès lecture `admin:audit`                                                                                                 |

Séparation des tâches : la personne qui confirme une alerte n'est pas celle qui décide d'un litige sur la même transaction lorsque c'est possible ; les notes internes sont distinctes des messages aux parties.

## 2. Approche fondée sur les risques

### 2.1 Facteurs de risque

| Facteur    | Indicateurs                                                                                         | Source produit                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Client     | Nouveau compte, vérification incomplète, PPE, historique de litiges, type d'organisation            | `accountAgeDays`, `identityVerified`, `businessVerified`, `disputesAsPartyTotal`           |
| Produit    | Paiement conditionnel international, portefeuille multi-devises, transfert avec conversion          | Module concerné                                                                            |
| Géographie | Corridor non pris en charge, incohérence pays déclaré / origine, pays à risque (listes à confirmer) | `userCountry`, `originCountry`, `destinationCountry`, `corridorSupported`, `CORRIDORS`     |
| Canal      | En ligne, à distance, via API                                                                       | `ApiCredential` (Phase 5)                                                                  |
| Opération  | Montant vs profil, vélocité, structuration, réutilisation de documents                              | `amountMinor`, `averageAmountMinor`, `transactionsLast24h`, `documentSha256DuplicateCount` |

### 2.2 Matrice de risque par corridor (à compléter avec le conseil)

| Corridor                                    | Statut produit | Risque inhérent (ébauche) | Mesures                                                                     |
| ------------------------------------------- | -------------- | ------------------------- | --------------------------------------------------------------------------- |
| CA → SN                                     | `LAUNCH`       | Moyen                     | `BASIC` obligatoire, `ENHANCED` au-delà des seuils internes                 |
| CA → GN, CA → CI, US → SN, FR → SN, FR → CI | `EXPANSION`    | Moyen à élevé selon pays  | Idem + revue des premiers flux                                              |
| BE → SN, US → GN                            | `RESEARCH`     | Non évalué                | Signal `GEOGRAPHY_MISMATCH` (`corridorSupported = false`) → `MANUAL_REVIEW` |

## 3. Le moteur de règles explicable

### 3.1 Fonctionnement (`engine.ts`)

- Entrée : `RiskFacts` collectés par l'API pour un événement (`transaction.created`, `transaction.funded`, `milestone.approved`, `dispute.opened`, `auth.login_failed`, `document.uploaded`). Chaque champ est optionnel : **une règle ne se déclenche que si elle dispose des faits nécessaires, elle ne devine jamais**.
- Chaque règle retourne un `RiskSignal` ou `null`. Un signal porte `ruleCode`, `severity` (`LOW` / `MEDIUM` / `HIGH`), `score` (0–100) et une `explanation` { `summary`, `factors`, `recommendation` }.
- Sortie : `totalScore` (somme plafonnée à 100), `highestSeverity`, `signals[]`, `recommendation` :
  - `MANUAL_REVIEW` si `totalScore ≥ 40` **ou** si un signal est `HIGH` ;
  - `MONITOR` si `0 < totalScore < 40` ;
  - `NONE` sinon.
- Persistance : une `RiskAlert` par signal (`ruleCode`, `severity`, `score`, `explanation`, `status = OPEN`), rattachée à l'utilisateur, l'organisation et/ou la transaction.
- `listRules()` expose la liste des règles actives pour la documentation et l'audit.

### 3.2 Catalogue des règles (`rules.ts`)

| Code                      | Événements                                  | Condition                                                                                                                  | Sévérité / score                                                      | Justification                                                                                                                 | Recommandation affichée                                                       |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `AMOUNT_VS_PROFILE`       | `transaction.created`, `transaction.funded` | Montant ≥ 5 × la moyenne historique de l'organisation (nécessite `averageAmountMinor > 0`)                                 | `MEDIUM` / 20 si ratio ≥ 5 ; `HIGH` / 40 si ratio ≥ 15                | Une opération disproportionnée par rapport au profil est un indicateur classique de blanchiment ou de compromission de compte | Confirmer la logique commerciale et les justificatifs avant libération        |
| `VELOCITY_24H`            | `transaction.created`                       | ≥ 5 transactions créées en 24 h                                                                                            | `MEDIUM` / 15 ; `HIGH` / 35 si ≥ 10                                   | Détecte la structuration (fractionnement) et les prises de contrôle de compte                                                 | Vérifier structuration ou compromission ; contacter l'organisation            |
| `UNVERIFIED_HIGH_VALUE`   | `transaction.created`, `transaction.funded` | Montant ≥ seuil interne de la devise (15 000 CAD/USD, 12 000 EUR, 7 500 000 XOF, 100 000 000 GNF) et identité non vérifiée | `HIGH` / 45                                                           | Les montants élevés exigent une identité établie avant tout flux de fonds                                                     | Exiger la vérification d'identité avant d'accepter le financement             |
| `REPEATED_LOGIN_FAILURES` | `auth.login_failed`                         | ≥ 5 échecs en 15 min                                                                                                       | `MEDIUM` / 15 ; `HIGH` / 30 si ≥ 10                                   | Tentative de prise de contrôle de compte, prélude possible à une fraude                                                       | Compte temporairement verrouillé ; vérifier la propriété avant déverrouillage |
| `MULTI_DISPUTE_ACCOUNT`   | `dispute.opened`, `transaction.created`     | Partie impliquée dans ≥ 3 litiges                                                                                          | `MEDIUM` / 20 ; `HIGH` / 35 si ≥ 5                                    | Récurrence de litiges : fraude commerciale, abus du mécanisme de contestation ou vendeur défaillant                           | Examiner l'historique des litiges avant toute nouvelle libération             |
| `GEOGRAPHY_MISMATCH`      | `transaction.created`                       | Pays déclaré ≠ pays d'origine de la transaction, ou corridor non pris en charge                                            | `LOW` / 5 (incohérence) ; `MEDIUM` / 15 (corridor non pris en charge) | Incohérence de résidence ou corridor hors analyse de risque                                                                   | Confirmer la résidence de l'acheteur et l'éligibilité du corridor             |
| `DOCUMENT_REUSE`          | `document.uploaded`                         | Même empreinte SHA-256 déjà téléversée sur d'autres transactions                                                           | `MEDIUM` / 15 ; `HIGH` / 30 si ≥ 3 doublons                           | Une preuve réutilisée (connaissement, facture) signale une fausse livraison ou une fraude documentaire                        | Vérifier que la preuve est authentique et propre à cette transaction          |
| `NEW_ACCOUNT_HIGH_VALUE`  | `transaction.created`                       | Compte âgé de ≤ 2 jours et montant ≥ moitié du seuil interne                                                               | `MEDIUM` / 15                                                         | Les comptes très récents engagés sur de gros montants sont surreprésentés dans les fraudes                                    | Surveiller ; demander une vérification avant financement                      |

### 3.3 Règles à ajouter (feuille de route conformité)

| Code proposé                   | Objet                                                                                                   | Justification réglementaire                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AGGREGATE_24H_THRESHOLD`      | Somme des opérations d'une même personne/entité sur 24 h ≥ 10 000 CAD (ou équivalent)                   | Règle des 24 heures (CANAFE) ; préparation des déclarations de télévirements |
| `SANCTIONS_POTENTIAL_MATCH`    | Correspondance potentielle au criblage                                                                  | Gel des avoirs ; revue humaine obligatoire                                   |
| `PEP_INVOLVED`                 | Partie identifiée comme PPE/PPV                                                                         | Vigilance renforcée                                                          |
| `COUNTERPARTY_DISPUTE_HISTORY` | E-mail de contrepartie déjà vu dans des litiges (`counterpartyEmailSeenInDisputes`, fait déjà collecté) | Fraude en réseau                                                             |
| `RAPID_RELEASE_AFTER_FUNDING`  | Libération intégrale demandée quelques minutes après financement sans preuve substantielle              | Transit de fonds                                                             |
| `ROUND_TRIP`                   | Acheteur et vendeur liés (même organisation, mêmes membres)                                             | Auto-transaction, blanchiment                                                |

Toute nouvelle règle est ajoutée avec : code stable, description, événements, justification, tests unitaires, et mention dans ce document.

## 4. Files de revue

| File                 | Contenu                                                                                         | Permission            | SLA cible (sandbox)                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------ |
| Alertes de risque    | `RiskAlert` par statut (`OPEN`, `REVIEWING`, `CONFIRMED`, `DISMISSED`, `CONTESTED`) et sévérité | `admin:risk`          | `HIGH` : 1 jour ouvré ; `MEDIUM` : 3 jours ; `LOW` : 7 jours |
| Vérifications        | `IdentityVerification` / `BusinessVerification` en `PENDING` ou échouées                        | `admin:verifications` | 2 jours ouvrés                                               |
| Documents            | `Document` en `PENDING_REVIEW`                                                                  | `admin:verifications` | 2 jours ouvrés                                               |
| Litiges              | `Dispute` `OPEN` / `UNDER_REVIEW` / `APPEALED`                                                  | `admin:disputes`      | Voir `DISPUTE_HANDLING.md`                                   |
| Transferts (Phase 4) | `Transfer` en `REVIEW_REQUIRED`                                                                 | `admin:risk`          | 1 jour ouvré                                                 |

Cycle de traitement d'une alerte : `OPEN` → `START_REVIEW` (→ `REVIEWING`) → `CONFIRM` (→ `CONFIRMED`) ou `DISMISS` (→ `DISMISSED`) ; la personne concernée peut provoquer `CONTEST` (→ `CONTESTED`) qui rouvre l'analyse. Chaque action exige une note et crée une `RiskAlertAction` horodatée avec son auteur.

## 5. Historique des décisions

| Élément                         | Conservation                 | Détail                                                                                  |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| `RiskAlert` + `RiskAlertAction` | Immuables ; jamais supprimés | Qui, quand, quelle action, quelle note ; `resolvedById`, `resolutionNote`, `resolvedAt` |
| `explanation`                   | Figée à la création          | Faits exacts ayant déclenché le signal, pour relecture et contestation                  |
| `AuditLog`                      | Immuable                     | Toute consultation ou action d'administration                                           |
| Versions des règles             | Historique git + ce document | Permet de reconstituer quelle version d'une règle était active à une date donnée        |

## 6. Mesures possibles à l'issue d'une revue (toujours humaines)

| Mesure                                                   | Conditions                                                       | Mise en œuvre                                                                                                                 | Réversibilité                |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Classer sans suite                                       | Explication légitime documentée                                  | `DISMISS` + note                                                                                                              | —                            |
| Demander des informations ou une vérification `ENHANCED` | Doute raisonnable                                                | Notification à l'utilisateur ; transaction maintenue en `AWAITING_FUNDING`                                                    | Oui                          |
| Suspendre temporairement un compte                       | Soupçon sérieux, risque de fraude en cours                       | `User.status = SUSPENDED` avec raison obligatoire ; réexamen sous 5 jours ouvrés                                              | Oui                          |
| Geler une libération                                     | Litige ou soupçon sur une transaction financée                   | `releaseFrozen = true` ; événement `release.frozen`                                                                           | Oui (`release.unfrozen`)     |
| Geler un compte comptable                                | Décision de gel des avoirs (sanctions) ou injonction             | `LedgerAccount.status = FROZEN` ; les écritures sont refusées (`ACCOUNT_FROZEN`)                                              | Oui, sur décision documentée |
| Mettre fin à la relation                                 | Décision de la direction après revue                             | `DEACTIVATED` ; les fonds détenus par le partenaire sont restitués selon le contrat et la loi — **jamais confisqués par DFN** | Procédure de restitution     |
| Déclarer aux autorités                                   | Motifs raisonnables de soupçon établis par l'agent de conformité | Dossier exporté ; déclaration hors plateforme ; interdiction d'en informer la personne (tipping-off)                          | —                            |

**Interdictions** : aucune de ces mesures n'est déclenchée automatiquement par un score ; aucune mesure n'implique l'appropriation de fonds par DFN ; aucune mesure définitive n'est prise sans possibilité de contestation (sauf obligation légale contraire).

## 7. Déclarations (préparation)

| Déclaration                               | Autorité                                                    | Préparation produit                                                                         |
| ----------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Déclaration d'opérations douteuses        | CANAFE (Canada), CENTIF (Sénégal, Guinée) via le partenaire | Export du dossier complet : transaction, parties, documents, événements, alertes, décisions |
| Déclaration de télévirements ≥ 10 000 CAD | CANAFE                                                      | Agrégation 24 h ; champs donneur d'ordre / bénéficiaire (`CANADA_CANAFE.md`)                |
| Gel des avoirs                            | Autorités compétentes                                       | Journal des gels (`LedgerAccount.status`)                                                   |
| Registre des déclarations                 | Interne                                                     | Table à créer : type, date, référence, auteur, pièces                                       |

Les délais et formats sont précisés dans les documents par juridiction et doivent être confirmés par le conseil.

## 8. Processus de contestation

1. Information : toute mesure affectant un utilisateur (demande d'information, suspension, gel de libération) est notifiée avec le motif, sauf interdiction légale.
2. Contestation : l'utilisateur dispose d'un canal dédié (formulaire / e-mail) ; l'alerte passe en `CONTESTED` (`RiskAlertAction.action = CONTEST`).
3. Réexamen : par un analyste différent de celui qui a confirmé l'alerte lorsque possible ; délai cible 5 jours ouvrés.
4. Décision motivée : notée dans `resolutionNote` ; notification à l'utilisateur.
5. Escalade : agent de conformité, puis médiation externe (`DISPUTE_HANDLING.md` §10) pour les aspects contractuels.
6. Aucune mesure définitive (fin de relation) sans ce cycle, sauf obligation légale.

## 9. Conservation des documents

| Élément                                                    | Durée cible                                                                                                                             | Base                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Dossiers de vérification, alertes, décisions, déclarations | 5 ans après la fin de la relation ou de l'opération (Canada, à confirmer) ; durées UEMOA/Guinée à confirmer (possiblement plus longues) | LRPCFAT ; lois LBC/FT locales |
| Journal d'audit                                            | Identique                                                                                                                               | —                             |
| Programme, formations, examens d'efficacité                | 5 ans                                                                                                                                   | —                             |

Articulation avec les droits des personnes : `DATA_PROTECTION.md` §5.

## 10. Formation

| Public                           | Contenu                                                                                 | Fréquence                  |
| -------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| Tous les employés                | Principes LBC/FT, signaux d'alerte, interdiction de tipping-off, protection des données | À l'embauche puis annuelle |
| Analystes et agent de conformité | Moteur de règles, files, rédaction des notes, déclarations, sanctions, PPE, biais       | Semestrielle               |
| Ingénierie                       | Conception des règles, tests, piste d'audit, minimisation                               | Annuelle                   |
| Direction                        | Responsabilités, rapports, décisions de fin de relation                                 | Annuelle                   |

Les présences et contenus sont archivés 5 ans.

## 11. Revue indépendante

- Fréquence : au moins tous les deux ans (Canada), ou plus tôt après un changement majeur (nouveau corridor, nouveau module, fournisseur KYC).
- Périmètre : politiques, évaluation des risques, efficacité des règles (faux positifs / faux négatifs), qualité des notes, délais, formation, conservation.
- Livrable : rapport à la direction avec plan d'action suivi.
- Indicateurs : alertes par règle et par issue, délai moyen de traitement, taux de contestation et d'annulation, nombre de mesures sans note (cible 0).

## 12. Checklist du programme

- [ ] Nommer l'agent de conformité et formaliser ses pouvoirs.
- [ ] Faire valider cette ébauche par le conseil dans chaque juridiction et par la direction.
- [ ] Compléter la matrice de risque par corridor et par type de client.
- [ ] Implémenter les règles additionnelles (§3.3), avec tests.
- [ ] Créer la table des déclarations et l'export de dossier.
- [ ] Documenter le processus de contestation côté utilisateur (CGU, aide).
- [ ] Mettre en place les SLA des files et leur suivi.
- [ ] Planifier la formation et la revue indépendante.
- [ ] Vérifier à chaque version que le moteur ne déclenche aucune mesure automatique définitive.

## 13. Questions ouvertes pour le conseil

1. Quels sont les délais exacts de déclaration de soupçon et d'interdiction de tipping-off applicables dans chaque juridiction ?
2. Un prestataire technique non assujetti peut-il transmettre un dossier de soupçon directement à l'autorité ou uniquement via le partenaire agréé ?
3. Quelles durées de conservation priment en cas de conflit entre obligations LBC/FT et droits d'effacement ?
4. La suspension temporaire d'un compte pendant une revue est-elle encadrée par des délais légaux de réponse ?
5. Quelles listes de sanctions et de PPE doivent être criblées pour chaque corridor ?
