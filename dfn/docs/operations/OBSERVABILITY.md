# Observabilité — métriques, traces et alertes (phase 7)

> Environnement **sandbox** : « Données fictives — Aucun fonds réel ». Les métriques décrivent des montants fictifs et des partenaires simulés ; les alertes exercent la boucle d'exploitation (détection → runbook → correction), elles ne portent sur aucun fonds réel. Décision : [ADR-0016](../decisions/ADR-0016-observabilite-metriques-traces-alertes.md).

## 1. Vue d'ensemble

| Composant                    | Fourni par                                                                                              | Contenu                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /metrics` (hors `/v1`)  | API, module `apps/api/src/modules/observability`                                                        | Exposition Prometheus : métriques processus Node.js, HTTP par gabarit de route, jauges métier lues en base à la collecte                  |
| Traces W3C (`traceparent`)   | API (`trace-context.ts`), `LoggerModule` (`app.module.ts`), transport webhook (`webhook-http.ts`)       | Identifiant de trace continué ou créé par requête, renvoyé en en-tête, présent sur chaque ligne de journal, propagé aux webhooks sortants |
| Prometheus + règles d'alerte | profil Compose `observability`, `infra/observability/prometheus/{prometheus.yml,alerts.yml}`            | Collecte de toutes les répliques de l'API toutes les 15 s, 25 règles (§5)                                                                 |
| Alertmanager                 | profil Compose `observability`, `infra/observability/alertmanager/alertmanager.yml`                     | Routage par sévérité vers des webhooks (`ALERT_WEBHOOK_URL*`), inhibition, battement de cœur vers un « dead man's switch » (§5 bis)       |
| Grafana                      | profil Compose `observability`, `infra/observability/grafana/` (provisionnement + tableau de bord JSON) | Tableau de bord « DFN API — sandbox » (trafic, latence, tâches, webhooks, file de revue, documents, clés, registre)                       |
| Journaux                     | pino (`docker compose logs api`)                                                                        | Inchangés (RUNBOOK §9) avec deux champs de plus par requête : `trace_id`, `span_id`                                                       |

Non fourni dans le bac à sable : un collecteur de traces (OpenTelemetry) — voir §8. Les notifications ne partent que vers les destinations configurées dans `.env` (§5 bis) : sans elles, les alertes restent visibles dans Prometheus, Alertmanager et Grafana mais personne n'est prévenu, ce que le conteneur annonce au démarrage.

## 2. Point de collecte `GET /metrics`

- Activé par `METRICS_ENABLED` (`true` par défaut). À `false`, la route n'est pas enregistrée : `404 NOT_FOUND`, comme n'importe quel chemin inconnu.
- **Accès** :

  | `METRICS_TOKEN`          | Règle                                                                                                                                                                                                                                                                                                                                                                                                                   | Refus                                      |
  | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
  | défini (≥ 24 caractères) | `Authorization: Bearer <METRICS_TOKEN>` obligatoire, comparaison à temps constant ; le pair loopback n'en est **pas** dispensé                                                                                                                                                                                                                                                                                          | `401 UNAUTHENTICATED` + `WWW-Authenticate` |
  | non défini               | seul un pair TCP **loopback** est servi (`socket.remoteAddress` : `127.0.0.0/8`, `::1`, formes IPv4 mappées) ; `X-Forwarded-For` et `req.ip` ne sont jamais consultés pour **accorder** l'accès — un client distant ne peut pas se déclarer local — et toute requête **relayée par un proxy** (en-tête `Forwarded`, `X-Forwarded-For`/`-Host`/`-Proto`, `X-Real-IP` ou `Via` présent) est refusée, même depuis loopback | `403 FORBIDDEN`                            |

  Derrière un reverse proxy ou depuis un autre conteneur (cas de Prometheus dans le profil `observability` : le pair est l'adresse du réseau Docker), le jeton est donc **obligatoire**. Avec la composition, il l'est **toujours** : même un agent de l'hôte qui collecte `127.0.0.1:4000` passe par le port publié et arrive dans le conteneur depuis la passerelle du réseau Docker (403). Le mode sans jeton ne vaut que pour une API lancée directement sur l'hôte (`pnpm start`, déploiement sans conteneurs). Le refus des requêtes relayées vise le proxy **sur la même machine** : l'application web réécrit `/api/…` vers l'API (`apps/web/next.config.ts`, `API_INTERNAL_URL=http://localhost:4000` par défaut, cas de `pnpm dev`) ; si cette réécriture couvrait `/metrics` (elle est limitée à `/api/v1/*` au moment d'écrire — défense en profondeur), un navigateur demandant `http://<web>/api/metrics` arriverait à l'API depuis `127.0.0.1` — avec l'en-tête `X-Forwarded-Host` que Next.js ajoute, d'où le 403. Un proxy qui ne poserait aucun en-tête de relais ne serait pas reconnu : dès qu'un proxy quelconque partage la machine, configurer `METRICS_TOKEN`.

- **Jamais derrière la session, le CSRF ni la limitation de débit** : la route est servie par un middleware appliqué avant les gardes globaux. Le garde de session traite tout `Bearer` comme une session candidate et interroge la base ; une collecte en dépendrait et tomberait avec elle. De même, la route ne touche pas Redis (magasin de limitation de débit). Un `/metrics` qui répond ne prouve donc que l'état du processus ; l'état de la base se lit dans `dfn_metrics_collect_errors_total` (§3.3) et `GET /v1/health`.
- Les collectes ne produisent pas de ligne de journal (`autoLogging.ignore`), elles sont comptées comme les autres requêtes (route `/metrics`, statut 200/401/403).
- Format `text/plain; version=0.0.4`, `Cache-Control: no-store`. Les en-têtes sandbox (`x-dfn-mode`, `x-dfn-disclaimer`) sont présents comme sur toute réponse.
- **Plusieurs répliques** : chaque réplique expose ses propres séries processus et HTTP ; les jauges métier (§3.3) décrivent la base commune et ont la même valeur partout — les agréger avec `max()` (ce que font les règles et le tableau de bord).

## 3. Catalogue des métriques

Toutes les métriques portent le préfixe `dfn_`. Prometheus ajoute `job="dfn-api"`, `instance="<ip>:4000"`, `service`, `mode="sandbox"` et `stack="dfn-sandbox"`.

### 3.1 Processus (prom-client, par réplique)

`dfn_process_cpu_seconds_total`, `dfn_process_resident_memory_bytes`, `dfn_process_open_fds`, `dfn_nodejs_eventloop_lag_seconds` et ses percentiles (`_p50`, `_p90`, `_p99`), `dfn_nodejs_heap_size_used_bytes`, `dfn_nodejs_gc_duration_seconds`, `dfn_nodejs_active_handles_total`, `dfn_nodejs_version_info`… (liste complète dans la page `/metrics`). `dfn_api_info{instance_id, mode="sandbox", node_version}` vaut toujours 1 et identifie la réplique (`INSTANCE_ID`).

