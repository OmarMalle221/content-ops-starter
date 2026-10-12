# API Diaspora — guide partenaires (sandbox)

> **Données fictives — Aucun fonds réel.** L’API Diaspora n’existe qu’en mode _sandbox_ : chaque montant,
> solde, vérification et règlement est simulé. Aucune clé « live » n’est délivrée et aucun chemin ne permet de
> convertir des unités fictives en argent réel. Les intégrations décrites ici servent à préparer un futur
> raccordement, pas à opérer des paiements.

- Base de l’API : `http://localhost:4000` (proxy web : `http://localhost:3000/api`)
- Référence interactive : `GET /docs` (Swagger UI) — export [`openapi.json`](./openapi.json)
- Console développeurs : `/developers` dans l’application web (onglets **Clés API**, **Webhooks**, **Journal**)
- Toutes les réponses portent `X-DFN-Mode: sandbox` et `x-dfn-disclaimer`.

## 1. Clés sandbox

Une clé sandbox (« clé secrète ») est rattachée à **une organisation** et créée par un membre détenant la
permission `api:manage` (rôles `OWNER` et `ADMIN` de l’organisation). Elle se gère depuis la console ou avec une
session utilisateur :

| Méthode  | Chemin                                | Effet                                                                       |
| -------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `POST`   | `/v1/api-credentials`                 | Crée une clé ; **la clé en clair est renvoyée une seule fois**              |
| `GET`    | `/v1/api-credentials?organizationId=` | Liste les clés (préfixe seulement), `includeRevoked=true` pour l’historique |
| `GET`    | `/v1/api-credentials/:id`             | Détail d’une clé                                                            |
| `POST`   | `/v1/api-credentials/:id/rotate`      | Génère une clé de remplacement (mêmes scopes) et révoque l’ancienne         |
| `DELETE` | `/v1/api-credentials/:id`             | Révoque la clé (irréversible, effet immédiat)                               |
| `GET`    | `/v1/api-credentials/:id/logs`        | Journal des requêtes de la clé (paginé)                                     |
| `GET`    | `/v1/api-credentials/catalog`         | Catalogue des scopes et des événements webhook                              |

Corps de création (`createApiCredentialSchema`) :

```json
{
  "organizationId": "…",
  "name": "Intégration ERP",
  "description": "Synchronisation des commandes",
  "scopes": ["transactions:read", "transactions:write"],
  "rateLimitPerMinute": 120,
  "expiresInDays": 90
}
```

Réponse (`201`) :

```json
{
  "key": "dfn_sk_k7p2m9qa_<43 caractères base64url>",
  "credential": {
    "id": "…",
    "keyPrefix": "k7p2m9qa",
    "keyDisplay": "dfn_sk_k7p2m9qa_••••••••••••",
    "status": "ACTIVE",
    "…": "…"
  },
  "sandbox": true
}
```

- Format : `dfn_sk_<préfixe 8 caractères>_<32 octets aléatoires, base64url>`. Seuls le préfixe et un condensé
  SHA-256 sont stockés : une clé perdue ne peut pas être récupérée, seulement renouvelée.
- `status` vaut `ACTIVE`, `EXPIRED` (date `expiresAt` dépassée) ou `REVOKED`.
- Les clés **ne peuvent pas** gérer d’autres clés (`/v1/api-credentials` est fermé aux clés, 403), ni accéder aux
  routes d’authentification, d’administration ou aux simulateurs.
- Chaque création, rotation et révocation est journalisée (`AuditLog`) et notifiée à la personne qui l’a effectuée.

## 2. Authentification

```http
GET /v1/transactions HTTP/1.1
Authorization: Bearer dfn_sk_k7p2m9qa_…
```

Le jeton est reconnu comme clé sandbox dès qu’il commence par `dfn_sk_`. Le contexte d’exécution est alors :

- **utilisateur** : la personne qui a créé la clé (une clé dont le créateur est désactivé ou supprimé est refusée) ;
- **organisation** : uniquement celle de la clé, avec le rôle `MEMBER` — quels que soient les rôles réels du créateur ;
- `globalRole` toujours `USER` : une clé n’hérite jamais des droits d’un membre de l’équipe DFN.

