# Ébauche de programme de lutte contre le blanchiment d'argent et le financement du terrorisme (LBC/FT)

> **Ce document est une liste de préparation et ne constitue pas un avis juridique.** Il s'agit d'une ébauche de programme destinée à être complétée, adaptée à chaque juridiction (Canada, Québec, Sénégal / UEMOA, Guinée) et approuvée par la direction après validation par un conseiller juridique. Aucune obligation n'est réputée satisfaite parce qu'une fonctionnalité existe dans le produit. En mode sandbox, aucune opération réelle n'est surveillée et aucune déclaration n'est transmise à une autorité.

| Champ                 | Valeur                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code concerné         | `packages/compliance/src/risk/{types,rules,engine,structuring}.ts` ; `apps/api/src/modules/risk/*` (file de revue, SLA, structuration) ; modèles `RiskAlert`, `RiskAlertAction`, `AuditLog` |
| Principe directeur    | Le score de risque est **consultatif** : il déclenche une revue humaine, jamais un refus définitif, un blocage permanent ni une confiscation automatique                                    |
| Statut                | Ébauche v0.2 — sandbox (Phase 6 : détection de la structuration, SLA et assignation des files — **à valider par le conseil juridique / responsable conformité**)                            |
| Portes réglementaires | R3, R6 (`ROADMAP.md` §9)                                                                                                                                                                    |

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

- Entrée : `RiskFacts` collectés par l'API pour un événement (`transaction.created`, `transaction.funded`, `milestone.approved`, `dispute.opened`, `auth.login_failed`, `document.uploaded`, `transfer.created`, `transfer.authorized`, `beneficiary.changed`, `wallet.self_deposit`, `invoice.wallet_payment`). Chaque champ est optionnel : **une règle ne se déclenche que si elle dispose des faits nécessaires, elle ne devine jamais**.
- Chaque règle retourne un `RiskSignal` ou `null`. Un signal porte `ruleCode`, `severity` (`LOW` / `MEDIUM` / `HIGH`), `score` (0–100) et une `explanation` { `summary`, `factors`, `recommendation` }.
- Sortie : `totalScore` (somme plafonnée à 100), `highestSeverity`, `signals[]`, `recommendation` :
  - `MANUAL_REVIEW` si `totalScore ≥ 40` **ou** si un signal est `HIGH` ;
  - `MONITOR` si `0 < totalScore < 40` ;
  - `NONE` sinon.
- Persistance : une `RiskAlert` par signal (`ruleCode`, `severity`, `score`, `explanation`, `status = OPEN`), rattachée à l'utilisateur, l'organisation et/ou la transaction, avec son **échéance de revue** `dueAt = createdAt + SLA(sévérité)` (§4). Exception : `STRUCTURING` est dédupliquée (une alerte ouverte par sujet et par fenêtre, §3.4).
- `listRules()` expose la liste des règles actives pour la documentation et l'audit.

### 3.2 Catalogue des règles (`rules.ts`)

