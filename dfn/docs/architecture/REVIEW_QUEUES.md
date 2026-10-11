# Files de revue conformité (alertes de risque) — architecture

> **Sandbox uniquement.** Les alertes, montants et opérations sont fictifs ; aucune déclaration n'est transmise à une autorité. Les seuils et délais décrits ici sont des hypothèses de travail **à valider par le conseil juridique / responsable conformité** (`docs/compliance/AML_POLICY.md` §3.4 et §4.1).

| Élément             | Emplacement                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Règles pures        | `packages/compliance/src/risk/{types,rules,engine,structuring}.ts`                                                                                                                                                |
| Schémas de requêtes | `packages/shared/src/schemas/reviews.ts`, `listRiskAlertsQuerySchema` dans `packages/shared/src/schemas/admin.ts`                                                                                                 |
| API                 | `apps/api/src/modules/risk/` (`RiskService`, `StructuringFactsService`, `ReviewQueueService`, `ReviewSlaService`, `review-sla.ts`) ; routes dans `apps/api/src/modules/admin/admin.controller.ts`                 |
| Web                 | `apps/web/src/app/(app)/admin/risk/page.tsx`, `apps/web/src/components/admin/review-queue-*.tsx`, `RiskAlertActions` (`admin-actions.tsx`), dictionnaire `reviewQueue` (`apps/web/src/lib/i18n-parts/reviews.ts`) |
| Tests               | `apps/api/test/reviews.test.ts`, `packages/compliance/test/risk-engine.test.ts`                                                                                                                                   |

## 1. Principes

1. **Consultatif** : une alerte déclenche une revue humaine, jamais une décision automatique définitive. Seul effet automatique existant : un signal `HIGH` sur `transfer.authorized` met le transfert en `REVIEW_REQUIRED` (aucun débit tant qu'un analyste n'a pas statué).
2. **Explicable** : chaque alerte conserve les faits qui l'ont déclenchée (`explanation.summary`, `factors`, `recommendation`, et `evidence` pour la structuration).
3. **Traçable** : toute action d'analyste crée une `RiskAlertAction` (auteur, note, date) et une entrée `AuditLog`.
4. **Transverse** : la file est une fonction de conformité inter-locataires réservée au personnel (`Permission.ADMIN_RISK` : rôles globaux `COMPLIANCE` et `ADMIN`). Aucun utilisateur `USER` n'y accède (403).

## 2. Données (`RiskAlert`)

| Champ                                          | Rôle                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `status`                                       | `OPEN`, `REVIEWING`, `CONTESTED` (ouvertes) ; `CONFIRMED`, `DISMISSED` (décidées)                 |
| `severity`, `score`                            | Issus du moteur ; une alerte `STRUCTURING` peut être escaladée (jamais rétrogradée)               |
| `dueAt`                                        | Échéance de revue, fixée à la création (§4)                                                       |
| `assignedToUserId`, `assignedAt`               | Analyste assigné                                                                                  |
| `firstActionAt`                                | Première action d'analyste (`START_REVIEW`, `CONFIRM`, `DISMISS`, `CONTEST`)                      |
| `slaBreachedAt`                                | Marqueur de dépassement posé par la tâche `REVIEW_SLA` (une notification par dépassement)         |
| `resolvedById`, `resolutionNote`, `resolvedAt` | Dernière décision (`CONFIRM` / `DISMISS`)                                                         |
| `explanation`                                  | Faits figés ; `explanation.updates[]` (append-only) pour les détections répétées de structuration |

Index utilisés : `(status, dueAt)` (file triée par échéance, tâche SLA), `(assignedToUserId, status)` (filtre « moi »), `(status, severity)`.

## 3. Cycle de vie

```
OPEN ──START_REVIEW──▶ REVIEWING ──CONFIRM──▶ CONFIRMED ──CONTEST──▶ CONTESTED
  │                        └─────DISMISS──▶ DISMISSED ──CONTEST──┘        │
  ├──CONFIRM / DISMISS (décision directe)                                  │
  └────────────────────────────────────── START_REVIEW / CONFIRM / DISMISS ┘
```

