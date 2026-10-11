# Diaspora Financial Network — Sécurité dès la conception

> Mode : `sandbox` uniquement — « Données fictives — Aucun fonds réel ».  
> Ce document décrit les mesures de sécurité implémentées dans les Phases 1–2, les risques résiduels et les évolutions prévues. Il complète `PRODUCT_REQUIREMENTS.md` et les ADR (`docs/decisions/`). Signalement d'une vulnérabilité : voir §16.

---

## 1. Périmètre et hypothèses

- Composants : application web Next.js (`apps/web`), API NestJS (`apps/api`), PostgreSQL (Prisma), Redis (BullMQ, limitation de débit), stockage de documents chiffrés (`STORAGE_DIR`, adaptateur S3 prévu).
- Aucune donnée financière réelle : les valeurs monétaires sont fictives. Les données personnelles (noms, e-mails, pièces d'identité téléversées en démonstration) sont en revanche réelles pour les testeurs et traitées comme telles.
- Hypothèse de confiance : la base de données et Redis ne sont pas exposés publiquement ; les secrets viennent de l'environnement, jamais du dépôt.

## 2. Modèle de menaces (STRIDE)

| Catégorie                  | Menace                                                                                                           | Actif visé                      | Contrôles                                                                                                                           | Référence              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **S**poofing               | Vol de session, bourrage d'identifiants, usurpation de l'autre partie d'une transaction                          | Comptes, transactions           | argon2id, verrouillage progressif, MFA TOTP, cookies httpOnly, jetons d'invitation hachés à usage unique avec expiration            | §3                     |
| **T**ampering              | Modification d'un montant, d'un contrat accepté, d'une écriture comptable, d'un document de preuve               | Registre, contrats, documents   | Écritures immuables + contre-passations, `contentHash` des contrats, SHA-256 des fichiers, validation zod stricte, machines à états | §9, ADR-0002, ADR-0007 |
| **R**epudiation            | Une partie nie avoir accepté le contrat ou approuvé un jalon                                                     | Preuve contractuelle            | `ContractAcceptance` (IP, user-agent, horodatage), `TransactionEvent`, `AuditLog`                                                   | §10                    |
| **I**nformation disclosure | Accès inter-organisations, fuite de pièces d'identité, secrets dans les logs                                     | Données personnelles, documents | Isolation par organisation (404), chiffrement AES-256-GCM, téléchargements contrôlés, redaction pino                                | §4, §7, §9             |
| **D**enial of service      | Rafales de connexions, téléversements massifs, rejeu de webhooks                                                 | API, stockage, files            | Throttler, taille max 15 Mo, idempotence, expiration des demandes                                                                   | §8                     |
| **E**levation of privilege | Un `VIEWER` crée une transaction ; un utilisateur appelle une route d'administration ; contournement côté client | RBAC                            | Gardes serveur sur chaque route, matrice unique en code, double rôle (global + organisation)                                        | §4, ADR-0005           |
| Spécifique fintech         | Double libération concurrente d'un même séquestre, solde négatif                                                 | Registre                        | `SELECT … FOR UPDATE` ordonné, projection des soldes, clé d'idempotence unique                                                      | ADR-0002               |
| Spécifique sandbox         | Confusion entre données simulées et réelles ; activation accidentelle d'un adaptateur live                       | Confiance utilisateur, légalité | Garde `DFN_MODE`, bandeau permanent, statuts `SIMULATED_*`, registres de fournisseurs qui refusent tout code non sandbox            | §15, ADR-0003          |

## 3. Authentification

| Mesure                    | Implémentation                                                                                                                                                                                                                                                            | Paramètres                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Hachage des mots de passe | `argon2id` (bibliothèque `argon2`) ; jamais de hachage réversible                                                                                                                                                                                                         | Coûts mémoire/temps par défaut de la bibliothèque, revus annuellement |
| Politique de mot de passe | ≥ 12 caractères, minuscule + majuscule + chiffre, max 128 (`passwordSchema`)                                                                                                                                                                                              | Vérification côté serveur ; le client n'est qu'une aide               |
| Sessions                  | Jeton aléatoire envoyé au navigateur, **seul son hachage** est stocké (`Session.tokenHash`) ; `expiresAt`, `revokedAt`, `lastSeenAt`, IP et user-agent                                                                                                                    | `SESSION_TTL_HOURS=12`, `SESSION_COOKIE_NAME=dfn_session`             |
| Cookie                    | `httpOnly`, `SameSite=Lax`, `Secure` dès que `COOKIE_SECURE=true` (obligatoire hors développement), chemin `/`                                                                                                                                                            | Aucun jeton dans `localStorage` ni dans l'URL                         |
| Verrouillage              | `failedLoginCount` incrémenté à chaque échec ; au-delà du seuil (5 par défaut), `lockedUntil` est fixé (15 min par défaut) ; réponse `ACCOUNT_LOCKED` ; remise à zéro après succès                                                                                        | Alimente la règle de risque `REPEATED_LOGIN_FAILURES`                 |
| MFA                       | TOTP (RFC 6238, `otplib`), codes à 6 chiffres, secret chiffré AES-256-GCM avec `DOCUMENT_ENCRYPTION_KEY` (`User.mfaSecretEnc`) ; `Session.mfaVerified` passe à `true` après vérification ; routes sensibles répondent `MFA_REQUIRED` tant que la session n'est pas élevée | Obligatoire pour `ADMIN` et `COMPLIANCE`, recommandée pour tous       |
| Déconnexion               | Révocation serveur (`revokedAt`), pas seulement suppression du cookie ; révocation de toutes les sessions au changement de mot de passe                                                                                                                                   | —                                                                     |
| Évolution                 | Passkeys / WebAuthn (Phase 3), codes de récupération MFA chiffrés, détection d'appareil inconnu                                                                                                                                                                           | `ROADMAP.md`                                                          |

## 4. Autorisation côté serveur

- **Source unique** : `packages/shared/src/permissions.ts`. L'interface web n'utilise la matrice que pour masquer des contrôles ; elle n'est jamais une frontière de sécurité.
- Chaque gestionnaire de route déclare la permission requise ; une garde NestJS évalue le rôle global (`User.globalRole`) **et** le rôle dans l'organisation ciblée (`OrganizationMember.role`).

### Matrice RBAC

| Permission                 | OWNER | ADMIN (org) | MEMBER | VIEWER | COMPLIANCE | ADMIN (global) |
| -------------------------- | :---: | :---------: | :----: | :----: | :--------: | :------------: |
| `transaction:create`       |  ✔   |     ✔      |   ✔   |   –    |     –      |       –        |
| `transaction:read`         |  ✔   |     ✔      |   ✔   |   ✔   |     –      |       –        |
| `transaction:manage`       |  ✔   |     ✔      |   ✔   |   –    |     –      |       –        |
| `document:upload`          |  ✔   |     ✔      |   ✔   |   –    |     –      |       –        |
| `dispute:open`             |  ✔   |     ✔      |   ✔   |   –    |     –      |       –        |
| `org:manage_members`       |  ✔   |     ✔      |   –    |   –    |     –      |       –        |
| `org:manage_settings`      |  ✔   |      –      |   –    |   –    |     –      |       –        |
| `org:view_reports`         |  ✔   |     ✔      |   –    |   ✔   |     –      |       –        |
| `wallet:read`              |  ✔   |     ✔      |   ✔   |   ✔   |     –      |       –        |
| `admin:users`              |   –   |      –      |   –    |   –    |     –      |       ✔       |
| `admin:verifications`      |   –   |      –      |   –    |   –    |     ✔     |       ✔       |
| `admin:disputes`           |   –   |      –      |   –    |   –    |     ✔     |       ✔       |
| `admin:risk`               |   –   |      –      |   –    |   –    |     ✔     |       ✔       |
| `admin:ledger`             |   –   |      –      |   –    |   –    |     ✔     |       ✔       |
| `admin:audit`              |   –   |      –      |   –    |   –    |     ✔     |       ✔       |
| `sandbox:partner_simulate` |   –   |      –      |   –    |   –    |     –      |       ✔       |

Règles complémentaires :

- **Isolation multi-organisation** : toute requête est filtrée par les organisations dont l'utilisateur est membre (ou par sa qualité de partie à la transaction). Un accès à une ressource d'une autre organisation renvoie **`404 NOT_FOUND`, jamais `403`**, pour ne pas révéler l'existence de la ressource.
- Le personnel (`isStaff`) n'a aucune permission d'organisation implicite : un agent de conformité lit les transactions via `admin:*`, journalisé, et ne peut pas agir au nom d'une partie.
- Les notes internes de litige (`DisputeMessage.internal = true`) sont filtrées côté serveur pour les parties.
- Les tables `Role` / `Permission` en base sont différées (ADR-0005) : la matrice évolue par revue de code et tests.

## 5. CSRF

- Cookies `SameSite=Lax` : les requêtes de mutation inter-sites ne portent pas le cookie.
- Vérification de l'en-tête `Origin` (repli `Referer`) sur toute méthode non sûre : seuls les `CORS_ORIGINS` configurés sont acceptés ; sinon `403`.
- Aucune mutation par `GET`. Les webhooks du partenaire sandbox n'utilisent pas de cookie mais une signature HMAC avec horodatage.

## 6. XSS et en-têtes de sécurité

- Rendu React : échappement par défaut ; `dangerouslySetInnerHTML` interdit par lint.
- `helmet` sur l'API : Content-Security-Policy restrictive, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, HSTS dès `COOKIE_SECURE=true`.
- Le corps des contrats (`bodyText`) et les messages de litige sont rendus en texte brut.
- Les documents téléversés ne sont jamais servis inline avec leur type d'origine : `Content-Disposition: attachment` et type contrôlé.

## 7. Téléversement et stockage des documents

| Contrôle             | Détail                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist MIME       | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` (extensible par revue)                                                                              |
| Taille               | `MAX_UPLOAD_MB=15` appliquée par `multer` avant lecture complète                                                                                               |
| Magic bytes          | Le type réel est vérifié sur les premiers octets ; un `.exe` renommé `.pdf` est rejeté (`UNSUPPORTED_FILE`)                                                    |
| Intégrité            | `Document.sha256` calculé à la réception ; réutilisé par la règle de risque `DOCUMENT_REUSE`                                                                   |
| Chiffrement au repos | AES-256-GCM, clé `DOCUMENT_ENCRYPTION_KEY` (32 octets hex), IV aléatoire par fichier, tag d'authentification stocké avec le blob ; `Document.encrypted = true` |
| Nom de stockage      | `storageKey` opaque (UUID), jamais le nom d'origine ; le nom d'origine est nettoyé et stocké en base uniquement                                                |
| Téléchargement       | Route authentifiée qui revérifie l'appartenance à l'organisation ou la qualité de partie ; flux déchiffré en mémoire ; journalisé                              |
| Suppression          | Logique (`deletedAt`), rétention pilotée par `retentionUntil` (`DATA_PROTECTION.md`)                                                                           |
| Évolution            | Stockage objet S3-compatible avec chiffrement côté serveur + KMS, antivirus en file BullMQ                                                                     |

## 8. Limitation de débit et anti-abus

- `@nestjs/throttler` adossé à Redis (repli mémoire) : limites plus strictes sur `/auth/*` (connexion, inscription, MFA), sur les téléversements et sur le webhook sandbox.
- Réponse `429 RATE_LIMITED` avec `Retry-After`.
- Expiration automatique des invitations et des demandes de financement ; jetons d'invitation à usage unique.
- Idempotence : `LedgerTransaction.idempotencyKey`, `ProviderEvent.idempotencyKey` (uniques) ; un rejeu renvoie le résultat initial sans effet.

## 9. Journalisation structurée sans données sensibles

- `pino` / `nestjs-pino`, un `requestId` par requête propagé dans les erreurs API (`ApiErrorBody.requestId`).
- Redaction configurée sur : `password`, `currentPassword`, `newPassword`, `code` (TOTP), `authorization`, `cookie`, `set-cookie`, `token`, `mfaSecretEnc`, `secretEnc`, `keyHash`, contenu des documents, `declaredData.dateOfBirth`.
- Aucune donnée de pièce d'identité n'est journalisée ; `IdentityVerification.declaredData` ne contient que le type de document et le pays émetteur.
- Niveau par défaut `info` ; `debug` interdit en recette partagée.

## 10. Piste d'audit

- `AuditLog` : acteur, organisation, action, type et identifiant d'entité, IP, user-agent, métadonnées ; indexé par entité, acteur, organisation et date.
- `TransactionEvent` : historique métier immuable de chaque transaction (`TransactionEventType`).
- `RiskAlertAction`, `DisputeDecision`, `DisputeMessage`, `ContractAcceptance` : décisions et consentements horodatés, jamais modifiés.
- Les lignes d'audit ne sont ni modifiables ni supprimables par l'application ; la purge suit la politique de rétention et se fait par anonymisation.

## 11. Gestion des secrets

- Variables d'environnement uniquement (`.env` ignoré par git ; `.env.example` sans valeur réelle).
- Secrets critiques : `SESSION_SECRET`, `DOCUMENT_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`, futurs `KYC_PROVIDER_API_KEY`, `SANCTIONS_PROVIDER_API_KEY`, `SMTP_URL`.
- L'API refuse de démarrer si `SESSION_SECRET` ou `DOCUMENT_ENCRYPTION_KEY` conservent leur valeur d'exemple hors `NODE_ENV=development`.
- Rotation : procédure documentée (double clé pendant la transition pour le chiffrement des documents : déchiffrement avec l'ancienne, chiffrement avec la nouvelle, re-chiffrement en tâche de fond).
- Secrets des webhooks (`WebhookSubscription.secretEnc`) et des clés API (`keyHash`) : jamais stockés en clair.

## 12. Sauvegardes et restauration

| Élément              | Politique                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL           | Sauvegarde complète quotidienne + archivage WAL (PITR) ; chiffrées ; rétention 30 jours en sandbox                                                                             |
| Documents            | Snapshot quotidien du stockage, chiffré ; les clés de chiffrement sont sauvegardées séparément                                                                                 |
| Redis                | Non critique (files rejouables) ; `AOF` activé en recette                                                                                                                      |
| Test de restauration | Trimestriel, sur un environnement isolé, avec exécution de `LedgerService.reconcile()` après restauration : débits globaux = crédits globaux, aucune transaction déséquilibrée |
| Documentation        | Runbook de restauration avec RPO 24 h / RTO 8 h (sandbox) ; cibles à réviser avant toute phase live                                                                            |

## 13. Dépendances et analyse statique

- `pnpm audit` à chaque CI ; blocage sur vulnérabilités hautes/critiques sans correctif documenté.
- Versions épinglées dans les `package.json` ; `pnpm-lock.yaml` versionné ; `onlyBuiltDependencies` restreint les scripts post-installation.
- ESLint (`typescript-eslint`) avec règles de sécurité ; `tsc --strict` ; Prettier.
- Évolution : CodeQL / Semgrep, SBOM, Renovate avec fenêtre de revue.

## 14. Stratégie de tests de sécurité

| Niveau                  | Contenu                                                                                                                                                                               | Outils                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Unitaires               | `validateEntries`, `computeFeeMinor`, machines à états, moteur de risque, signature HMAC, hachage de contrat                                                                          | vitest                                     |
| Intégration API         | Gardes RBAC (chaque permission × chaque rôle), isolation 404, CSRF/Origin, verrouillage, MFA, rejeu de webhook, validation des téléversements                                         | vitest + supertest sur `TEST_DATABASE_URL` |
| Concurrence du registre | N libérations simultanées d'un même séquestre ; N confirmations du même financement ; vérification qu'aucun solde interdit ne devient négatif et qu'une seule écriture par clé existe | tests dédiés `packages/financial-ledger`   |
| e2e                     | Scénario à 12 étapes et scénario de litige, vérification du bandeau sandbox sur chaque page                                                                                           | Playwright                                 |
| Manuel / externe        | Test d'intrusion indépendant avant toute phase live (porte R8)                                                                                                                        | —                                          |

## 15. Séparation sandbox / production — le garde `DFN_MODE`

Le dépôt ne contient **aucun chemin de production**. La séparation est appliquée à plusieurs niveaux, de sorte qu'une erreur de configuration ne puisse pas transformer la sandbox en service financier réel :

1. **Démarrage** : l'API lit `DFN_MODE` et refuse de démarrer (`process.exit(1)` avec message explicite) pour toute valeur autre que `sandbox`. Il n'existe pas de valeur `production` reconnue dans cette base de code.
2. **Réponses** : chaque réponse HTTP porte l'en-tête `x-dfn-mode: sandbox` ; la description OpenAPI contient le disclaimer. Le front lit `NEXT_PUBLIC_DFN_MODE` et affiche le bandeau « Données fictives — Aucun fonds réel » sur toutes les pages, sans possibilité de le fermer.
3. **Fabriques d'adaptateurs** : `createPaymentProvider`, `createKycProvider`, `createSanctionsProvider` lèvent une exception pour tout code autre que `sandbox` / `sandbox_partner`. Ajouter un adaptateur réel exige du code nouveau, une revue, et les portes réglementaires de `ROADMAP.md` §9.
4. **Données** : `PaymentProvider.mode` connaît `LIVE` pour préparer le schéma, mais aucun enregistrement `LIVE` n'est créé par le seed ni accepté par les fabriques ; `IdentityVerification.provider = "sandbox"`.
5. **Vocabulaire** : statuts `SIMULATED_PASS` / `SIMULATED_FAIL`, `CLEAR_SIMULATED`, `EXECUTED_SIMULATED`, méthodes `BANK_TRANSFER_SIMULATED` / `WALLET_SIMULATED`, instructions contenant « Do not send money ». Aucune interface ne peut afficher un résultat simulé comme réel sans réécrire ces types.
6. **Privilèges** : la simulation du partenaire (`sandbox:partner_simulate`, dépôts sandbox) est réservée au rôle global `ADMIN` et journalisée.
7. **Gouvernance** : toute modification du garde ou des fabriques requiert deux approbateurs et une mise à jour de `AUTHORIZATIONS_CHECKLIST.md`.

## 16. Risques résiduels et prochaines étapes

| Risque résiduel                                                               | Niveau                                  | Mitigation prévue                                               |
| ----------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| Stockage local des documents (`STORAGE_DIR`) sans HSM/KMS                     | Moyen                                   | Migration S3 + KMS (Phase 3), rotation de clé                   |
| Absence de passkeys / de codes de récupération MFA                            | Moyen                                   | Phase 3                                                         |
| Pas d'antivirus sur les téléversements                                        | Moyen                                   | Scan asynchrone en file BullMQ                                  |
| Limitation de débit en mémoire si Redis absent (déploiements multi-instances) | Faible en sandbox                       | Redis obligatoire hors développement                            |
| Pas de test d'intrusion indépendant                                           | Élevé avant live, acceptable en sandbox | Porte R8                                                        |
| Données personnelles réelles des testeurs                                     | Moyen                                   | Jeux de données fictifs, rétention courte, `DATA_PROTECTION.md` |
| Dépendance au secret unique `DOCUMENT_ENCRYPTION_KEY` pour documents et MFA   | Moyen                                   | Séparation en deux clés et KMS (Phase 3)                        |

**Signaler une vulnérabilité** : écrire à l'équipe sécurité via le canal indiqué dans le README du dépôt (à compléter) ; ne pas ouvrir d'issue publique. Accusé de réception sous 2 jours ouvrés, correctif ou plan sous 30 jours pour les failles hautes.
