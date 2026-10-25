# ADR-0011 — Planificateur distribué : baux de tâches en base, pilote BullMQ et limites de débit partagées

| Champ  | Valeur                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statut | Accepté                                                                                                                                                                                                                                                                                                                                                                      |
| Date   | 2026-10-11                                                                                                                                                                                                                                                                                                                                                                   |
| Portée | `apps/api/src/modules/jobs` (baux, exécuteur, pilotes), `apps/api/src/common/redis`, `apps/api/src/common/throttler`, `api-platform/rate-limiter.ts`, `api-auth.service.ts`, `webhook-dispatcher.service.ts`, modèles `JobLease` et `MaintenanceRun.{instanceId, heartbeatAt}`, variables `JOBS_DRIVER`, `JOB_LEASE_SECONDS`, `INSTANCE_ID`, `RATE_LIMIT_STORE`, `REDIS_URL` |

## Contexte

Jusqu'à la phase 5, les tâches de maintenance (instantanés de soldes, réconciliation, expirations, anonymisation, traitement des transferts, relance des webhooks, factures en retard) étaient déclenchées par une minuterie dans chaque processus API. L'exclusion mutuelle reposait sur `pg_try_advisory_xact_lock` pris **dans une transaction interactive ouverte pendant toute l'exécution** (jusqu'à 15 minutes). Ce schéma, suffisant pour une réplique unique, pose plusieurs problèmes dès que l'on prépare l'exploitation par un partenaire :

- une connexion du pool PostgreSQL est immobilisée pendant toute la durée d'une tâche, et une transaction longue gêne le `VACUUM` ;
- le délai de 15 minutes de la transaction interrompt brutalement une tâche longue (rotation des clés, gros rattrapage) ;
- une exécution interrompue par un arrêt brutal reste `RUNNING` pour toujours dans `MaintenanceRun` ;
- personne ne sait quelle réplique exécute quoi, ni si elle est encore vivante ;
- avec N répliques, chaque tâche est exécutée jusqu'à N fois par intervalle (l'une après l'autre) ;
- les quotas par clé API et le `throttle` global par IP sont comptés en mémoire, donc multipliés par le nombre de répliques ; l'écriture de `lastUsedAt` « au plus une fois par minute » l'est aussi ;
- une livraison de webhook créée juste avant un arrêt brutal reste `PENDING` indéfiniment (la relance ne traitait que les livraisons `FAILED`).

Contrainte permanente (ADR-0003) : tout reste en **mode sandbox** ; ces mécanismes ne déplacent aucun fonds réel et n'appellent aucun partenaire réel.

## Décision

### 1. Des baux (leases) en base plutôt qu'un verrou tenu par une transaction

Chaque tâche possède au plus une ligne `JobLease (jobName PK, ownerId, runId, acquiredAt, heartbeatAt, expiresAt)`.

| Opération      | Mise en œuvre (`job-lease.ts`)                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquisition    | une seule requête `INSERT … ON CONFLICT ("jobName") DO UPDATE … WHERE "JobLease"."expiresAt" < now()` : insère un bail libre, **reprend un bail expiré**, ne fait rien si un propriétaire vivant le détient. Le verrouillage de ligne de PostgreSQL garantit un seul gagnant. |
| Renouvellement | `UPDATE … WHERE ownerId = moi AND runId = mon exécution`, toutes les `JOB_LEASE_SECONDS / 3` secondes (battement de cœur), qui met aussi à jour `MaintenanceRun.heartbeatAt`.                                                                                                 |
| Libération     | `DELETE … WHERE ownerId = moi AND runId = mon exécution` : une réplique ne supprime jamais le bail d'une autre.                                                                                                                                                               |
| Horloge        | toutes les comparaisons utilisent l'horloge de la base (`now() AT TIME ZONE 'UTC'`), jamais celle des répliques.                                                                                                                                                              |

Déroulé d'une exécution (`MaintenanceService.run`) :