| Code                      | Événements                                                                                   | Condition                                                                                                                                                                                                   | Sévérité / score                                                      | Justification                                                                                                                 | Recommandation affichée                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `AMOUNT_VS_PROFILE`       | `transaction.created`, `transaction.funded`                                                  | Montant ≥ 5 × la moyenne historique de l'organisation (nécessite `averageAmountMinor > 0`)                                                                                                                  | `MEDIUM` / 20 si ratio ≥ 5 ; `HIGH` / 40 si ratio ≥ 15                | Une opération disproportionnée par rapport au profil est un indicateur classique de blanchiment ou de compromission de compte | Confirmer la logique commerciale et les justificatifs avant libération                                 |
| `VELOCITY_24H`            | `transaction.created`                                                                        | ≥ 5 transactions créées en 24 h                                                                                                                                                                             | `MEDIUM` / 15 ; `HIGH` / 35 si ≥ 10                                   | Détecte la structuration (fractionnement) et les prises de contrôle de compte                                                 | Vérifier structuration ou compromission ; contacter l'organisation                                     |
| `UNVERIFIED_HIGH_VALUE`   | `transaction.created`, `transaction.funded`                                                  | Montant ≥ seuil interne de la devise (15 000 CAD/USD, 12 000 EUR, 7 500 000 XOF, 100 000 000 GNF) et identité non vérifiée                                                                                  | `HIGH` / 45                                                           | Les montants élevés exigent une identité établie avant tout flux de fonds                                                     | Exiger la vérification d'identité avant d'accepter le financement                                      |
| `REPEATED_LOGIN_FAILURES` | `auth.login_failed`                                                                          | ≥ 5 échecs en 15 min                                                                                                                                                                                        | `MEDIUM` / 15 ; `HIGH` / 30 si ≥ 10                                   | Tentative de prise de contrôle de compte, prélude possible à une fraude                                                       | Compte temporairement verrouillé ; vérifier la propriété avant déverrouillage                          |
| `MULTI_DISPUTE_ACCOUNT`   | `dispute.opened`, `transaction.created`                                                      | Partie impliquée dans ≥ 3 litiges                                                                                                                                                                           | `MEDIUM` / 20 ; `HIGH` / 35 si ≥ 5                                    | Récurrence de litiges : fraude commerciale, abus du mécanisme de contestation ou vendeur défaillant                           | Examiner l'historique des litiges avant toute nouvelle libération                                      |
| `GEOGRAPHY_MISMATCH`      | `transaction.created`                                                                        | Pays déclaré ≠ pays d'origine de la transaction, ou corridor non pris en charge                                                                                                                             | `LOW` / 5 (incohérence) ; `MEDIUM` / 15 (corridor non pris en charge) | Incohérence de résidence ou corridor hors analyse de risque                                                                   | Confirmer la résidence de l'acheteur et l'éligibilité du corridor                                      |
| `DOCUMENT_REUSE`          | `document.uploaded`                                                                          | Même empreinte SHA-256 déjà téléversée sur d'autres transactions                                                                                                                                            | `MEDIUM` / 15 ; `HIGH` / 30 si ≥ 3 doublons                           | Une preuve réutilisée (connaissement, facture) signale une fausse livraison ou une fraude documentaire                        | Vérifier que la preuve est authentique et propre à cette transaction                                   |
| `NEW_ACCOUNT_HIGH_VALUE`  | `transaction.created`                                                                        | Compte âgé de ≤ 2 jours et montant ≥ moitié du seuil interne                                                                                                                                                | `MEDIUM` / 15                                                         | Les comptes très récents engagés sur de gros montants sont surreprésentés dans les fraudes                                    | Surveiller ; demander une vérification avant financement                                               |
| `STRUCTURING`             | `transaction.funded`, `transfer.authorized`, `wallet.self_deposit`, `invoice.wallet_payment` | Sur `STRUCTURING_WINDOW_HOURS` (24 h), ≥ 2 opérations d'un même sujet (organisation ou utilisateur), même devise et même sens, **chacune sous** `STRUCTURING_THRESHOLD`, dont la **somme atteint** ce seuil | `MEDIUM` / 25 si 2 opérations ; `HIGH` / 45 dès 3                     | Fractionnement (« schtroumpfage ») pour rester sous un seuil de déclaration ou de vigilance                                   | Examiner les opérations ensemble ; ne pas informer le client ; escalader si soupçon raisonnable (§3.4) |

### 3.3 Règles à ajouter (feuille de route conformité)

| Code proposé                   | Objet                                                                                                                                                                                                                        | Justification réglementaire                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `AGGREGATE_24H_THRESHOLD`      | Somme des opérations d'une même personne/entité sur 24 h ≥ 10 000 CAD (ou équivalent), **y compris** une opération unique au-dessus du seuil — complément de `STRUCTURING` (qui ne retient que les opérations sous le seuil) | Règle des 24 heures (CANAFE) ; préparation des déclarations de télévirements |
| `SANCTIONS_POTENTIAL_MATCH`    | Correspondance potentielle au criblage                                                                                                                                                                                       | Gel des avoirs ; revue humaine obligatoire                                   |
| `PEP_INVOLVED`                 | Partie identifiée comme PPE/PPV                                                                                                                                                                                              | Vigilance renforcée                                                          |
| `COUNTERPARTY_DISPUTE_HISTORY` | E-mail de contrepartie déjà vu dans des litiges (`counterpartyEmailSeenInDisputes`, fait déjà collecté)                                                                                                                      | Fraude en réseau                                                             |
| `RAPID_RELEASE_AFTER_FUNDING`  | Libération intégrale demandée quelques minutes après financement sans preuve substantielle                                                                                                                                   | Transit de fonds                                                             |
| `ROUND_TRIP`                   | Acheteur et vendeur liés (même organisation, mêmes membres)                                                                                                                                                                  | Auto-transaction, blanchiment                                                |