Refus (`401`) : `API_KEY_INVALID` (inconnue ou organisation supprimée), `API_KEY_REVOKED`, `API_KEY_EXPIRED`.
Une clé invalide est refusée même sur les routes publiques.

## 3. Scopes

Le scope requis est déduit de la méthode et du chemin. Une clé sans le scope reçoit `403 SCOPE_FORBIDDEN`
(`details.requiredScope` indique le scope manquant). Les routes absentes de ce tableau sont fermées aux clés (403).

| Scope                | Accès                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `transactions:read`  | `GET /v1/transactions*`, `GET /v1/invitations*`, `GET /v1/documents*`, `GET /v1/disputes*`                      |
| `transactions:write` | `POST /v1/transactions*` (création, acceptation des conditions, financement, jalons…), `POST /v1/invitations/*` |
| `documents:write`    | `POST /v1/documents`, `POST /v1/transactions/:id/documents`                                                     |
| `disputes:write`     | `POST /v1/transactions/:id/disputes`, `POST /v1/transactions/:id/refund-request`, `POST /v1/disputes/*`         |
| `wallets:read`       | `GET /v1/wallets*`, `POST /v1/wallets/estimate` (estimation FX, lecture seule)                                  |
| `transfers:read`     | `GET /v1/transfers*`, `GET /v1/beneficiaries*`                                                                  |
| `transfers:write`    | `POST/PATCH/DELETE /v1/transfers*`, `POST/PATCH/DELETE /v1/beneficiaries*`                                      |
| `invoices:read`      | `GET /v1/invoices*`, `GET /v1/quotes*`                                                                          |
| `invoices:write`     | `POST/PATCH/DELETE /v1/invoices*`, `POST/PATCH/DELETE /v1/quotes*`                                              |
| `webhooks:manage`    | `/v1/webhooks*` (abonnements de l’organisation de la clé uniquement)                                            |
| _(aucun)_            | `GET /v1/reference`, `GET /v1/health` : ouverts à toute clé valide                                              |

Fermés aux clés quel que soit le scope : `/v1/auth/*`, `/v1/users/*`, `/v1/organizations/*`, `/v1/admin/*`,
`/v1/sandbox/*`, `/v1/api-credentials/*`, `/v1/notifications/*`, `/v1/verifications/*`.

## 4. Limites de débit

Chaque clé possède sa propre limite `rateLimitPerMinute` (10 à 1000, défaut 120), appliquée par **fenêtre glissante
d’une minute** et par clé (deux clés d’une même organisation ne se pénalisent pas).

| En-tête                 | Signification                                          |
| ----------------------- | ------------------------------------------------------ |
| `X-RateLimit-Limit`     | Quota par minute de la clé                             |
| `X-RateLimit-Remaining` | Requêtes restantes dans la fenêtre courante            |
| `Retry-After`           | Secondes à attendre (seulement sur `429 RATE_LIMITED`) |

Les requêtes refusées (401, 403, 429) comptent dans le journal mais les 429 ne consomment pas de quota
supplémentaire. En sandbox, les compteurs sont tenus en mémoire par instance d’API (une seule instance) ; la version
de production les partagera via Redis.

## 5. Idempotence

Pour toute requête `POST`, `PATCH`, `PUT` ou `DELETE`, envoyez un en-tête `Idempotency-Key` (8 à 128 caractères,
unique par opération côté partenaire, p. ex. votre numéro de commande) :

```http
POST /v1/transactions HTTP/1.1
Authorization: Bearer dfn_sk_…
Idempotency-Key: commande-2026-0001
Content-Type: application/json
```

Sémantique (portée : la clé API, ou l’utilisateur pour une session) :

| Situation                                                       | Réponse                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------- |
| Première requête                                                | Traitée normalement ; la réponse 2xx est mémorisée             |
| Même clé + même requête (méthode, chemin, corps JSON canonique) | Réponse mémorisée rejouée, en-tête `Idempotent-Replayed: true` |
| Même clé + requête différente                                   | `422 IDEMPOTENCY_KEY_REUSED`                                   |
| Même clé pendant que la première requête est encore en cours    | `409 IDEMPOTENCY_IN_PROGRESS` (réessayez après un court délai) |
| En-tête invalide (trop court / trop long)                       | `400 VALIDATION_FAILED`                                        |
| Première requête en erreur (4xx/5xx)                            | Rien n’est mémorisé : la même clé peut être réutilisée         |

