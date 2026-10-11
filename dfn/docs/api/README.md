# API Diaspora Trust — sandbox

- Base : `http://localhost:4000` (proxy web : `http://localhost:3000/api`)
- Documentation interactive : `GET /docs` (Swagger UI) — export : [`openapi.json`](./openapi.json) (`pnpm --filter @dfn/api openapi:export`)
- Toutes les réponses portent `x-dfn-mode: sandbox` et `x-dfn-disclaimer`.

## Authentification

Session serveur dans un cookie `dfn_session` (httpOnly, SameSite=Lax). Obtenir une session : `POST /v1/auth/register` ou `POST /v1/auth/login`. Si `mfaRequired` est vrai, appeler `POST /v1/auth/mfa/verify`. Un en-tête `Authorization: Bearer <token>` est également accepté pour les tests.

## Format d'erreur

```json
{
  "statusCode": 409,
  "code": "RELEASE_FROZEN",
  "message": "A dispute is open: releases are frozen",
  "details": {},
  "requestId": "…"
}
```

Codes : `VALIDATION_FAILED`, `UNAUTHENTICATED`, `MFA_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_TRANSITION`, `RELEASE_FROZEN`, `INSUFFICIENT_FUNDS`, `LEDGER_UNBALANCED`, `RATE_LIMITED`, `ACCOUNT_LOCKED`, `INVITATION_INVALID`, `VERIFICATION_REQUIRED`, `UNSUPPORTED_FILE`.

## Montants

Entrée : chaînes décimales (`"18500.00"`). Sortie : `{ "minor": "1850000", "decimal": "18500.00", "currency": "CAD" }`.

## Principaux groupes d'endpoints

| Groupe             | Endpoints                                                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth               | `POST /v1/auth/{register,login,logout,password}`, `GET /v1/auth/me`, `POST /v1/auth/mfa/{setup,enable,verify,disable}`, `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke-others`                                                                                                       |
| users              | `GET/PATCH /v1/users/me`                                                                                                                                                                                                                                                                      |
| organizations      | `GET/POST /v1/organizations`, `GET /v1/organizations/:id`, `POST …/members/invite`, `PATCH/DELETE …/members/:memberId`, `POST /v1/organizations/invitations/accept`, `POST …/verification`, `GET/POST …/counterparties`                                                                       |
| verifications      | `GET/POST /v1/verifications/identity`                                                                                                                                                                                                                                                         |
| transactions       | `GET/POST /v1/transactions`, `GET /v1/transactions/:id`, `GET …/events`, `POST …/invitation/resend`, `POST …/accept-terms`, `POST …/cancel`, `POST …/funding/request`, `POST …/milestones/:mid/{submit,approve,request-changes}`                                                              |
| invitations        | `GET /v1/invitations/:token` (public), `POST /v1/invitations/{accept,decline}`                                                                                                                                                                                                                |
| documents          | `POST /v1/documents`, `POST /v1/transactions/:id/documents` (multipart `file`), `GET /v1/documents`, `GET /v1/transactions/:id/documents`, `GET /v1/documents/:id/download`, `POST /v1/documents/:id/review` (staff), `DELETE /v1/documents/:id`                                              |
| disputes           | `POST /v1/transactions/:id/disputes`, `POST /v1/transactions/:id/refund-request`, `GET /v1/disputes`, `GET /v1/disputes/:id`, `POST …/messages`, `POST …/appeal`, staff : `POST …/{review,decide,close}`                                                                                      |
| wallets            | `GET /v1/wallets/:organizationId`, `GET …/:currency/entries`, `GET …/:currency/statement.csv`                                                                                                                                                                                                 |
| notifications      | `GET /v1/notifications`, `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all`                                                                                                                                                                                                 |
| admin (staff)      | `GET /v1/admin/{stats,users,verifications,risk-alerts,audit-logs,ledger,transactions}`, `POST /v1/admin/users/:id/{status,role}`, `POST /v1/admin/verifications/:id/review`, `POST /v1/admin/risk-alerts/:id/actions`, `POST /v1/admin/ledger/reconcile`, `POST /v1/admin/maintenance/expire` |
| sandbox            | `POST /v1/sandbox/partner/funding-events` (simule le webhook du partenaire), `POST /v1/sandbox/wallets/deposit` (staff)                                                                                                                                                                       |
| reference / health | `GET /v1/reference`, `GET /v1/health`                                                                                                                                                                                                                                                         |

## Module E (phase 5) — préparé, non exposé

Les tables `ApiCredential` et `WebhookSubscription` existent ; la signature HMAC des webhooks est implémentée dans `@dfn/payment-adapters` (`signPayload` / `verifySignature`). Les clés API, scopes, idempotency keys et quotas par client seront ajoutés avec l'API partenaires.