- Machine à états `riskAlertMachine` (`review-sla.ts`) ; une transition invalide renvoie `409 INVALID_TRANSITION`. Les mises à jour sont conditionnées au statut lu (`updateMany … where status = <lu>`) : deux décisions concurrentes ne peuvent pas aboutir toutes les deux.
- Toute action exige une note de 3 caractères minimum (`riskAlertActionSchema`).
- `START_REVIEW` sur une alerte non assignée l'assigne à l'analyste.
- `CONTEST` rouvre l'alerte avec un **nouveau cycle SLA** (`dueAt = maintenant + SLA`, `slaBreachedAt = null`) ; la décision contestée reste visible dans `resolvedBy*` et l'historique.
- `nextActions` (DTO) : actions permises par la machine à états, plus `ASSIGN`, `ASSIGN_TO_ME` et `UNASSIGN` pour les alertes ouvertes. L'interface n'affiche que ces actions.
- Notification de la personne concernée après `CONFIRM`, `DISMISS` ou `CONTEST`, **sauf** pour `STRUCTURING` et `SANCTIONS_POTENTIAL_MATCH` (interdiction de tipping-off).

## 4. SLA

| Sévérité | Défaut | Variable                  |
| -------- | ------ | ------------------------- |
| `HIGH`   | 24 h   | `REVIEW_SLA_HOURS_HIGH`   |
| `MEDIUM` | 72 h   | `REVIEW_SLA_HOURS_MEDIUM` |
| `LOW`    | 168 h  | `REVIEW_SLA_HOURS_LOW`    |

- **Création** : `RiskService.evaluateAndRecord` écrit `createdAt` et `dueAt = createdAt + SLA(sévérité)`. `RiskService.slaDueAt(severity, createdAt)` est exposé pour les autres modules qui créent des alertes.
- **Lignes sans échéance** (créées par un chemin antérieur) : l'API calcule une échéance effective `createdAt + SLA` pour l'affichage, les filtres et les statistiques, et la tâche `REVIEW_SLA` la persiste.
- **Retard** : alerte ouverte dont l'échéance (effective) est passée — `overdue` dans le DTO, filtre `overdue=true`, compteur `overdue` des statistiques.
- **Tâche `REVIEW_SLA`** (enregistrée par `ReviewSlaService` sur le `JobRegistry`, exécutée par le planificateur et le bouton « Exécuter » de `/admin/jobs`) :
  1. complète `dueAt` des alertes ouvertes qui n'en ont pas ;
  2. pour chaque alerte ouverte en retard sans `slaBreachedAt` : pose le marqueur par une mise à jour conditionnelle (`slaBreachedAt IS NULL` — idempotent, sûr en exécutions concurrentes), notifie l'assigné s'il est encore `ACTIVE` et `COMPLIANCE`/`ADMIN`, sinon tous les membres actifs `COMPLIANCE`/`ADMIN`, et journalise `risk.review_sla_breached`.
  - Bornée : 10 lots de 200 alertes par étape et par exécution (`truncated: true` si reste à traiter) ; respecte `signal.aborted` si le moteur de tâches le fournit.
  - Résumé : `{ dueAtBackfilled, breached, notifications, notifiedAssignee, notifiedStaff, slaHours, truncated, aborted }`. Une seconde exécution immédiate renvoie `breached: 0`.

## 5. API (personnel, `Permission.ADMIN_RISK`)