Les enregistrements expirent après `IDEMPOTENCY_TTL_HOURS` (24 h par défaut) et sont purgés par la tâche
`WEBHOOK_RETRY`. Le corps est comparé après tri des clés JSON : l’ordre des champs n’a pas d’importance.

## 6. Format des erreurs

```json
{
  "statusCode": 403,
  "code": "SCOPE_FORBIDDEN",
  "message": "This API key lacks the \"transactions:write\" scope",
  "details": { "requiredScope": "transactions:write", "scopes": ["transactions:read"] },
  "requestId": "…"
}
```

| Code                      | HTTP | Quand                                                                              |
| ------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `API_KEY_INVALID`         | 401  | Clé inconnue, mal formée, créateur inactif ou organisation supprimée               |
| `API_KEY_REVOKED`         | 401  | Clé révoquée ou remplacée par rotation                                             |
| `API_KEY_EXPIRED`         | 401  | `expiresAt` dépassé                                                                |
| `SCOPE_FORBIDDEN`         | 403  | Scope manquant ou route fermée aux clés                                            |
| `RATE_LIMITED`            | 429  | Quota par minute dépassé (voir `Retry-After`)                                      |
| `IDEMPOTENCY_KEY_REUSED`  | 422  | Même `Idempotency-Key`, requête différente                                         |
| `IDEMPOTENCY_IN_PROGRESS` | 409  | Doublon concurrent d’une requête encore en cours                                   |
| `WEBHOOK_URL_FORBIDDEN`   | 422  | URL de webhook vers un hôte local/privé ou avec identifiants intégrés              |
| `NOT_FOUND`               | 404  | Ressource inexistante **ou appartenant à une autre organisation**                  |
| `INVALID_TRANSITION`      | 409  | Action impossible dans l’état courant (p. ex. réessayer une livraison déjà livrée) |

Les codes généraux (`VALIDATION_FAILED`, `FORBIDDEN`, `CONFLICT`, `INSUFFICIENT_FUNDS`…) sont décrits dans
[README.md](./README.md).

## 7. Webhooks

### Gestion

Avec une session (`api:manage`) ou une clé portant `webhooks:manage` :

| Méthode  | Chemin                                          | Effet                                                                      |
| -------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `POST`   | `/v1/webhooks`                                  | Crée un abonnement ; **le secret de signature est renvoyé une seule fois** |
| `GET`    | `/v1/webhooks?organizationId=`                  | Liste (`includeRevoked=true` pour les abonnements supprimés)               |
| `GET`    | `/v1/webhooks/:id`                              | Détail                                                                     |
| `PATCH`  | `/v1/webhooks/:id`                              | Modifie `url`, `description`, `events`, `isActive`                         |
| `DELETE` | `/v1/webhooks/:id`                              | Suppression logique (historique conservé)                                  |
| `POST`   | `/v1/webhooks/:id/rotate-secret`                | Nouveau secret (renvoyé une seule fois)                                    |
| `POST`   | `/v1/webhooks/:id/test`                         | Envoie immédiatement un événement fictif `{ "eventType": "…" }`            |
| `GET`    | `/v1/webhooks/:id/deliveries?status=&page=`     | Livraisons (paginé)                                                        |
| `POST`   | `/v1/webhooks/:id/deliveries/:deliveryId/retry` | Nouvelle tentative immédiate d’une livraison `FAILED`/`EXHAUSTED`          |

Corps de création :

```json
{
  "organizationId": "…",
  "url": "https://partner.example/webhooks/dfn",
  "description": "ERP",
  "events": ["transaction.created", "transaction.settled"]
}
```