1. acquisition du bail, sinon `409 JOB_ALREADY_RUNNING` (déclenchement manuel) ou tâche ignorée (planificateur) ;
2. si le bail a été repris, les exécutions laissées `RUNNING` par l'ancien propriétaire sont closes `FAILED` avec l'erreur « lease expired: instance X stopped renewing its lease; taken over by Y » ;
3. création de la ligne `MaintenanceRun` (même identifiant que `JobLease.runId`, `instanceId = INSTANCE_ID`) ;
4. le gestionnaire reçoit `{ triggeredBy, signal, runId }` ; le contrat historique `{ triggeredBy }` reste valable (champs optionnels) ;
5. si un renouvellement est refusé (bail repris par une autre instance) ou impossible pendant toute une période de bail, le `AbortSignal` est déclenché et l'exécution est close **immédiatement** `FAILED` (« lease lost … »), même si le gestionnaire ignore le signal ; son résultat tardif ne remplace pas ce verdict ;
6. le bail est libéré dans tous les cas (s'il nous appartient encore).

Aucune connexion n'est immobilisée pendant l'exécution et une réplique arrêtée ne bloque une tâche que pendant `JOB_LEASE_SECONDS` au plus (120 s par défaut).

### 2. Deux pilotes de planification (`JOBS_DRIVER`)

| Pilote               | Fonctionnement                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inprocess` (défaut) | minuterie dans chaque réplique, toutes les `JOBS_INTERVAL_MINUTES`, exécution séquentielle des tâches enregistrées. Les baux empêchent toute exécution concurrente ; avec N répliques une tâche peut encore tourner jusqu'à N fois par intervalle, l'une après l'autre.                                                                                                                                                        |
| `bullmq`             | file Redis `dfn-maintenance` ; une **planification répétable par tâche** (`upsertJobScheduler`, identifiant stable `maintenance-<JOB>`) : les répliques qui démarrent en même temps convergent vers une seule planification. Premier passage un intervalle après la création (comme la minuterie). Un `Worker` par réplique (concurrence 1) appelle le même exécuteur sous bail : chaque échéance est exécutée une seule fois. |

Pour BullMQ, les reprises sont désactivées (`attempts: 1`, `maxStalledCount: 0`) : un travail interrompu par l'arrêt d'une réplique n'est pas rejoué par BullMQ ; le bail de la réplique morte expire et l'échéance suivante relance la tâche. Le démarrage de l'API n'attend jamais Redis (la planification est enregistrée en arrière-plan) et l'arrêt (`OnModuleDestroy`) ferme le worker après sa tâche en cours (10 s maximum, puis fermeture forcée), puis la file, puis les connexions Redis.

Le déclenchement manuel depuis la console d'administration reste synchrone et passe par le même exécuteur sous bail, quel que soit le pilote.

### 3. Connexions Redis centralisées

`RedisConnectionService` (`common/redis`, module global) est le seul propriétaire des connexions Redis de l'API : rien ne se connecte tant qu'aucune fonctionnalité configurée pour Redis ne le demande (avec `inprocess` + `memory`, l'API ne touche jamais Redis). Connexion partagée à échec rapide (délais de commande bornés) pour les limites de débit ; connexion dédiée pour BullMQ (`maxRetriesPerRequest: null`). Toutes sont fermées à l'arrêt de l'application (`app.close()` ne laisse aucune ressource ouverte). Les journaux ne contiennent jamais l'URL complète (pas d'identifiants).

### 4. Limites de débit partagées (`RATE_LIMIT_STORE`)

| Usage                                          | `memory` (défaut)               | `redis`                                                                                                     |
| ---------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Quota par clé API (fenêtre glissante)          | fenêtre en mémoire par réplique | script Lua atomique sur un ensemble trié `dfn:rl:sw:apikey:<id>` (horloge du serveur Redis, TTL = fenêtre)  |
| `lastUsedAt` au plus une fois par minute       | table en mémoire par réplique   | `SET dfn:rl:once:lastused:<id> 1 NX PX 60000`                                                               |
| `throttle` global par IP (`@nestjs/throttler`) | stockage en mémoire du module   | `RedisThrottlerStorage` : fenêtre fixe + période de blocage, script Lua atomique, clés `dfn:rl:throttler:*` |

Toutes les clés portent un TTL. Si Redis devient injoignable, les deux magasins **se replient sur la mémoire de la réplique** (limites par réplique, avertissement journalisé au plus toutes les 30 s) plutôt que de faire échouer les requêtes : l'API reste disponible et toujours limitée.

### 5. Livraisons de webhooks orphelines

La tâche `WEBHOOK_RETRY` tente aussi les livraisons restées `PENDING` (jamais tentées) plus de 5 minutes après leur création — bien au-delà de la durée maximale d'une première tentative (`WEBHOOK_TIMEOUT_MS` ≤ 30 s), si bien qu'une tentative en cours n'est jamais doublée. Le lot est borné (100 orphelines + relances `FAILED` échues, 200 au total) et la boucle s'arrête si le bail est perdu.

### 6. Visibilité

`GET /v1/admin/jobs` renvoie le pilote, l'identifiant de l'instance qui répond, la durée de bail, les baux en cours (propriétaire, acquisition, dernier battement, expiration, état calculé avec l'horloge de la base) et la prochaine échéance de chaque tâche. La console `/admin/jobs` les affiche ; l'historique des exécutions indique l'instance qui a exécuté chaque tâche.

## Modes de défaillance

| Situation                                                       | Comportement                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Arrêt brutal d'une réplique pendant une tâche                   | le bail expire au plus tard après `JOB_LEASE_SECONDS` ; l'exécution suivante (n'importe quelle réplique) reprend le bail et clôt l'exécution abandonnée `FAILED` (« lease expired »). Avec BullMQ, le travail en cours est marqué bloqué puis échoué, sans rejeu.                                                                                                                                      |
| Pause longue (GC, partition réseau) de la réplique propriétaire | si le bail n'a pas pu être renouvelé pendant une période complète, ou dès qu'un renouvellement est refusé, le signal est déclenché et l'exécution close `FAILED` (« lease lost »).                                                                                                                                                                                                                     |
| Fenêtre de double exécution résiduelle                          | un bail n'est pas un jeton d'exclusion absolu : entre la reprise par B et le battement suivant de A (≤ `JOB_LEASE_SECONDS / 3`), A peut encore écrire, plus longtemps si son gestionnaire ignore le signal. D'où l'exigence : **gestionnaires idempotents et bornés par lots**, qui consultent `signal` entre deux lots ; les mouvements comptables restent idempotents et transactionnels (ADR-0002). |
| Base de données indisponible                                    | l'acquisition échoue, rien ne s'exécute ; le planificateur journalise et réessaie à l'échéance suivante.                                                                                                                                                                                                                                                                                               |
| Redis indisponible (pilote `bullmq`)                            | aucune échéance n'est déclenchée tant que Redis est absent (les workers se reconnectent seuls) ; l'API démarre et sert normalement ; les déclenchements manuels fonctionnent (base seulement).                                                                                                                                                                                                         |
| Redis indisponible (limites de débit)                           | repli sur les limites en mémoire par réplique, avertissement dans les journaux.                                                                                                                                                                                                                                                                                                                        |
| Horloges des répliques décalées                                 | sans effet : les baux utilisent l'horloge de PostgreSQL, les fenêtres celle de Redis.                                                                                                                                                                                                                                                                                                                  |
| Tâche retirée du registre                                       | sa planification BullMQ subsiste ; le worker répond « not_registered » sans rien exécuter. Supprimer la planification avec `removeJobScheduler('maintenance-<JOB>')`.                                                                                                                                                                                                                                  |
| Changement de `JOBS_INTERVAL_MINUTES`                           | la mise à jour idempotente (`upsertJobScheduler`) remplace l'intervalle au redémarrage suivant ; toutes les répliques doivent porter la même valeur.                                                                                                                                                                                                                                                   |
| Déploiement progressif depuis la phase 5 (verrous consultatifs) | les anciennes répliques ignorent les baux : désactiver leur planificateur (`JOBS_ENABLED=false`) pendant la bascule, ou déployer toutes les répliques en une fois. La première acquisition close les exécutions `RUNNING` laissées par l'ancienne version.                                                                                                                                             |

## Configuration

### Une seule réplique (défaut, sandbox locale)

```env
JOBS_DRIVER=inprocess
RATE_LIMIT_STORE=memory
# REDIS_URL facultatif ; INSTANCE_ID vaut <hostname>-<pid> par défaut
```

### Plusieurs répliques

```env
JOBS_DRIVER=bullmq
RATE_LIMIT_STORE=redis
REDIS_URL=redis://redis:6379/0
INSTANCE_ID=<nom unique de la réplique, p. ex. le nom du pod>
JOB_LEASE_SECONDS=120          # > plus longue pause attendue d'une réplique
JOBS_INTERVAL_MINUTES=15       # identique sur toutes les répliques
```

- `REDIS_URL` est obligatoire dès que `JOBS_DRIVER=bullmq` ou `RATE_LIMIT_STORE=redis` (validation au démarrage).
- Redis : `maxmemory-policy noeviction` (exigence BullMQ) et persistance AOF recommandées.
- `JOBS_ENABLED=false` sur une réplique : elle n'enregistre aucune planification et ne démarre aucun worker (utile pour une réplique dédiée au trafic) ; les autres continuent d'exécuter les tâches.

## Conséquences

Positives : plus aucune connexion ni transaction longue pendant les tâches ; reprise automatique après un arrêt brutal, avec une trace explicite dans l'historique ; une seule exécution par échéance avec BullMQ ; visibilité en temps réel (baux, battements, instance) dans la console ; quotas et `throttle` cohérents quel que soit le nombre de répliques ; aucune livraison de webhook perdue par un arrêt brutal. Le mode à une réplique reste sans dépendance à Redis.

Négatives : une dépendance d'infrastructure supplémentaire (Redis) en mode multi-répliques ; une fenêtre résiduelle de double exécution (voir ci-dessus) qui impose des gestionnaires idempotents ; une tâche bloquée par une réplique morte attend jusqu'à `JOB_LEASE_SECONDS` ; la fenêtre du `throttle` par IP est fixe en Redis (glissante en mémoire), écart accepté pour une protection anti-abus grossière.

## Alternatives

| Alternative                                                        | Raison du rejet                                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conserver le verrou consultatif dans une transaction de 15 minutes | connexion immobilisée, interruption des tâches longues, aucune trace des exécutions abandonnées, aucune visibilité                                                                  |
| Verrou consultatif de session sur une connexion dédiée             | dépend de la vie d'une connexion particulière (incompatible avec le pool Prisma et les proxys de connexions de type PgBouncer en mode transaction) ; toujours invisible             |
| Verrou Redis seul (Redlock)                                        | ajoute Redis comme dépendance obligatoire même en réplique unique ; la base reste la source de vérité des exécutions, le bail y est visible et transactionnel avec `MaintenanceRun` |
| BullMQ seul, sans bail en base                                     | BullMQ garantit un seul worker par travail, mais pas l'exclusion avec un déclenchement manuel ni avec le pilote `inprocess` ; le bail unifie les deux chemins                       |
| pg-boss / Graphile Worker                                          | nouvelle dépendance et nouveau schéma pour un besoin couvert par une table et BullMQ (déjà présent pour les notifications)                                                          |
| CronJob Kubernetes                                                 | suppose une plateforme d'orchestration précise ; l'API doit rester déployable sur une simple VM pour la sandbox                                                                     |

## Vérification

`apps/api/test/jobs-distributed.test.ts` : deux exécuteurs avec des `INSTANCE_ID` distincts ne s'exécutent jamais en parallèle ; reprise d'un bail expiré et clôture de l'exécution abandonnée ; renouvellement par battement pendant une tâche lente ; perte du bail → signal déclenché et exécution `FAILED`, y compris si le gestionnaire ignore le signal ; libération par le seul propriétaire ; deux instances de l'API avec `JOBS_DRIVER=bullmq` n'enregistrent qu'une planification par tâche et un travail mis en file passe par l'exécuteur sous bail ; quotas par clé partagés entre deux instances ; `lastUsedAt` limité à une écriture par minute ; balayage des livraisons `PENDING` orphelines. `apps/api/test/jobs.test.ts` couvre le pilote `inprocess`.

## Révision

Revoir cette décision avant toute exploitation par un partenaire (volumétrie réelle, durée des tâches, objectif de reprise) et si un orchestrateur de tâches managé est imposé par l'hébergeur.