| Méthode et route                         | Description                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /v1/admin/risk-alerts`              | File filtrée et paginée                                                                          |
| `GET /v1/admin/risk-alerts.csv`          | Export CSV de la file filtrée (mêmes filtres, sans pagination, 5 000 lignes au plus), journalisé |
| `GET /v1/admin/risk-alerts/stats`        | Statistiques de la file                                                                          |
| `GET /v1/admin/risk-alerts/assignees`    | Personnel assignable (utilisateurs `ACTIVE` `COMPLIANCE` / `ADMIN`)                              |
| `GET /v1/admin/risk-alerts/:id`          | Une alerte (DTO de file)                                                                         |
| `POST /v1/admin/risk-alerts/:id/assign`  | `{ "assigneeUserId": "<uuid>" \| "me" \| null }` → 200 + DTO                                     |
| `POST /v1/admin/risk-alerts/:id/actions` | `{ "action": "START_REVIEW" \| "CONFIRM" \| "DISMISS" \| "CONTEST", "note": "…" }` → 201 + DTO   |

### 5.1 Filtres (`listRiskAlertsQuerySchema`)

| Paramètre          | Valeurs                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | Liste (`status=OPEN,REVIEWING`, `status=OPEN&status=REVIEWING` ou `status[]=OPEN`)                                                             |
| `severity`         | Liste `HIGH`, `MEDIUM`, `LOW` (mêmes formes)                                                                                                   |
| `ruleCode`         | Code de règle (`[A-Z0-9_]`)                                                                                                                    |
| `assignee`         | `me`, `unassigned` ou l'identifiant d'un membre du personnel                                                                                   |
| `overdue`          | `true` : alertes ouvertes en retard ; `false` : les autres                                                                                     |
| `organizationId`   | Organisation rattachée à l'alerte                                                                                                              |
| `from`, `to`       | Date de création : `YYYY-MM-DD` (journée UTC incluse) ou horodatage ISO 8601                                                                   |
| `sort`             | `dueAt` (défaut si seuls des statuts ouverts sont demandés, ou `overdue=true`), `-dueAt`, `createdAt`, `-createdAt` (défaut sinon), `severity` |
| `page`, `pageSize` | Pagination par page ; `pageSize` ≤ 100 (défaut 50)                                                                                             |

Réponse : `{ items, total, page, pageSize, sort, generatedAt, slaHours, rules }`. Chaque élément expose notamment `dueAt` (effective), `overdue`, `slaRemainingMinutes` (négatif en retard, `null` si décidée), `slaBreachedAt`, `firstActionAt`, `ageMinutes`, `ageHours`, `assignedTo { id, name, email }`, `assignedAt`, `user`, `organization`, `transaction`, `resolvedBy`, `actions[]` et `nextActions`. Les durées sont calculées par l'API pour que l'affichage web reste déterministe.

### 5.2 Erreurs

| Cas                                                               | Statut | Code                              |
| ----------------------------------------------------------------- | ------ | --------------------------------- |
| Utilisateur sans `admin:risk`                                     | 403    | `FORBIDDEN`                       |
| Alerte inconnue                                                   | 404    | `NOT_FOUND`                       |
| Filtre ou corps invalide (note < 3 caractères, `pageSize` > 100…) | 400    | `VALIDATION_FAILED`               |
| Assigné inexistant, inactif ou non `COMPLIANCE`/`ADMIN`           | 422    | `ALERT_NOT_ASSIGNABLE`            |
| Assignation d'une alerte décidée                                  | 409    | `ALERT_NOT_ASSIGNABLE`            |
| Transition invalide ou alerte modifiée entre-temps                | 409    | `INVALID_TRANSITION` / `CONFLICT` |

### 5.3 Export CSV

Première ligne : `# Diaspora Trust — SANDBOX compliance review queue (risk alerts). Données fictives — Aucun fonds réel`, puis l'en-tête `id,created_at,rule_code,severity,score,status,due_at,overdue,sla_breached_at,first_action_at,assigned_to,assigned_to_email,user_email,organization,transaction_reference,summary,resolved_by,resolution_note,resolved_at,age_hours`. Les cellules sont produites par une copie locale de `csvCell` (`review-sla.ts`) : toute valeur commençant par `=`, `+`, `-`, `@`, tabulation ou retour chariot (hors nombre signé) est préfixée d'une apostrophe et citée. Au-delà de 5 000 lignes, une ligne `# truncated: …` invite à affiner les filtres. Chaque export crée `admin.risk_alerts_exported` (filtres, nombre de lignes).

### 5.4 Statistiques

`{ byStatus, openBySeverity, open, overdue, unassigned, assignedToMe, slaBreached, medianTimeToFirstAction: { windowDays: 30, sampleSize, minutes }, slaHours }`. La médiane (`percentile_cont(0.5)` de `firstActionAt − createdAt`) porte sur les alertes créées dans les 30 derniers jours et ayant reçu une première action.

## 6. Détection de la structuration

```
service métier ──evaluateAndRecord(facts)──▶ RiskService
                                              │ 1. StructuringFactsService.collect(facts)   (lecture BD, bornée)
                                              │ 2. RiskEngine.evaluate(facts + structuring) (pur, packages/compliance)
                                              │ 3. alertes : STRUCTURING → dédup / escalade ; autres → création + dueAt
```

1. **Collecte** (`StructuringFactsService`) pour les événements `transaction.funded`, `transfer.authorized`, `wallet.self_deposit`, `invoice.wallet_payment` : opérations de l'organisation et de l'utilisateur, même devise, même sens (entrées : dépôts sandbox + financements Protect ; sorties : transferts + paiements de factures depuis le portefeuille), sur `STRUCTURING_WINDOW_HOURS`, 200 opérations au plus par type et par sujet. L'opération courante est repérée par `transactionId` (financement) ou `operationReference` (identifiant d'écriture, référence) ; si elle n'est pas encore persistée (transfert évalué avant autorisation), elle est ajoutée à partir des faits. Une erreur de collecte est journalisée et n'interrompt jamais l'opération métier.
2. **Règle pure** (`structuringSignal`) : seuil `STRUCTURING_THRESHOLD` réécrit à l'exposant de la devise (`structuringThresholdMinor`) ; opérations strictement sous le seuil ; au moins deux, somme ≥ seuil, opération courante incluse ; `MEDIUM` (2) ou `HIGH` (≥ 3) ; sujet retenu = le plus d'opérations, puis la plus grande somme, puis l'organisation.
3. **Persistance** : clé `STRUCTURING:<sens>:<ORGANIZATION|USER>:<id>:<devise>` ; verrou `pg_advisory_xact_lock(hashtext(clé))` ; si une alerte ouverte de même clé existe dans la fenêtre, la détection est ajoutée à `explanation.updates` et l'alerte est éventuellement escaladée (sévérité, score, échéance) — sinon création (`risk.structuring_detected`).