Toute nouvelle règle est ajoutée avec : code stable, description, événements, justification, tests unitaires, et mention dans ce document.

### 3.4 Détection de la structuration (`STRUCTURING`)

> **À valider par le conseil juridique / responsable conformité.** Les seuils, la fenêtre, le périmètre des opérations agrégées et la conduite à tenir ci-dessous sont des hypothèses de travail du bac à sable ; ils ne constituent ni une interprétation de la règle des 24 heures de CANAFE ni une obligation réputée satisfaite.

| Paramètre         | Valeur sandbox                                                                                                             | Configuration                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Fenêtre glissante | 24 h                                                                                                                       | `STRUCTURING_WINDOW_HOURS` (1–168)                                   |
| Seuil agrégé      | `10000.00`, **nominal par devise** : 10 000,00 CAD/USD/EUR, 10 000 XOF, 10 000 GNF                                         | `STRUCTURING_THRESHOLD` (décimal, réécrit à l'exposant de la devise) |
| Sujets            | L'organisation **et** l'utilisateur à l'origine de l'opération ; le sujet retenu est celui qui cumule le plus d'opérations | —                                                                    |
| Sens des flux     | Entrées (`SELF_DEPOSIT`, `PROTECT_FUNDING`) et sorties (`TRANSFER`, `INVOICE_PAYMENT`) ne sont **jamais** additionnées     | —                                                                    |

**Opérations agrégées** (même devise, dans la fenêtre) :

| Type              | Source                                                                                                                                               | Sens   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `SELF_DEPOSIT`    | Écritures `DEPOSIT` `POSTED` étiquetées `metadata.selfService = true` par le dépôt sandbox (`reference` = organisation, `metadata.by` = utilisateur) | Entrée |
| `PROTECT_FUNDING` | Demandes de financement Protect `CONFIRMED` (acheteur = organisation, créateur de la transaction = utilisateur)                                      | Entrée |
| `TRANSFER`        | Transferts autorisés dans la fenêtre, et tentatives d'autorisation mises en revue (`REVIEW_REQUIRED`)                                                | Sortie |
| `INVOICE_PAYMENT` | Paiements de factures depuis le portefeuille (écritures `ADJUSTMENT` étiquetées `metadata.purpose = INVOICE_PAYMENT`)                                | Sortie |

**Condition** : au moins deux opérations **chacune strictement inférieure** au seuil, dont la somme est **supérieure ou égale** au seuil. L'opération qui déclenche l'évaluation doit elle-même faire partie de ces opérations : une opération unique au-dessus du seuil relève des règles de montant élevé, pas de la structuration. Sévérité `MEDIUM` (score 25, `MONITOR`) pour deux opérations, `HIGH` (score 45, `MANUAL_REVIEW`) à partir de trois.

**Explication** : nombre d'opérations, somme, seuil, fenêtre, sujet, sens, types d'opérations, références (20 dernières) et détail des opérations (`explanation.evidence`, 50 au plus, montants en chaînes). La clé `factors.dedupKey` identifie le motif.

**Déduplication** : une seule alerte `STRUCTURING` ouverte (`OPEN`, `REVIEWING`, `CONTESTED`) par sujet, devise et sens dans la fenêtre (verrou consultatif PostgreSQL contre les créations concurrentes). Les détections suivantes sont **ajoutées** à `explanation.updates` (horodatées, 20 au plus) sans modifier les faits d'origine ; si la sévérité augmente (`MEDIUM` → `HIGH`), l'alerte est escaladée (sévérité, score, échéance raccourcie) et l'événement est journalisé (`risk.alert_escalated`). Une fois l'alerte décidée, un nouveau motif ouvre une nouvelle alerte.

**Effets** : comme toute règle, le signal est **consultatif**. Sur `transfer.authorized`, un signal `HIGH` place le transfert en `REVIEW_REQUIRED` (aucun débit tant qu'un analyste n'a pas statué) ; sur les autres événements, seule une alerte est ouverte. Aucune déclaration n'est transmise automatiquement.

**Confidentialité (tipping-off)** : la personne concernée n'est **pas** notifiée des décisions sur une alerte `STRUCTURING` (ni `SANCTIONS_POTENTIAL_MATCH`), afin de ne pas l'informer d'une éventuelle déclaration d'opération douteuse.

**Limites connues** (à arbitrer avec le conseil) : seuil nominal identique pour toutes les devises (10 000 XOF ≈ 15 EUR est très bas, 10 000 GNF encore plus) — un seuil par devise ou par équivalent CAD est recommandé avant toute exploitation réelle ; pas de lien entre sujets distincts (réseaux de mules) ; les dépôts sandbox et les paiements de factures ne déclenchent l'évaluation qu'une fois l'appel au moteur ajouté dans leurs services (voir `docs/architecture/REVIEW_QUEUES.md`).

## 4. Files de revue

| File                 | Contenu                                                                                         | Permission            | SLA cible (sandbox)                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Alertes de risque    | `RiskAlert` par statut (`OPEN`, `REVIEWING`, `CONFIRMED`, `DISMISSED`, `CONTESTED`) et sévérité | `admin:risk`          | `HIGH` : 24 h ; `MEDIUM` : 72 h ; `LOW` : 168 h (heures calendaires, `REVIEW_SLA_HOURS_*`) |
| Vérifications        | `IdentityVerification` / `BusinessVerification` en `PENDING` ou échouées                        | `admin:verifications` | 2 jours ouvrés                                                                             |
| Documents            | `Document` en `PENDING_REVIEW`                                                                  | `admin:verifications` | 2 jours ouvrés                                                                             |
| Litiges              | `Dispute` `OPEN` / `UNDER_REVIEW` / `APPEALED`                                                  | `admin:disputes`      | Voir `DISPUTE_HANDLING.md`                                                                 |
| Transferts (Phase 4) | `Transfer` en `REVIEW_REQUIRED`                                                                 | `admin:risk`          | 1 jour ouvré                                                                               |

Cycle de traitement d'une alerte : `OPEN` → `START_REVIEW` (→ `REVIEWING`) → `CONFIRM` (→ `CONFIRMED`) ou `DISMISS` (→ `DISMISSED`) ; la personne concernée peut provoquer `CONTEST` (→ `CONTESTED`) qui rouvre l'analyse. Chaque action exige une note et crée une `RiskAlertAction` horodatée avec son auteur. Les transitions sont contrôlées par une machine à états (`OPEN → REVIEWING | CONFIRMED | DISMISSED`, `REVIEWING → CONFIRMED | DISMISSED`, `CONFIRMED | DISMISSED → CONTESTED`, `CONTESTED → REVIEWING | CONFIRMED | DISMISSED`) ; toute autre transition est refusée (`INVALID_TRANSITION`).

### 4.1 SLA, assignation et suivi de la file des alertes (Phase 6)

> **À valider par le conseil juridique / responsable conformité** : les délais ci-dessous sont des cibles internes du bac à sable, pas des délais légaux.

| Élément                       | Règle                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Échéance (`dueAt`)            | Fixée à la création : `createdAt + REVIEW_SLA_HOURS_<SÉVÉRITÉ>` (défauts 24 / 72 / 168 h). Escalade d'une alerte `STRUCTURING` : échéance recalculée sur la nouvelle sévérité si elle est plus proche. `CONTEST` ouvre un nouveau cycle : `dueAt = maintenant + SLA`.                                                                                                                                     |
| Première action               | `firstActionAt` = date de la première action d'analyste (`START_REVIEW`, `CONFIRM`, `DISMISS`, `CONTEST`) ; l'assignation n'en est pas une.                                                                                                                                                                                                                                                               |
| Retard                        | Alerte ouverte (`OPEN`, `REVIEWING`, `CONTESTED`) dont l'échéance est passée ; affichée « en retard » dans la file.                                                                                                                                                                                                                                                                                       |
| Dépassement (`slaBreachedAt`) | Marqué par la tâche planifiée `REVIEW_SLA`, **une seule fois par dépassement** ; notification à la personne assignée, ou à tous les membres actifs `COMPLIANCE` / `ADMIN` si l'alerte n'est pas assignée (ou si l'assigné n'est plus actif). Journalisé (`risk.review_sla_breached`).                                                                                                                     |
| Assignation                   | `POST /v1/admin/risk-alerts/:id/assign` (`admin:risk`) : uniquement à un utilisateur **actif** `COMPLIANCE` ou `ADMIN` (sinon `ALERT_NOT_ASSIGNABLE`) ; impossible sur une alerte décidée ; « m'assigner » ; désassignation. Journalisée (`admin.risk_alert_assigned` / `unassigned`) et notifiée à l'assigné (sauf auto-assignation). `START_REVIEW` sur une alerte non assignée l'assigne à l'analyste. |
| Décisions                     | `CONFIRM` / `DISMISS` exigent une note (≥ 3 caractères) et enregistrent l'auteur (`resolvedById`, `RiskAlertAction.actorUserId`) et la date.                                                                                                                                                                                                                                                              |
| Export                        | `GET /v1/admin/risk-alerts.csv` : la file filtrée, cellules protégées contre l'injection de formules, ligne d'avertissement sandbox ; chaque export est journalisé (`admin.risk_alerts_exported`).                                                                                                                                                                                                        |
| Indicateurs                   | `GET /v1/admin/risk-alerts/stats` : alertes par statut et par sévérité, en retard, non assignées, SLA dépassés, **délai médian de première action** (30 derniers jours) — indicateurs de la revue indépendante (§11).                                                                                                                                                                                     |

Architecture et API : `docs/architecture/REVIEW_QUEUES.md`.

## 5. Historique des décisions

| Élément                         | Conservation                 | Détail                                                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RiskAlert` + `RiskAlertAction` | Immuables ; jamais supprimés | Qui, quand, quelle action, quelle note ; `resolvedById`, `resolutionNote`, `resolvedAt`                                                                                                                                                                        |
| `explanation`                   | Figée à la création          | Faits exacts ayant déclenché le signal, pour relecture et contestation. Seule exception : les détections répétées d'une alerte `STRUCTURING` ouverte sont **ajoutées** dans `explanation.updates` (append-only, horodatées), sans modifier les faits d'origine |
| `AuditLog`                      | Immuable                     | Toute consultation ou action d'administration                                                                                                                                                                                                                  |
| Versions des règles             | Historique git + ce document | Permet de reconstituer quelle version d'une règle était active à une date donnée                                                                                                                                                                               |

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

1. Information : toute mesure affectant un utilisateur (demande d'information, suspension, gel de libération) est notifiée avec le motif, sauf interdiction légale. Les décisions sur les alertes `STRUCTURING` et `SANCTIONS_POTENTIAL_MATCH` ne sont jamais notifiées à la personne concernée (interdiction de tipping-off, à confirmer par juridiction).
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
- [x] Mettre en place les SLA des files et leur suivi (alertes de risque : échéance, retard, notification de dépassement, délai médian — Phase 6, sandbox).
- [ ] Faire valider la règle `STRUCTURING` (seuil par devise, fenêtre, sens des flux) et les délais SLA par le conseil juridique / responsable conformité.
- [ ] Brancher l'évaluation du risque sur les dépôts sandbox et les paiements de factures depuis le portefeuille (`REVIEW_QUEUES.md` §7).
- [ ] Planifier la formation et la revue indépendante.
- [ ] Vérifier à chaque version que le moteur ne déclenche aucune mesure automatique définitive.

## 13. Questions ouvertes pour le conseil

1. Quels sont les délais exacts de déclaration de soupçon et d'interdiction de tipping-off applicables dans chaque juridiction ?
2. Un prestataire technique non assujetti peut-il transmettre un dossier de soupçon directement à l'autorité ou uniquement via le partenaire agréé ?
3. Quelles durées de conservation priment en cas de conflit entre obligations LBC/FT et droits d'effacement ?
4. La suspension temporaire d'un compte pendant une revue est-elle encadrée par des délais légaux de réponse ?
5. Quelles listes de sanctions et de PPE doivent être criblées pour chaque corridor ?
6. Structuration : quel seuil retenir par devise (ou en équivalent CAD), quelle fenêtre (24 h glissantes ou jour calendaire), et faut-il agréger entrées et sorties, ou plusieurs sujets liés (mêmes bénéficiaires, mêmes appareils) ?
7. Les SLA de revue doivent-ils être exprimés en jours ouvrés plutôt qu'en heures calendaires, et quel délai maximal entre la détection et la décision de déclarer est acceptable ?
