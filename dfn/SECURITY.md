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
- Clés API partenaires : limitation de débit **par clé** (fenêtre glissante d'une minute, `rateLimitPerMinute`, en-têtes `X-RateLimit-*` et `Retry-After`), journal `ApiRequestLog` de chaque appel y compris les refus (401 / 403 / 429).
- En-tête `Idempotency-Key` sur toute mutation : empreinte méthode + chemin + corps canonique, rejeu de la réponse initiale (`Idempotent-Replayed: true`), refus d'une réutilisation avec un corps différent (`IDEMPOTENCY_KEY_REUSED`), verrou de requête en cours (`IDEMPOTENCY_IN_PROGRESS`), expiration `IDEMPOTENCY_TTL_HOURS`.
- Dépôts sandbox libre-service plafonnés par organisation, devise et jour (`SANDBOX_SELF_DEPOSIT_DAILY_LIMIT`) ; plafond quotidien de transfert par utilisateur (`DAILY_LIMIT_EXCEEDED`) et MFA exigée à l'autorisation selon les préférences de sécurité.
- Webhooks sortants : adresses privées / locales refusées (anti-SSRF lexical), redirections non suivies, délai `WEBHOOK_TIMEOUT_MS`, tentatives exponentielles bornées (`WEBHOOK_MAX_ATTEMPTS`), désactivation après 50 échecs consécutifs.

### Clés API partenaires

- Format `dfn_sk_<préfixe>_<32 octets aléatoires>` ; seul le préfixe et le hachage SHA-256 sont stockés ; le secret est affiché une seule fois (création ou rotation).
- Le contexte d'une clé est un **membre** de l'organisation émettrice, jamais un rôle staff ; les routes d'authentification, d'administration, de simulation et de gestion des clés sont inaccessibles par clé (`SCOPE_FORBIDDEN`), les autres exigent un scope explicite (`api-scopes.ts`, refus par défaut pour toute nouvelle route).
- Expiration, rotation et révocation journalisées dans `AuditLog` et notifiées aux propriétaires de l'organisation.

## 9. Journalisation structurée sans données sensibles

- `pino` / `nestjs-pino`, un `requestId` par requête propagé dans les erreurs API (`ApiErrorBody.requestId`).
- Redaction configurée sur : `password`, `currentPassword`, `newPassword`, `code` (TOTP), `authorization`, `cookie`, `set-cookie`, `token`, `mfaSecretEnc`, `secretEnc`, `keyHash`, contenu des documents, `declaredData.dateOfBirth`.
- Aucune donnée de pièce d'identité n'est journalisée ; `IdentityVerification.declaredData` ne contient que le type de document et le pays émetteur.
- Niveau par défaut `info` ; `debug` interdit en recette partagée.

## 10. Piste d'audit

- `AuditLog` : acteur, organisation, action, type et identifiant d'entité, IP, user-agent, métadonnées ; indexé par entité, acteur, organisation et date.
- `TransactionEvent` / `TransferEvent` : historique métier immuable de chaque transaction et de chaque transfert.
- `ApiRequestLog`, `WebhookDelivery`, `MaintenanceRun`, `DigitalAssetSimulation` : traçabilité des appels par clé, des livraisons sortantes, des tâches planifiées et des opérations de recherche DDA.
- `RiskAlertAction`, `DisputeDecision`, `DisputeMessage`, `ContractAcceptance` : décisions et consentements horodatés, jamais modifiés.
- Les lignes d'audit ne sont ni modifiables ni supprimables par l'application ; la purge suit la politique de rétention et se fait par anonymisation.

## 11. Gestion des secrets

- Variables d'environnement uniquement (`.env` ignoré par git ; `.env.example` sans valeur réelle).
- Secrets critiques : `SESSION_SECRET`, `DOCUMENT_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`, futurs `KYC_PROVIDER_API_KEY`, `SANCTIONS_PROVIDER_API_KEY`, `SMTP_URL`.
- L'API refuse de démarrer si `SESSION_SECRET` ou `DOCUMENT_ENCRYPTION_KEY` conservent leur valeur d'exemple hors `NODE_ENV=development`.
- Rotation : procédure documentée (double clé pendant la transition pour le chiffrement des documents : déchiffrement avec l'ancienne, chiffrement avec la nouvelle, re-chiffrement en tâche de fond).
- Secrets des webhooks (`WebhookSubscription.secretEnc`, chiffrés AES-256-GCM) et des clés API (`keyHash`, SHA-256) : jamais stockés en clair ni réaffichés ; identifiants de bénéficiaires chiffrés (`accountIdentifierEnc`) et masqués en lecture.
- Anonymisation des comptes supprimés (`ANONYMIZE_DELETED`) : e-mail, nom, téléphone, secret MFA, mot de passe (remplacé par un hachage aléatoire), préférences et données déclarées KYC sont écrasés ; sessions révoquées ; registre, événements et audit conservés, liés à l'identifiant technique.

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

| Niveau                  | Contenu                                                                                                                                                                                                                                                                         | Outils                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Unitaires               | `validateEntries`, `computeFeeMinor`, machines à états, moteur de risque, signature HMAC, hachage de contrat                                                                                                                                                                    | vitest                                                                                         |
| Intégration API         | Gardes RBAC (chaque permission × chaque rôle), isolation 404, CSRF/Origin, verrouillage, MFA, rejeu de webhook, validation des téléversements                                                                                                                                   | vitest + supertest sur `TEST_DATABASE_URL`                                                     |
| Concurrence du registre | N libérations simultanées d'un même séquestre ; N confirmations du même financement ; vérification qu'aucun solde interdit ne devient négatif et qu'une seule écriture par clé existe                                                                                           | tests dédiés `packages/financial-ledger`                                                       |
| Intégration phases 3–5  | Plafonds et MFA des transferts, revue conformité, isolation des bénéficiaires et factures, verrou des tâches, suppression / anonymisation, scopes et quotas par clé API, idempotence (rejeu, réutilisation, concurrence), signature et relances des webhooks, lignes rouges DDA | vitest + supertest (`apps/api/test/{wallet,jobs,transfers,business,api-platform,dda}.test.ts`) |
| e2e                     | Scénario à 12 étapes et scénario de litige, vérification du bandeau sandbox sur chaque page                                                                                                                                                                                     | Playwright                                                                                     |
| Manuel / externe        | Test d'intrusion indépendant avant toute phase live (porte R8)                                                                                                                                                                                                                  | —                                                                                              |

## 15. Séparation sandbox / production — le garde `DFN_MODE`

Le dépôt ne contient **aucun chemin de production**. La séparation est appliquée à plusieurs niveaux, de sorte qu'une erreur de configuration ne puisse pas transformer la sandbox en service financier réel :

1. **Démarrage** : l'API lit `DFN_MODE` et refuse de démarrer (`process.exit(1)` avec message explicite) pour toute valeur autre que `sandbox`. Il n'existe pas de valeur `production` reconnue dans cette base de code.
2. **Réponses** : chaque réponse HTTP porte l'en-tête `x-dfn-mode: sandbox` ; la description OpenAPI contient le disclaimer. Le front lit `NEXT_PUBLIC_DFN_MODE` et affiche le bandeau « Données fictives — Aucun fonds réel » sur toutes les pages, sans possibilité de le fermer.
3. **Fabriques d'adaptateurs** : `createPaymentProvider`, `createKycProvider`, `createSanctionsProvider`, `createFxRateProvider` lèvent une exception pour tout code autre que `sandbox` / `sandbox_partner`. Ajouter un adaptateur réel exige du code nouveau, une revue, et les portes réglementaires de `ROADMAP.md` §10.
4. **Données** : `PaymentProvider.mode` connaît `LIVE` pour préparer le schéma, mais aucun enregistrement `LIVE` n'est créé par le seed ni accepté par les fabriques ; `IdentityVerification.provider = "sandbox"`.
5. **Vocabulaire** : statuts `SIMULATED_PASS` / `SIMULATED_FAIL`, `CLEAR_SIMULATED`, `EXECUTED_SIMULATED`, méthodes `BANK_TRANSFER_SIMULATED` / `WALLET_SIMULATED`, instructions contenant « Do not send money ». Aucune interface ne peut afficher un résultat simulé comme réel sans réécrire ces types.
6. **Privilèges** : la simulation du partenaire (`sandbox:partner_simulate`, dépôts sandbox administrés, événements de règlement de transfert) est réservée au rôle global `ADMIN` et journalisée ; le dépôt libre-service est plafonné et audité.
7. **DDA** : la devise `DDA` est de type `SIMULATED_ASSET`, les routes `v1/admin/dda/*` exigent `ADMIN_DDA` (rôle `ADMIN`), chaque réponse porte `simulated: true` et l'hypothèse « 1 DDA = 1 USD non garantie », et une écriture `DDA` ↔ fiat est structurellement impossible (une devise par écriture). Aucune conversion, aucun jeton, aucune émission.
8. **Gouvernance** : toute modification du garde ou des fabriques requiert deux approbateurs et une mise à jour de `AUTHORIZATIONS_CHECKLIST.md`.

## 16. Revue adversariale (phases 3–5)

Trois relectures indépendantes (sécurité applicative, invariants comptables, règles produit sandbox) ont été menées sur le code des phases 3 à 5 avant fusion. Corrections appliquées : garde anti-SSRF réécrit (analyse réelle des adresses IPv4/IPv6, formes IPv4-mappées, résolution DNS à l'envoi), secrets exclus du magasin d'idempotence (`@SkipIdempotency`), contre-vérification du sur-paiement des factures sous verrou de ligne, événement partenaire prématuré ne consommant plus la clé d'idempotence du règlement, expiration des devis et plafond quotidien revérifiés sous verrou, instantanés de solde pris sous verrou de compte et réconciliation partitionnée sur `LedgerEntry.seq`, neutralisation des formules dans les exports CSV, lien explicite de contrepartie restreint aux organisations du demandeur, blocages de suppression de compte étendus (transferts, factures, clés API) et anonymisation des bénéficiaires / contreparties / courriels clients, baisse des protections de sécurité soumise à un code TOTP, clés API invalidées lorsque leur créateur quitte l'organisation, motifs de revue conformité réservés au staff, et une douzaine de corrections d'interface (boutons inertes, hydratation, traductions, règles métier côté client). Les points non corrigés figurent dans le tableau ci-dessous.

## 17. Risques résiduels et prochaines étapes

| Risque résiduel                                                                                                        | Niveau                                  | Mitigation prévue                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| Stockage local des documents (`STORAGE_DIR`) sans HSM/KMS                                                              | Moyen                                   | Migration S3 + KMS (Phase 6), rotation de clé                                         |
| Absence de passkeys / de codes de récupération MFA                                                                     | Moyen                                   | Phase 6                                                                               |
| Pas d'antivirus sur les téléversements                                                                                 | Moyen                                   | Scan asynchrone en file BullMQ                                                        |
| Limitation de débit en mémoire (throttler sans Redis, quotas par clé API, `lastUsedAt`) — déploiements multi-instances | Faible en sandbox                       | Redis obligatoire hors développement ; magasin partagé pour les quotas par clé        |
| Planificateur de tâches en mémoire (une seule réplique doit activer `JOBS_ENABLED`)                                    | Faible en sandbox                       | Passage à BullMQ avec verrou Redis (Phase 6)                                          |
| Garde anti-SSRF lexical (pas de résolution DNS ; désactivé en `NODE_ENV=test`)                                         | Moyen                                   | Résolution DNS + liste d'autorisation d'adresses avant toute phase live               |
| Secrets de webhooks chiffrés avec `DOCUMENT_ENCRYPTION_KEY` (clé partagée avec documents et MFA)                       | Moyen                                   | Clé dédiée et KMS (Phase 6)                                                           |
| Livraison webhook créée puis processus arrêté avant la première tentative : ligne `PENDING` non relancée               | Faible                                  | Balayage des `PENDING` périmées dans `WEBHOOK_RETRY`                                  |
| `Idempotency-Key` honoré aussi pour les sessions (clé scopée par utilisateur) ; le web ne l'envoie pas                 | Faible                                  | Documenté ; limiter aux clés API si nécessaire                                        |
| Pas de test d'intrusion indépendant                                                                                    | Élevé avant live, acceptable en sandbox | Porte R8                                                                              |
| Données personnelles réelles des testeurs                                                                              | Moyen                                   | Jeux de données fictifs, rétention courte, `DATA_PROTECTION.md`                       |
| Dépendance au secret unique `DOCUMENT_ENCRYPTION_KEY` pour documents, MFA et secrets de webhooks                       | Moyen                                   | Séparation en clés distinctes et KMS (Phase 6)                                        |
| Checklists de conformité rédigées sans conseiller juridique                                                            | Élevé avant tout contrat partenaire     | Relecture juridique (Phase 6, tâche humaine)                                          |
| Rejeu d'un code TOTP dans sa fenêtre de validité (plusieurs autorisations de transfert avec le même code)              | Faible                                  | Mémoriser le dernier pas TOTP utilisé (`mfaLastUsedStep`) et refuser la réutilisation |
| Rôles staff considérés comme `OWNER` implicite dans tout espace (création de contreparties, envoi de factures)         | Faible en sandbox                       | Permissions `ADMIN_*` explicites pour les chemins d'écriture staff                    |
| Verrou de tâche planifiée libéré après 15 min alors que le traitement peut continuer                                   | Faible                                  | `AbortSignal` lié au verrou ou verrou repris par lot                                  |
| Création de contrepartie par e-mail : révèle l'existence d'un compte DFN pour cet e-mail (badge « lié »)               | Faible                                  | Lien soumis au consentement du client, limitation de débit                            |
| Taux de taxe des factures dérivé de `taxMinor / subtotalMinor` lors des modifications (dérive d'arrondi possible)      | Faible                                  | Persister `taxBps` sur `Invoice` / `Quote`                                            |

**Signaler une vulnérabilité** : écrire à l'équipe sécurité via le canal indiqué dans le README du dépôt (à compléter) ; ne pas ouvrir d'issue publique. Accusé de réception sous 2 jours ouvrés, correctif ou plan sous 30 jours pour les failles hautes.