## 7. Intégration — appels restant à ajouter (hors périmètre de ce chantier)

| Service (propriétaire)                                                                                            | Appel                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WalletsService.selfDeposit` (`apps/api/src/modules/ledger/wallets.service.ts`)                                   | Après la notification `wallet.self_deposit` : `await this.risk.evaluateAndRecord({ event: 'wallet.self_deposit', userId: auth.userId, organizationId, amountMinor, currencyCode, operationReference: result.posted.id });` (injecter `RiskService`, module global)                                            |
| `InvoicesService.recordPayment`, branche `WALLET_SIMULATED` (`apps/api/src/modules/business/invoices.service.ts`) | Après `afterPayment(...)` : `await this.risk.evaluateAndRecord({ event: 'invoice.wallet_payment', userId: auth.userId, organizationId: payerOrgId, amountMinor, currencyCode: ccy, operationReference: paymentId });` (l'identifiant du paiement ou celui de l'écriture `ADJUSTMENT` sont tous deux reconnus) |
| `TransfersService.authorize` (`apps/api/src/modules/transfers/transfers.service.ts`)                              | Ajouter `operationReference: transfer.reference` aux faits de `transfer.authorized` pour que l'explication cite la référence du transfert courant (sinon `current-operation`)                                                                                                                                 |
| `VerificationsService` (création directe de `SANCTIONS_POTENTIAL_MATCH`)                                          | Renseigner `dueAt: this.risk.slaDueAt('HIGH')` (sinon la tâche `REVIEW_SLA` la complète au passage suivant)                                                                                                                                                                                                   |

Le test `apps/api/test/reviews.test.ts` reproduit les deux premiers appels pour vérifier la lecture des écritures étiquetées.

## 8. Interface web (`/admin/risk`)

- Page serveur : filtres portés par l'URL (`view=open|closed|all`, `severity`, `ruleCode`, `assignee`, `overdue`, `from`, `to`, `sort`, `page`), validés par `parseReviewQueueParams` avant tout appel à l'API ; vue par défaut « À traiter » (statuts ouverts, tri par échéance).
- En-tête : statistiques (ouvertes, en retard, non assignées, assignées à moi, délai médian de première action, rappel des SLA), lien d'export CSV de la vue filtrée, badge sandbox.
- Carte par alerte : sévérité, règle, statut, badge SLA (« Échéance dans … » / « En retard de … », « SLA dépassé »), explication et opérations agrégées, personne / organisation / transaction, historique ; colonne d'assignation (« M'assigner », réassigner, retirer) ; décisions par `RiskAlertActions` (note obligatoire). Pas d'action groupée.
- Déterminisme : aucune lecture de l'horloge au rendu ; durées issues de l'API (`slaRemainingMinutes`, `ageMinutes`), dates via `formatDate` (UTC), montants via `formatMoney`.
- Libellés FR/EN : espace de noms `reviewQueue`.

## 9. Sécurité et audit

| Action                                       | Journal                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Décision d'analyste                          | `admin.risk_alert_action` (action, de → vers, règle)                                                |
| Assignation / désassignation                 | `admin.risk_alert_assigned` / `admin.risk_alert_unassigned`                                         |
| Export CSV                                   | `admin.risk_alerts_exported`                                                                        |
| Structuration détectée / répétée / escaladée | `risk.structuring_detected` / `risk.structuring_repeated` / `risk.alert_escalated` (acteur système) |
| Dépassement de SLA                           | `risk.review_sla_breached` (acteur système)                                                         |

Aucune donnée secrète n'est journalisée ; les montants des explications sont des chaînes (pas de `BigInt` en JSON).

## 10. Limites connues

- Seuil de structuration nominal identique pour toutes les devises (très bas en XOF / GNF) : à remplacer par un seuil par devise ou en équivalent CAD avant toute exploitation réelle (`env.ts` n'accepte aujourd'hui qu'une valeur décimale).
- SLA en heures calendaires (pas de calendrier de jours ouvrés).
- Pagination par page (pas de curseur) : suffisante pour la volumétrie sandbox ; un curseur `(dueAt, id)` serait préférable au-delà de quelques milliers d'alertes ouvertes.
- La structuration ne relie pas des sujets distincts (réseaux de mules, bénéficiaires communs).
