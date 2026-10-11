# Sécurité

La politique de sécurité complète est dans [`../../SECURITY.md`](../../SECURITY.md) (modèle de menaces, authentification, autorisation, chiffrement, journalisation, tests, risques résiduels).

Points de contrôle rapides :

- `DFN_MODE=sandbox` obligatoire (`apps/api/src/config/env.ts`).
- Sessions : `apps/api/src/modules/auth/session.service.ts` ; MFA : `auth.service.ts`.
- RBAC : `packages/shared/src/permissions.ts`, `apps/api/src/common/guards/`.
- CSRF : `apps/api/src/common/middleware/origin-check.middleware.ts` + cookies `SameSite=Lax`.
- Documents : `apps/api/src/modules/documents/` (MIME + magic bytes, AES-256-GCM).
- Journalisation : redaction pino dans `apps/api/src/app.module.ts`, `AuditService`.