Contraintes sur l’URL (`WEBHOOK_URL_FORBIDDEN`) : `http(s)` uniquement, sans identifiants intégrés, et jamais vers
`localhost`, `*.local`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`,
`100.64.0.0/10`, `::1` ni les adresses IPv6 locales. Le secret est chiffré au repos (AES-256-GCM) et n’apparaît
dans aucune réponse de lecture.

### Événements

| Type                         | Déclencheur                                             |
| ---------------------------- | ------------------------------------------------------- |
| `transaction.created`        | Transaction Protect créée                               |
| `transaction.party_accepted` | Le vendeur a accepté l’invitation                       |
| `funding.confirmed`          | Le partenaire simulé a confirmé le financement (fictif) |
| `milestone.submitted`        | Preuves soumises pour un jalon                          |
| `milestone.released`         | Fonds (fictifs) libérés pour un jalon                   |
| `transaction.settled`        | Transaction clôturée                                    |
| `transaction.cancelled`      | Transaction annulée                                     |
| `dispute.opened`             | Litige ouvert                                           |
| `dispute.closed`             | Litige clos                                             |
| `transfer.settled`           | Transfert simulé réglé                                  |
| `transfer.failed`            | Transfert simulé échoué                                 |
| `invoice.paid`               | Facture marquée payée (fictif)                          |

Un événement est envoyé aux abonnements **actifs** de chaque organisation concernée (acheteur et vendeur pour une
transaction) qui ont souscrit à ce type.

### Enveloppe

```json
{
  "id": "6c2f…",
  "type": "transaction.created",
  "createdAt": "2026-10-11T14:03:12.000Z",
  "sandbox": true,
  "data": {
    "entityType": "Transaction",
    "entityId": "…",
    "transactionId": "…",
    "reference": "DFN-2026-000123",
    "status": "PENDING_ACCEPTANCE",
    "actorUserId": "…",
    "eventId": "…"
  }
}
```

`sandbox` vaut **toujours** `true`. `data` contient les identifiants et le statut ; rechargez la ressource par l’API
pour obtenir son état complet (ne considérez jamais le contenu d’un webhook comme faisant foi).

### En-têtes et signature

| En-tête           | Contenu                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `Content-Type`    | `application/json`                                                                  |
| `X-DFN-Event`     | Type de l’événement                                                                 |
| `X-DFN-Delivery`  | Identifiant de la livraison, identique pour chaque tentative : clé de déduplication |
| `X-DFN-Signature` | `t=<secondes Unix>,v1=<HMAC-SHA256 hexadécimal>`                                    |
| `X-DFN-Mode`      | `sandbox`                                                                           |
| `User-Agent`      | `DFN-Webhooks/1.0 (sandbox)`                                                        |

**Livraison « au moins une fois »** : une même livraison peut arriver plus d'une fois (relance après un délai dépassé, ou reprise après l'arrêt de la plateforme pendant un envoi). Traitez les événements de façon idempotente en mémorisant `X-DFN-Delivery`. Deux envois **simultanés** d'une même livraison n'ont jamais lieu : chaque tentative réserve la livraison avant l'envoi.

`v1 = HMAC_SHA256(secret, "<t>.<corps brut>")`. Vérifiez la signature **sur le corps brut** (avant tout parsing),
en comparaison à temps constant, et rejetez les horodatages trop anciens (5 minutes est une tolérance raisonnable).

Node.js :

```js
const { createHmac, timingSafeEqual } = require('node:crypto');