### 3.2 HTTP (par réplique)

| Métrique                            | Type        | Étiquettes                    | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dfn_http_requests_total`           | compteur    | `method`, `route`, `status`   | Réponses émises, y compris les refus des gardes (401/403/429) et les 404                                                                                                                                                                                                                                                                                                                                                                    |
| `dfn_http_request_duration_seconds` | histogramme | `method`, `route`             | Du premier middleware à la fin de la réponse ; seaux de 5 ms à 10 s (objectif PERFORMANCE.md : lectures < 500 ms p95)                                                                                                                                                                                                                                                                                                                       |
| `dfn_document_scans_total`          | compteur    | `engine`, `outcome`, `reason` | Analyses antivirus des téléversements : `CLEAN`, `INFECTED`, `UNAVAILABLE` (refus `503 SCAN_UNAVAILABLE`, échec fermé, `reason` = `UNREACHABLE`, `TIMEOUT`, `SIZE_LIMIT`, `ENGINE_ERROR`, `CONNECTION_LOST` ou `PROTOCOL_ERROR` ; `none` pour un verdict), `SKIPPED` (`ANTIVIRUS_PROVIDER=none`, `engine="none"`) ; `engine="sandbox-eicar"` est la **simulation** du bac à sable. Séries du moteur configuré exposées à 0 dès le démarrage |

`route` est le **gabarit** enregistré par le routeur (`/v1/transfers/:id`), jamais l'URL : identifiants et paramètres de requête ne créent aucune série. Valeurs fixes : `unmatched` (aucune route, 404), `/docs` (interface OpenAPI), `/metrics`. `method` est borné aux méthodes HTTP connues (`OTHER` sinon). Limites : les requêtes rejetées par le contrôle d'origine CSRF (middleware de `AppModule`, exécuté avant) et celles abandonnées par le client avant la réponse ne sont pas comptées.

### 3.3 Jauges métier (lues en base, cache 15 s, délai 5 s)

Chaque collecte rafraîchit les jauges au plus une fois par `15 s` et par réplique ; les collectes concurrentes attendent le même rafraîchissement. Les huit collecteurs s'exécutent **l'un après l'autre**, chacun dans **une transaction** à laquelle est appliqué un `statement_timeout` égal au budget restant des 5 s : un rafraîchissement ne tient jamais plus d'**une connexion** du pool Prisma, une requête qui bloque (table verrouillée par une migration, `VACUUM` long) est **annulée côté serveur** à l'échéance et rend sa connexion, l'attente d'une connexion est bornée à 1 s (les requêtes de l'API passent avant), et un collecteur dont la transaction précédente n'est pas terminée est **sauté** plutôt que relancé. Un collecteur en échec (erreur, annulation, saut ou budget épuisé) **retire ses séries** (aucune valeur périmée n'est servie comme actuelle) et incrémente `dfn_metrics_collect_errors_total{collector}` ; le reste de la page est servi. Une base lente dégrade donc les jauges métier, jamais l'API elle-même.

| Métrique                                                    | Étiquettes           | Contenu (source)                                                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dfn_maintenance_job_registered`                            | `job_name`           | 1 pour chaque tâche que la réplique a enregistrée auprès du planificateur (`JobRegistry`) ; une tâche enregistrée sans série `…_last_success_age_seconds` n'a jamais réussi                                            |
| `dfn_maintenance_job_last_run_status`                       | `job_name`, `status` | 1 pour le statut de la dernière exécution de chaque tâche, 0 pour les autres (`MaintenanceRun`)                                                                                                                        |
| `dfn_maintenance_job_last_run_age_seconds`                  | `job_name`           | Secondes depuis le début de la dernière exécution                                                                                                                                                                      |
| `dfn_maintenance_job_last_run_duration_seconds`             | `job_name`           | Durée de la dernière exécution (écoulée si encore `RUNNING`)                                                                                                                                                           |
| `dfn_maintenance_job_last_success_age_seconds`              | `job_name`           | Secondes depuis la fin de la dernière exécution `COMPLETED` (absente tant qu'aucun succès)                                                                                                                             |
| `dfn_webhook_deliveries`                                    | `status`             | Lignes `WebhookDelivery` par statut (`PENDING`, `DELIVERED`, `FAILED`, `EXHAUSTED`)                                                                                                                                    |
| `dfn_webhook_deliveries_due`                                | —                    | Livraisons à tenter maintenant : `PENDING`, et `FAILED` dont le délai de nouvelle tentative est écoulé                                                                                                                 |
| `dfn_webhook_oldest_due_age_seconds`                        | —                    | Attente de la plus ancienne livraison due (0 si aucune)                                                                                                                                                                |
| `dfn_review_alerts_open`                                    | `severity`           | Alertes de risque ouvertes (`OPEN`, `REVIEWING`, `CONTESTED`) — `RiskAlert`                                                                                                                                            |
| `dfn_review_alerts_sla_breached`                            | `severity`           | Alertes ouvertes marquées hors SLA par la tâche `REVIEW_SLA`                                                                                                                                                           |
| `dfn_review_alerts_overdue`                                 | `severity`           | Alertes ouvertes dont `dueAt` est dépassé (calcul immédiat, avant le marquage)                                                                                                                                         |
| `dfn_counterparty_link_requests_pending`                    | —                    | Demandes de lien de contrepartie en attente de réponse (`Counterparty.linkStatus = PENDING`)                                                                                                                           |
| `dfn_transfers`                                             | `status`             | Transferts par statut (`REVIEW_REQUIRED` = en attente d'une décision de conformité)                                                                                                                                    |
| `dfn_documents`                                             | `scan_status`        | Documents par verdict antivirus ; `INFECTED` doit rester à 0 (ADR-0015 : refus avant stockage)                                                                                                                         |
| `dfn_encryption_keys`                                       | `purpose`, `status`  | Clés de données gérées par le KMS, par usage et statut (toutes à 0 avec `KMS_PROVIDER=none`)                                                                                                                           |
| `dfn_ledger_reconciliation_last_run_status`                 | `status`             | 1 pour le statut de la dernière `ReconciliationJob`, 0 pour les autres (toutes à 0 tant qu'aucune réconciliation n'a eu lieu)                                                                                          |
| `dfn_ledger_reconciliation_last_run_age_seconds`            | —                    | Secondes depuis le début de la dernière réconciliation (absente tant qu'aucune)                                                                                                                                        |
| `dfn_ledger_reconciliation_last_run_duration_seconds`       | —                    | Durée de la dernière réconciliation                                                                                                                                                                                    |
| `dfn_ledger_reconciliation_last_completed_differences`      | —                    | Écarts trouvés par la dernière réconciliation `COMPLETED` (tout écart est un incident, RUNBOOK §8)                                                                                                                     |
| `dfn_ledger_reconciliation_last_completed_accounts_checked` | —                    | Comptes vérifiés par la dernière réconciliation `COMPLETED`                                                                                                                                                            |
| `dfn_metrics_collect_errors_total`                          | `collector`          | Rafraîchissements en échec (erreur, annulation, saut) par collecteur (`maintenance_runs`, `webhook_deliveries`, `review_queue`, `link_requests`, `transfers`, `documents`, `encryption_keys`, `ledger_reconciliation`) |
| `dfn_metrics_snapshot_age_seconds`                          | —                    | Âge des valeurs servies (0 : rafraîchies pour cette collecte)                                                                                                                                                          |
| `dfn_metrics_collect_duration_seconds`                      | —                    | Durée du dernier rafraîchissement (collecteurs en série)                                                                                                                                                               |

## 4. Traces

- **Entrée** : un en-tête `traceparent` valide (W3C Trace Context niveau 1 : `00-<trace-id 32 hex>-<parent-id 16 hex>-<flags>`, identifiants non nuls, hexadécimal minuscule, version ≠ `ff`) est **continué** — même `trace_id`, nouveau `span_id` pour la requête, seul le bit « échantillonné » des flags est conservé. Sans en-tête, ou avec un en-tête invalide, une nouvelle trace est créée (flags `01`).
- **Sortie** : la réponse porte `traceparent: 00-<trace_id>-<span_id>-<flags>` (sur toute réponse : 404, refus des gardes, `/metrics`). `X-Request-Id` reste l'identifiant de requête des journaux (`req.id`) et des erreurs (`requestId`) ; les deux coexistent.
- **Journaux** : `trace_id` et `span_id` sont des liaisons du journal de requête pino (`customProps`), donc présents sur la ligne de fin de requête et sur tout ce que les services journalisent pendant la requête via nestjs-pino. Exemple : `docker compose logs api | grep '"trace_id":"4bf92f35…"'` donne la requête et ce qu'elle a déclenché.
- **Webhooks sortants** : chaque `POST` partenaire porte un `traceparent` — span enfant de la requête qui a produit l'événement (contexte conservé par `AsyncLocalStorage` jusque dans l'envoi, même après la réponse), ou racine d'une nouvelle trace pour les nouvelles tentatives lancées par le planificateur. Le partenaire peut ainsi relier ses propres journaux aux nôtres.
- **Sans backend de traces** : rien n'est exporté. Pour ingérer plus tard ces traces dans un collecteur OpenTelemetry : (1) déployer `otel-collector` avec un récepteur OTLP et un exportateur vers le backend choisi (Tempo, Jaeger…) ; (2) ajouter au démarrage de l'API le SDK Node OpenTelemetry (`@opentelemetry/sdk-node`, instrumentation HTTP/Express/Prisma, propagateur `W3CTraceContextPropagator`, qui lit et écrit le même `traceparent`) — les identifiants déjà journalisés et renvoyés aux partenaires restent valables, les spans viennent s'y ajouter ; (3) faire lire les journaux pino par le collecteur (récepteur `filelog` ou `journald`) : `trace_id` / `span_id` suffisent à corréler journaux et spans. Aucune modification des partenaires ni des clients n'est nécessaire.
- Note : `traceparent` n'est pas dans `exposedHeaders` du CORS ; un navigateur ne le lit pas (inutile au web, qui a `X-Request-Id`). À ajouter dans `bootstrap.ts` si un client navigateur doit le lire.

## 5. Alertes

Règles dans `infra/observability/prometheus/alerts.yml` ; un test (`apps/api/test/observability.test.ts`) vérifie que chaque métrique citée existe dans `/metrics` et que chaque `runbook_url` pointe vers une section ci-dessous. Seuils calibrés pour `JOBS_INTERVAL_MINUTES=15` (chaque tâche planifiée à chaque tic). Sévérités : **critical** = intervenir maintenant, **warning** = traiter dans la journée ; **none** est réservé au battement de cœur `DfnAlertingWatchdog`, qui ne s'adresse à personne.

| Alerte                                                              | Sévérité | Condition (résumé)                                          | Signification                                              |
| ------------------------------------------------------------------- | -------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| [DfnApiDown](#dfnapidown)                                           | critical | `up == 0` 2 min                                             | Une réplique ne répond plus aux collectes                  |
| [DfnApiAbsent](#dfnapiabsent)                                       | critical | `absent(up)` 5 min                                          | Plus aucune réplique découverte                            |
| [DfnApiHigh5xxRatio](#dfnapihigh5xxratio)                           | critical | 5xx > 5 % du trafic (≥ 0,2 req/s) 10 min                    | Erreurs serveur généralisées                               |
| [DfnApiHighLatencyP95](#dfnapihighlatencyp95)                       | warning  | p95 des routes > 1 s 10 min                                 | Lenteur générale                                           |
| [DfnApiEventLoopLag](#dfnapieventlooplag)                           | warning  | retard p99 de la boucle d'événements > 0,5 s 10 min         | Travail synchrone qui bloque une réplique                  |
| [DfnMaintenanceJobFailed](#dfnmaintenancejobfailed)                 | warning  | dernière exécution `FAILED` depuis 30 min                   | Une tâche échoue à répétition                              |
| [DfnMaintenanceJobStale](#dfnmaintenancejobstale)                   | warning  | dernier succès > 1 h                                        | Une tâche ne tourne plus                                   |
| [DfnMaintenanceJobNeverSucceeded](#dfnmaintenancejobneversucceeded) | warning  | tâche enregistrée sans aucun succès depuis 1 h              | Le planificateur n'a jamais tourné                         |
| [DfnMaintenanceJobStuck](#dfnmaintenancejobstuck)                   | warning  | `RUNNING` > 30 min                                          | Exécution bloquée ou réplique morte                        |
| [DfnWebhookBacklog](#dfnwebhookbacklog)                             | warning  | > 100 livraisons dues 15 min                                | Partenaires injoignables ou relance arrêtée                |
| [DfnWebhookOldestDue](#dfnwebhookoldestdue)                         | warning  | plus ancienne livraison due > 1 h                           | Les nouvelles tentatives ne partent pas                    |
| [DfnWebhookExhausted](#dfnwebhookexhausted)                         | warning  | livraisons `EXHAUSTED` en hausse sur 1 h                    | Des événements n'ont jamais été reçus par un partenaire    |
| [DfnReviewSlaBreached](#dfnreviewslabreached)                       | warning  | alertes hors SLA > 0 15 min                                 | La file de revue déborde                                   |
| [DfnReviewHighOverdue](#dfnreviewhighoverdue)                       | critical | alertes `HIGH` en retard > 0 30 min                         | Des cas graves attendent                                   |
| [DfnDocumentInfected](#dfndocumentinfected)                         | critical | documents `INFECTED` > 0                                    | Un verdict infecté est enregistré                          |
| [DfnDocumentScanUnavailable](#dfndocumentscanunavailable)           | critical | ≥ 2 refus `SCAN_UNAVAILABLE` sur 15 min (hors `SIZE_LIMIT`) | Les téléversements sont refusés (antivirus sans verdict)   |
| [DfnDocumentScanSizeLimit](#dfndocumentscansizelimit)               | warning  | refus `SIZE_LIMIT` sur 1 h                                  | L'antivirus refuse des fichiers que l'API accepte          |
| [DfnEncryptionKeyNoActive](#dfnencryptionkeynoactive)               | critical | un usage a des clés gérées mais aucune `ACTIVE` 15 min      | Plus rien ne peut être scellé pour cet usage               |
| [DfnEncryptionKeyStagedTooLong](#dfnencryptionkeystagedtoolong)     | warning  | clé `STAGED` depuis 1 h                                     | `KEY_LIFECYCLE` ne tourne pas                              |
| [DfnReconciliationDifferences](#dfnreconciliationdifferences)       | critical | écarts de la dernière réconciliation > 0                    | Le registre et les soldes divergent                        |
| [DfnReconciliationFailed](#dfnreconciliationfailed)                 | critical | dernière réconciliation `FAILED` 30 min                     | La réconciliation ne conclut plus                          |
| [DfnReconciliationStale](#dfnreconciliationstale)                   | warning  | dernière réconciliation > 1 h                               | Plus de contrôle du registre                               |
| [DfnReconciliationNeverRun](#dfnreconciliationneverrun)             | warning  | aucune réconciliation enregistrée depuis 1 h                | Le registre n'a jamais été contrôlé                        |
| [DfnMetricsCollectErrors](#dfnmetricscollecterrors)                 | warning  | erreurs de collecte sur 15 min                              | Les jauges métier d'une réplique ne se rafraîchissent plus |
| [DfnAlertingWatchdog](#dfnalertingwatchdog)                         | none     | toujours vraie (`vector(1)`)                                | Battement de cœur de la chaîne d'alerte (§5 bis)           |

### DfnApiDown

**Signification** : Prometheus n'obtient plus de réponse de `GET /metrics` sur une réplique (`instance`) depuis 2 minutes : processus arrêté ou en boucle de redémarrage, port fermé, jeton refusé (401), `METRICS_ENABLED=false`.
**Première action** : `docker compose ps api` et `docker compose logs --tail 200 api` ; `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:4000/metrics` (200 attendu ; 401 → jeton de `.env` différent entre `api` et `prometheus`, redémarrer les deux ; 404 → `METRICS_ENABLED`). Puis RUNBOOK §8 (check-list d'incident) si la réplique est réellement arrêtée.

### DfnApiAbsent

**Signification** : la découverte DNS du service `api` ne renvoie plus aucune cible depuis 5 minutes : tous les conteneurs `api` sont arrêtés, ou Prometheus n'est plus sur le réseau Compose.
**Première action** : `docker compose ps` ; `docker compose up -d api` ; vérifier `http://127.0.0.1:9090/targets`. Si l'API est volontairement arrêtée, arrêter aussi le profil `observability` (`docker compose --profile observability stop prometheus grafana`).

### DfnApiHigh5xxRatio

**Signification** : plus de 5 % des réponses (toutes répliques) sont des erreurs serveur depuis 10 minutes, avec un trafic significatif. Causes habituelles : base de données ou Redis injoignables, migration manquante, fournisseur simulé en erreur, régression après déploiement.
**Première action** : `GET /v1/health` (`database: error` → PostgreSQL, RUNBOOK §8) ; `docker compose logs api | grep '"level":50'` (les 500 sont journalisés avec leur pile et `trace_id`) ; tableau de bord Grafana « Réponses / s par classe de statut » et « Requêtes / s par route » pour cibler la route. Rollback de la dernière version si elle coïncide (RUNBOOK §3).

### DfnApiHighLatencyP95

**Signification** : la latence p95 des requêtes routées dépasse 1 s (objectif : lectures < 500 ms p95, PERFORMANCE.md).
**Première action** : panneau « Latence p95 par route » pour isoler la route ; `DfnApiEventLoopLag` en parallèle → cause processus ; sinon base de données (verrous, requêtes lentes : `pg_stat_activity`, RUNBOOK §10) ou saturation (ajouter une réplique, RUNBOOK §4).

### DfnApiEventLoopLag

**Signification** : le p99 du retard de la boucle d'événements d'une réplique dépasse 0,5 s : du travail synchrone (chiffrement de gros blobs, JSON volumineux, tâche de maintenance lourde sur la réplique) retarde toutes les requêtes.
**Première action** : identifier la tâche en cours sur cette réplique (`/admin/jobs`, baux par instance) ; redémarrer la réplique si elle est seule concernée ; dimensionner (`MAX_UPLOAD_MB`, pagination) si cela coïncide avec un téléversement ou une rotation de clés.

### DfnMaintenanceJobFailed

**Signification** : la dernière exécution d'une tâche (`job_name`) est `FAILED` et aucune exécution ultérieure n'a réussi en 30 minutes (deux tics du planificateur).
**Première action** : `/admin/jobs` → historique de la tâche → colonne `error` ; relancer à la main (`POST /v1/admin/jobs/<name>/run`) après correction. Tâches sensibles (`KEY_LIFECYCLE`, `DOCUMENT_PURGE`, `STORAGE_MIGRATION`, `ENCRYPTION_KEY_ROTATION`) : KEY_ROTATION.md et RUNBOOK §11.

### DfnMaintenanceJobStale

**Signification** : aucune exécution `COMPLETED` d'une tâche depuis plus d'une heure : planificateur arrêté (`JOBS_DRIVER`, Redis pour BullMQ), bail détenu par une réplique morte, ou échecs continus (voir `DfnMaintenanceJobFailed`). Se mesure à partir d'un premier succès : une tâche qui n'a **jamais** réussi relève de `DfnMaintenanceJobNeverSucceeded`.
**Première action** : `GET /v1/admin/jobs` → `scheduler` (pilote, prochaines exécutions) et `leases` ; un bail expiré est repris automatiquement, un bail vivant sur une réplique absente signale une horloge ou un réseau en cause. Redis : `docker compose logs redis`. ADR-0011 pour le fonctionnement des baux.

### DfnMaintenanceJobNeverSucceeded

**Signification** : une réplique enregistre une tâche auprès du planificateur (`dfn_maintenance_job_registered`) mais aucune `MaintenanceRun` `COMPLETED` n'existe après une heure d'exposition (quatre tics) : le planificateur n'a jamais démarré (`JOBS_ENABLED=false`, `JOBS_DRIVER=bullmq` sans Redis joignable, aucun worker), aucune réplique n'exécute cette tâche, ou chaque exécution a échoué (alors `DfnMaintenanceJobFailed` est déjà levée). C'est l'alerte d'un déploiement neuf, ou d'une base restaurée sans ses lignes `MaintenanceRun`, dont les tâches ne tournent pas — invisible pour `DfnMaintenanceJobStale`, qui a besoin d'un succès pour mesurer.
**Première action** : `GET /v1/admin/jobs` → `scheduler.started` et `nextRuns` ; `docker compose logs api | grep 'scheduler started'` (absent → `JOBS_ENABLED` ou connexion Redis, `docker compose logs redis`) ; lancer la tâche à la main (`POST /v1/admin/jobs/<name>/run`) pour vérifier qu'elle aboutit, puis corriger le planificateur.

### DfnMaintenanceJobStuck

**Signification** : la dernière `MaintenanceRun` d'une tâche est `RUNNING` depuis plus de 30 minutes : gestionnaire suspendu (fournisseur simulé, S3, KMS injoignable), ou réplique morte sans avoir clos l'exécution (le bail expirera et l'exécution suivante reprendra ; la ligne reste `RUNNING`).
**Première action** : comparer `instanceId` de l'exécution aux répliques vivantes ; journaux de cette réplique filtrés sur le nom de la tâche ; si la réplique est morte, rien à faire d'autre que vérifier que le tic suivant reprend (sinon `DfnMaintenanceJobStale` suivra).

### DfnWebhookBacklog

**Signification** : plus de 100 livraisons de webhooks attendent une tentative depuis 15 minutes : points de terminaison partenaires en panne, liste d'autorisation `WEBHOOK_ALLOWED_HOSTS` qui refuse les destinations, ou tâche `WEBHOOK_RETRY` arrêtée.
**Première action** : `SELECT status, "lastStatusCode", "lastError", count(*) FROM "WebhookDelivery" WHERE status IN ('PENDING','FAILED') GROUP BY 1,2,3` ; un même `lastError` pour tout → cause côté plateforme (DNS, allowlist) ; des 5xx partenaires → informer le partenaire, les tentatives reprendront seules (ADR-0011, back-off).

### DfnWebhookOldestDue

**Signification** : une livraison due attend depuis plus d'une heure sans nouvelle tentative : la tâche `WEBHOOK_RETRY` ne tourne pas ou ne traite pas (voir `DfnMaintenanceJobStale{job_name="WEBHOOK_RETRY"}`), ou chaque tentative est refusée avant l'envoi.
**Première action** : état de `WEBHOOK_RETRY` dans `/admin/jobs` ; relance manuelle ; `lastError` de la livraison la plus ancienne.

### DfnWebhookExhausted

**Signification** : des livraisons ont atteint `EXHAUSTED` dans l'heure : toutes les tentatives ont échoué, le partenaire n'a pas reçu ces événements et ne les recevra pas automatiquement.
**Première action** : lister les livraisons `EXHAUSTED` de l'heure avec leur abonnement ; prévenir le partenaire (il peut rejouer les événements via l'API) ; un abonnement dont `failureCount` grimpe sera désactivé — le partenaire doit le réactiver après correction.

### DfnReviewSlaBreached

**Signification** : des alertes de risque ouvertes sont marquées hors SLA par la tâche `REVIEW_SLA` depuis 15 minutes : la file de revue n'est pas traitée dans les délais (`REVIEW_SLA_HOURS_<SEVERITY>`).
**Première action** : console de revue (`/admin/risk`, tri par échéance) ; réaffecter les alertes non assignées ; REVIEW_QUEUES.md pour les règles de file et d'escalade.

### DfnReviewHighOverdue

**Signification** : des alertes `HIGH` ouvertes ont dépassé leur échéance depuis 30 minutes sans première action du personnel. Potentiellement des transactions ou transferts bloqués en attente de décision (`dfn_transfers{status="REVIEW_REQUIRED"}`).
**Première action** : traiter ces alertes en priorité (console de revue filtrée `HIGH`, tri par échéance) ; si personne n'est disponible, escalade conformité (RUNBOOK §8).

### DfnDocumentInfected

**Signification** : une ligne `Document` porte le verdict `INFECTED`. Le téléversement refuse un fichier infecté avant tout stockage (ADR-0015) ; une telle ligne vient donc d'une analyse ultérieure ou d'une modification manuelle. Un document `INFECTED` n'est jamais servi par l'API (`409 DOCUMENT_INFECTED`).
**Première action** : identifier la ligne (`SELECT id, "organizationId", "scanEngine", "scannedAt" FROM "Document" WHERE "scanStatus" = 'INFECTED'`) ; vérifier l'audit (`document.rejected_infected`, `document.download_refused`) ; confirmer que le blob n'est pas distribué ; RUNBOOK §11 (antivirus) pour la procédure de quarantaine et de purge.

### DfnDocumentScanUnavailable

**Signification** : au moins deux téléversements refusés en 15 min faute de verdict antivirus (`503 SCAN_UNAVAILABLE`, `dfn_document_scans_total{outcome="UNAVAILABLE"}`, hors `reason="SIZE_LIMIT"` : voir l'alerte suivante). L'analyse est en échec fermé : tant que le moteur ne répond pas, **aucun** document (preuves de jalon, pièces de litige, justificatifs) ne peut être ajouté. Ne concerne en pratique que `ANTIVIRUS_PROVIDER=clamd` (la simulation `sandbox` ne tombe jamais en panne).
**Première action** : lire `details.reason` d'un refus et le journal `Antivirus` de l'API (`scan unavailable (engine=…, reason=…)`), puis l'état du démon : `docker compose logs clamav`, `nc -z <CLAMD_HOST> <CLAMD_PORT>` ; un redémarrage de clamd (rechargement des signatures) dure plusieurs minutes. La raison (`reason`) de chaque refus figure sur la série. Procédure complète : RUNBOOK §11 (incident « `503 SCAN_UNAVAILABLE` »).

### DfnDocumentScanSizeLimit

**Signification** : le moteur antivirus a refusé au moins un fichier pour sa taille dans l'heure (`reason="SIZE_LIMIT"`) alors que l'API l'acceptait : `StreamMaxLength` de clamd est inférieur à `MAX_UPLOAD_MB`. Les petits fichiers passent, les gros sont refusés en `503 SCAN_UNAVAILABLE`.
**Première action** : porter `StreamMaxLength` (clamd.conf) au moins à `MAX_UPLOAD_MB`, ou abaisser `MAX_UPLOAD_MB` ; RUNBOOK §11 (dimensionnement de clamd).

### DfnEncryptionKeyNoActive

**Signification** : un usage (`purpose`) possède des clés gérées par le KMS mais aucune `ACTIVE` depuis 15 minutes : les valeurs existantes s'ouvrent encore (`DECRYPT_ONLY`), mais rien de nouveau ne peut être scellé avec une clé gérée — les écritures de cet usage échouent ou retombent sur le trousseau d'environnement selon `ENCRYPTION_LEGACY_DECRYPT`.
**Première action** : `/admin/keys` → activer la clé `STAGED` la plus récente, ou en générer une ; KEY_ROTATION.md (cycle de vie, `KEY_ACTIVATION_DELAY_SECONDS`) ; ADR-0014.

### DfnEncryptionKeyStagedTooLong

**Signification** : une clé est `STAGED` depuis plus d'une heure alors que l'activation est automatique après `KEY_ACTIVATION_DELAY_SECONDS` (5 min par défaut) : la tâche `KEY_LIFECYCLE` ne tourne pas ou échoue.
**Première action** : état de `KEY_LIFECYCLE` dans `/admin/jobs` (permission `admin:keys`) ; relance manuelle ; KEY_ROTATION.md.

### DfnReconciliationDifferences

**Signification** : la dernière réconciliation `COMPLETED` a trouvé des écarts entre les écritures du registre et les soldes. Dans le bac à sable les montants sont fictifs, mais un écart signifie un défaut d'intégrité du registre à double entrée (ADR-0002) : à traiter comme un incident.
**Première action** : `docker compose exec api node dist/reconcile-ledger.js --json` pour le détail (`ReconciliationDifference` : compte, attendu, constaté) ; geler les écritures concernées ; RUNBOOK §8 (incident) et LEDGER.md (invariants). Ne jamais « corriger » un solde à la main.

### DfnReconciliationFailed

**Signification** : la dernière `ReconciliationJob` est `FAILED` et aucune n'a abouti depuis 30 minutes : le contrôle d'intégrité ne conclut plus (erreur de base, délai, volume).
**Première action** : `summary` / journaux de la tâche `RECONCILIATION` ; relance manuelle ; si le volume est en cause, augmenter le délai de la tâche ou exécuter la réconciliation à la demande hors pointe.

### DfnReconciliationStale

**Signification** : aucune réconciliation n'a démarré depuis plus d'une heure alors que la tâche `RECONCILIATION` est planifiée à chaque tic. Se mesure à partir d'une première réconciliation : un registre **jamais** contrôlé relève de `DfnReconciliationNeverRun`.
**Première action** : comme `DfnMaintenanceJobStale` pour `RECONCILIATION` ; en attendant, réconciliation à la demande (`reconcile-ledger.js`).

### DfnReconciliationNeverRun

**Signification** : aucune ligne `ReconciliationJob` n'existe après une heure d'exposition (`dfn_ledger_reconciliation_last_run_status` à 0 pour tous les statuts) : la tâche `RECONCILIATION` n'a jamais tourné (planificateur jamais démarré, voir `DfnMaintenanceJobNeverSucceeded{job_name="RECONCILIATION"}`) et aucune réconciliation à la demande n'a été faite. Le registre n'a donc jamais été contrôlé depuis la mise en service ou la restauration de la base. Les séries absentes (collecteur en échec) ne lèvent pas cette alerte mais `DfnMetricsCollectErrors`.
**Première action** : réconciliation à la demande (`docker compose exec api node dist/reconcile-ledger.js --json`) pour obtenir un premier verdict, puis remettre le planificateur en marche (`DfnMaintenanceJobNeverSucceeded`).

### DfnMetricsCollectErrors

**Signification** : un collecteur de jauges métier (`collector`) d'une réplique échoue ou dépasse 5 s à chaque collecte depuis 15 minutes : ses séries sont absentes (les autres alertes métier de cette réplique sont donc aveugles), la base est lente ou injoignable **depuis cette réplique**.
**Première action** : `docker compose logs api | grep 'metrics collector'` (message d'erreur) ; `GET /v1/health` sur la réplique ; si seule une réplique est touchée → réseau ou pool de connexions de celle-ci ; si toutes → base de données (RUNBOOK §8).

### DfnAlertingWatchdog

**Signification** : se déclenche en permanence, par construction. Alertmanager l'envoie toutes les 5 minutes à `ALERT_WATCHDOG_URL` seulement (jamais à une personne) ; c'est l'**absence** de ce battement au « dead man's switch » externe qui doit alerter : Prometheus arrêté, règles non évaluées, Alertmanager arrêté ou injoignable, ou plus de sortie réseau vers le service de notification. Visible comme « firing » dans Prometheus et Alertmanager : c'est l'état normal.
**Première action** (quand le switch externe signale l'absence) : `docker compose --profile observability ps prometheus alertmanager` ; `curl -s http://127.0.0.1:9090/api/v1/alertmanagers` (Alertmanager actif attendu) ; `docker compose logs --tail 100 alertmanager | grep -i 'notify'` (échec de livraison, destination injoignable) ; puis `bash infra/ops/check-profiles.sh --send-test-alert` une fois la cause corrigée.

## 5 bis. Notifications (Alertmanager)

Prometheus envoie les alertes à l'Alertmanager du même profil (`alerting:` de `prometheus.yml`), qui les regroupe (`alertname`, `severity`) et les route selon `infra/observability/alertmanager/alertmanager.yml` :

| Alertes                        | Récepteur  | Destination (`.env`)                                      | Attente avant envoi, répétition |
| ------------------------------ | ---------- | --------------------------------------------------------- | ------------------------------- |
| `DfnAlertingWatchdog`          | `watchdog` | `ALERT_WATCHDOG_URL` (« dead man's switch »)              | immédiat, toutes les 5 min      |
| `severity="critical"`          | `oncall`   | `ALERT_WEBHOOK_URL_CRITICAL` (défaut `ALERT_WEBHOOK_URL`) | 10 s, toutes les heures         |
| toutes les autres (`warning`…) | `team`     | `ALERT_WEBHOOK_URL`                                       | 30 s, toutes les 4 h            |

- **Inhibition** : tant que `DfnApiAbsent` (plus aucune réplique) se déclenche, les `warning` sont retenus — ils en découlent (tâches obsolètes, files qui montent) ; on est prévenu de la cause seulement. `DfnApiDown` (une réplique sur plusieurs) n'inhibe rien.
- **Résolution** : `team` et `oncall` reçoivent aussi le retour à la normale (`send_resolved`).
- **Format** : le JSON webhook d'Alertmanager (version 4) ; tout récepteur qui l'accepte convient (outil d'astreinte, passerelle de messagerie, relais courriel). Les annotations ne portent que des comptes agrégés et des identifiants techniques (réplique, tâche), jamais de données personnelles.
- **Secrets** : les URL (qui contiennent souvent un jeton) sont écrites par l'entrypoint dans des fichiers tmpfs (`/run/alertmanager/*`, mode 0600, lus par `url_file`), jamais dans la configuration ni en argument de commande ; elles restent visibles par `docker inspect` comme toute variable du conteneur. L'API ne les reçoit pas (vidées dans son environnement).
- **Destination absente** : le webhook correspondant est retiré de la configuration rendue (lignes marquées `# webhook`, `# webhook-critical`, `# watchdog`) ; le conteneur démarre et écrit `WARNING: ALERT_WEBHOOK_URL is not set: … NOBODY IS NOTIFIED` (ou l'équivalent pour le watchdog). Une URL qui n'est pas `http(s)://…`, ou `ALERT_WEBHOOK_URL_CRITICAL` sans `ALERT_WEBHOOK_URL`, empêche le démarrage.
- **Silences** : pendant une maintenance, `http://127.0.0.1:9093` → _New silence_ (ou `amtool silence add`), avec une durée et un commentaire ; ne jamais faire taire `DfnAlertingWatchdog` (le switch externe se déclencherait).
- **Instance unique** : pas de grappe (`--cluster.listen-address=` vide) ; l'état des silences et des notifications est sur le volume `alertmanagerdata`.

## 6. Lancer le profil `observability`

```bash
# dans .env (jamais commité) :
#   METRICS_TOKEN=$(openssl rand -hex 32)          # lu par l'API (env_file) et écrit en tmpfs par l'entrypoint de Prometheus
#   GRAFANA_ADMIN_PASSWORD=<12 caractères ou plus>  # aucun mot de passe par défaut : le conteneur refuse de démarrer sans
#   ALERT_WEBHOOK_URL=https://…                     # facultatif : sans destination, personne n'est prévenu (§5 bis)
#   ALERT_WATCHDOG_URL=https://…                    # facultatif : « dead man's switch » externe
docker compose --profile observability up -d --build
docker compose --profile observability ps
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:4000/metrics | head -20
open http://127.0.0.1:9090/targets        # cible dfn-api UP (une par réplique)
open http://127.0.0.1:9090/alerts         # règles chargées, état de chaque alerte
open http://127.0.0.1:9093                # Alertmanager : alertes reçues, groupes, silences
open http://127.0.0.1:3001                # Grafana, utilisateur GRAFANA_ADMIN_USER (dfn-admin) — tableau de bord « DFN API — sandbox »
docker compose --profile observability stop prometheus alertmanager grafana   # arrêt du profil seul
GRAFANA_ADMIN_PASSWORD=… bash infra/ops/check-profiles.sh          # vérification de bout en bout (ci-dessous)
GRAFANA_ADMIN_PASSWORD=… bash infra/ops/check-profiles.sh --send-test-alert   # + alerte de test livrée (prévenir ses lecteurs)
```

`infra/ops/check-profiles.sh` vérifie la pile en marche : un document fictif fait l'aller-retour par l'API (analysé, scellé, stocké sur le pilote configuré — SeaweedFS avec le profil `s3` —, relu et comparé octet par octet) ; Prometheus collecte chaque réplique (jeton accepté), a chargé les 25 règles sans erreur d'évaluation et a reçu le verdict antivirus du téléversement ; la source de données provisionnée de Grafana répond, le tableau de bord existe et chacune de ses requêtes s'exécute ; Alertmanager est prêt et reçoit les alertes de Prometheus (`DfnAlertingWatchdog` présent). Avec `--send-test-alert`, il envoie aussi `DfnNotificationTest` (sévérité `warning`, étiquette `test="true"`, « TEST » dans son résumé, fin au bout de 5 minutes), vérifie qu'elle est routée vers `team` et qu'au moins une requête webhook réussit sans aucun échec dans la fenêtre. La CI (tâche `profiles`) démarre `--profile s3 --profile observability` avec des identifiants jetables et un récepteur webhook de test (`infra/ci/webhook-sink.py`), lance ce script avec `--send-test-alert`, vérifie que l'objet est bien dans le bucket privé et que chaque récepteur a reçu ses alertes à sa propre destination (battement de cœur sur `watchdog`, test sur `team`, alerte critique sur `oncall` et pas sur `team`). `alertmanager.yml` est validé par `amtool check-config` dans ses quatre rendus et ses routes par `amtool config routes test`. Les règles sont aussi validées par `promtool` (`check config`, `check rules`) et par des tests unitaires de règles, `infra/observability/prometheus/alerts.test.yml` (séries synthétiques : chaque cas montre quand une alerte se déclenche et quand elle reste muette) :

```bash
docker run --rm --entrypoint /bin/promtool -v "$PWD/infra/observability/prometheus:/t:ro" -w /t \
  prom/prometheus:v3.5.0 test rules alerts.test.yml
```

| Variable `.env`                                           | Rôle                                                                                                                                                                                                            | Défaut                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `METRICS_TOKEN`                                           | jeton `Bearer` de `GET /metrics` (API) ; variable du conteneur Prometheus, écrite par son entrypoint dans `/run/secrets/metrics_token` (tmpfs, `credentials_file`) puis retirée de l'environnement du processus | aucun (**requis** par le profil)                                                |
| `METRICS_ENABLED`                                         | expose `/metrics` (API)                                                                                                                                                                                         | `true`                                                                          |
| `GRAFANA_ADMIN_PASSWORD`                                  | mot de passe de l'administrateur Grafana (≥ 12 caractères, vérifié au démarrage)                                                                                                                                | aucun (**requis**)                                                              |
| `GRAFANA_ADMIN_USER`                                      | nom de l'administrateur Grafana                                                                                                                                                                                 | `dfn-admin`                                                                     |
| `PROMETHEUS_HOST_PORT`, `GRAFANA_HOST_PORT`               | ports publiés sur `127.0.0.1` uniquement                                                                                                                                                                        | `9090`, `3001`                                                                  |
| `ALERT_WEBHOOK_URL`                                       | destination webhook des alertes `warning` (et `critical` sans la suivante), §5 bis                                                                                                                              | aucune (personne n'est prévenu, annoncé au démarrage)                           |
| `ALERT_WEBHOOK_URL_CRITICAL`                              | destination des alertes `critical` (astreinte)                                                                                                                                                                  | `ALERT_WEBHOOK_URL`                                                             |
| `ALERT_WATCHDOG_URL`                                      | « dead man's switch » qui reçoit `DfnAlertingWatchdog` toutes les 5 min                                                                                                                                         | aucune                                                                          |
| `ALERTMANAGER_HOST_PORT`                                  | port d'Alertmanager publié sur `127.0.0.1`                                                                                                                                                                      | `9093`                                                                          |
| `PROMETHEUS_RETENTION`                                    | rétention locale des séries                                                                                                                                                                                     | `15d`                                                                           |
| `PROMETHEUS_IMAGE`, `ALERTMANAGER_IMAGE`, `GRAFANA_IMAGE` | images (épinglées par défaut)                                                                                                                                                                                   | `prom/prometheus:v3.5.0`, `prom/alertmanager:v0.29.0`, `grafana/grafana:12.1.1` |

Durcissement : les trois conteneurs tournent en racine en lecture seule sans capacités (`x-hardening`), n'écoutent que sur loopback, Grafana sans inscription ni accès anonyme ni télémétrie ; le tableau de bord provisionné n'est pas modifiable dans l'interface (modifier le JSON du dépôt). La racine en lecture seule est la raison pour laquelle le jeton n'est pas un secret Compose `environment:` : Compose injecte un tel secret en le copiant dans le conteneur créé, ce qu'une racine en lecture seule refuse (« `file` is the sole supported option ») — l'entrypoint l'écrit donc lui-même sur un tmpfs (`/run/secrets`, fichier en mode 0600). Vérifié (2026-10-23) : Prometheus 3.5 et Grafana 12.1 réels contre l'API compilée — cible UP avec le jeton (401 sans), 24 règles évaluées sans erreur, les 31 requêtes du tableau de bord exécutées, puis, en CI, la pile complète avec SeaweedFS S3 (tâche `profiles`). Vérifié (2026-10-24) : Alertmanager 0.29 réel avec l'entrypoint de la composition — battement de cœur reçu de Prometheus sur `watchdog`, alerte de test sur `team`, alerte critique sur `oncall`, démarrage sans destination (avertissements, aucun webhook rendu) et refus d'une URL invalide. Prometheus découvre les répliques par DNS (`api`, un enregistrement A par conteneur) : `docker compose up -d --scale api=3` est collecté sans changement de configuration (RUNBOOK §4). Exposer Prometheus ou Grafana au-delà de la machine suppose un reverse proxy TLS et une authentification (hors périmètre du bac à sable).

## 7. Gestion du jeton

- **Génération** : `openssl rand -hex 32` (64 caractères ; minimum 24). Un jeton par environnement, dans `.env` seulement.
- **Où il circule** : variable d'environnement de l'API ; variable du conteneur Prometheus que l'entrypoint écrit dans un fichier tmpfs (`/run/secrets/metrics_token`, mode 0600, lu par `credentials_file`) avant de la retirer de l'environnement du processus Prometheus — jamais dans `prometheus.yml`, jamais en argument de commande, jamais sur disque. L'en-tête `authorization` est masqué dans les journaux de l'API (`redact`), la page `/metrics` ne le contient pas, les refus (401) sont comptés sans en journaliser la valeur.
- **Rotation** : changer `METRICS_TOKEN` dans `.env` puis `docker compose --profile observability up -d api prometheus` (les deux relisent `.env` ; aucune double validité, donc quelques collectes en 401 pendant le redémarrage — moins de 2 minutes pour ne pas déclencher `DfnApiDown`). En cas de fuite, faire de même immédiatement : un jeton ne donne que la lecture des métriques, qui ne contiennent aucune donnée personnelle ni montant individuel, mais décrivent l'activité de la plateforme.
- **Sans jeton** (`METRICS_TOKEN` absent) : seule une collecte **directe** depuis la machine elle-même (loopback, sans en-tête de relais) est acceptée — adapté à un agent local sur l'hôte quand l'API **n'est pas conteneurisée** ; ni le conteneur Prometheus du profil ni un agent de l'hôte face à la composition ne sont en loopback (pair sur le réseau Docker → 403) : avec la composition, configurer le jeton. Sans lui, le conteneur `prometheus` s'arrête à chaque démarrage avec le message `METRICS_TOKEN must be set` (redémarrages en boucle, visibles dans `docker compose logs prometheus`) et Grafana l'attend. Derrière un reverse proxy, le pair est le proxy : la requête relayée est refusée (en-têtes `Forwarded` / `X-Forwarded-*` / `Via`, §2) et il faut le jeton. Ne pas utiliser ce mode quand l'application web ou un autre proxy tourne sur la même machine que l'API (`pnpm dev`, déploiement sans conteneurs) : une réécriture du web qui relaierait `http://<web>/api/metrics` vers l'API depuis loopback est refusée grâce à `X-Forwarded-Host` (et la réécriture actuelle ne relaie que `/api/v1/*`), mais un proxy muet ne le serait pas.

## 8. Limites et suite avant un pilote

- Notifications : la chaîne est en place (§5 bis) mais aucune destination réelle n'est configurée dans le bac à sable ; avant un pilote, choisir l'outil d'astreinte (ou la passerelle de messagerie) et le « dead man's switch », renseigner `ALERT_WEBHOOK_URL*` / `ALERT_WATCHDOG_URL`, puis `check-profiles.sh --send-test-alert`. Une seule instance d'Alertmanager (pas de haute disponibilité) : le switch externe couvre sa panne.
- Aucun export de traces : voir §4 pour le collecteur OpenTelemetry ; prévoir un échantillonnage (`flags`) quand le trafic augmentera.
- Rétention locale de 15 jours sur un volume Docker, sans réplication ; sauvegarde des séries hors périmètre (les journaux et la base restent la source d'audit, RUNBOOK §5).
- Les jauges métier sont des instantanés de la base (cache 15 s) : un événement de moins de 15 s entre deux collectes peut passer inaperçu ; les compteurs HTTP, eux, sont exacts. Les collecteurs étant exécutés en série sous un budget de 5 s, une base lente fait d'abord sauter les derniers collecteurs de la liste (`ledger_reconciliation`, `encryption_keys`…) : `dfn_metrics_collect_errors_total` le montre, les séries HTTP et processus ne sont jamais touchées.
- Les requêtes rejetées par le contrôle d'origine CSRF ne sont pas comptées (ordre des middlewares, §3.2).