function verifyDfnSignature(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const { t, v1 } = parts;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express : app.post('/webhooks/dfn', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyDfnSignature(process.env.DFN_WEBHOOK_SECRET, req.get('X-DFN-Signature'), req.body.toString('utf8'))) return res.sendStatus(401);
//   const event = JSON.parse(req.body); /* traiter de façon idempotente avec event.id */ res.sendStatus(200);
// });
```

Python :

```python
import hmac, hashlib, time

def verify_dfn_signature(secret: str, header: str, raw_body: bytes, tolerance_seconds: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False
    if abs(time.time() - int(t)) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)

# Flask : verify_dfn_signature(os.environ["DFN_WEBHOOK_SECRET"], request.headers["X-DFN-Signature"], request.get_data())
```

Le même algorithme est exposé par `verifySignature(secret, t, rawBody, v1)` dans `@dfn/payment-adapters`.

### Politique de nouvelles tentatives

- Répondez `2xx` en moins de `WEBHOOK_TIMEOUT_MS` (5 s par défaut) ; tout autre code, un délai dépassé ou une
  erreur réseau marque la livraison `FAILED`.
- Nouvelle tentative après `2^n` minutes (`n` = nombre de tentatives : 2, 4, 8, 16, 32 min…), exécutée par la tâche
  planifiée `WEBHOOK_RETRY`, jusqu’à `WEBHOOK_MAX_ATTEMPTS` (6 par défaut) → `EXHAUSTED`.
- Chaque échec incrémente `failureCount` de l’abonnement ; une livraison réussie le remet à zéro. Après **50 échecs
  consécutifs**, l’abonnement est désactivé automatiquement (`isActive: false`) ; réactivez-le par `PATCH` une fois
  votre serveur rétabli.
- Une livraison `FAILED` ou `EXHAUSTED` peut être rejouée manuellement à tout moment (`…/retry`, console :
  bouton **Réessayer**).
- Traitez les événements de façon idempotente avec `id` : une même livraison peut vous parvenir plusieurs fois
  (p. ex. réponse 2xx perdue sur le réseau).

## 8. Journal des requêtes

Chaque requête authentifiée par une clé (y compris les refus 401/403/429) crée une entrée `ApiRequestLog` :
méthode, chemin (sans query string), code HTTP, durée, adresse IP et identifiant de requête. Consultation :
`GET /v1/api-credentials/:id/logs?page=1&pageSize=20` ou onglet **Journal** de la console. Les corps de requête
et de réponse ne sont jamais journalisés. `lastUsedAt` de la clé est actualisé au plus une fois par minute.

## 9. Simulateurs sandbox

Pour dérouler un scénario de bout en bout sans partenaire réel :

| Simulateur                                 | Accès                                | Effet                                                                                 |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `POST /v1/sandbox/partner/funding-events`  | Session (acheteur de la transaction) | Simule la confirmation de financement du partenaire → `funding.confirmed`             |
| `POST /v1/sandbox/wallets/self-deposit`    | Session (`wallet:read`)              | Crédite des unités fictives dans le portefeuille (plafond quotidien)                  |
| `POST /v1/sandbox/partner/transfer-events` | Session                              | Simule le règlement / l’échec d’un transfert → `transfer.settled` / `transfer.failed` |
| `POST /v1/webhooks/:id/test`               | Session ou clé `webhooks:manage`     | Envoie un événement de test signé                                                     |

Ces simulateurs sont réservés aux sessions utilisateur : une clé API ne peut pas les appeler (403), afin qu’aucune
intégration ne confonde une simulation déclenchée par elle-même avec un événement réel.

## 10. Isolation des organisations

- Une clé ne voit **que** les données de son organisation. Un identifiant appartenant à une autre organisation
  renvoie `404 NOT_FOUND`, jamais `403`, pour ne révéler ni son existence ni son propriétaire.
- Les abonnements webhook et les livraisons sont eux aussi cloisonnés par organisation ; une clé `webhooks:manage`
  ne peut créer d’abonnement que pour sa propre organisation (`organizationId` différent → 404).
- Les enregistrements d’idempotence sont cloisonnés par clé : deux clés peuvent utiliser la même valeur
  d’`Idempotency-Key` sans interférence.

## 11. Ce qui n’est PAS disponible

- **Aucun mode live** : pas de clés `dfn_live_…`, pas d’argent réel, pas de rapprochement bancaire. Les webhooks
  portent `sandbox: true` et `X-DFN-Mode: sandbox` sans exception.
- Pas de conversion d’unités fictives en monnaie réelle, pas de retrait vers un compte bancaire réel.
- Pas d’OAuth ni de clés déléguées par utilisateur final : une clé agit toujours au nom de son créateur.
- Pas de gestion de clés ou d’organisations par l’API elle-même (création de clés, invitations de membres,
  vérifications KYC/KYB) : ces opérations passent par la console.
- Pas de garantie de livraison stricte ni d’ordre des webhooks : traitez-les comme des notifications et relisez la
  ressource par l’API.
- Les quotas sont tenus en mémoire (instance unique) ; le comportement multi-instances n’est pas défini en sandbox.
