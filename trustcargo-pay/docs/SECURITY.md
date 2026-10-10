# Sécurité

Ce document distingue **ce qui est implémenté et testé** de **ce qui reste à faire** avant une mise en production. Rien de ce qui figure dans la colonne « à faire » ne doit être présenté comme acquis.

## Modèle de menace (résumé)

| Menace | Contrôle implémenté | Preuve (test) |
| --- | --- | --- |
| Faux versement par manipulation de l'interface ou de l'API | Aucune route ne modifie un statut financier. Les transitions financières sont réservées à l'acteur `PROVIDER`, utilisé uniquement après vérification HMAC | `state-machine.test.ts` (« never lets a party… »), `security.test.ts` |
| Webhook falsifié ou rejoué | HMAC-SHA256 sur `timestamp.body`, tolérance de 5 min, comparaison à temps constant, unicité `(provider, external_event_id)` en mémoire et en SQL | `security.test.ts` (unit + intégration), `security.spec.ts` (E2E), `rls_test.sql` |
| Montant reçu différent du montant attendu | Aucun passage à `FUNDS_CONFIRMED` ; alerte critique et mise en file de revue ; écart visible en réconciliation | `security.test.ts` (« never confirms funding… ») |
| Double traitement | Clés d'idempotence : journaux, instructions, versements, remboursements ; requête partenaire idempotente | Test de rejeu (`replay`) |
| Accès à la transaction d'un tiers (IDOR) | Contrôle central `accessTransaction` ; réponse 404 indistinguable ; RLS en base | `security.test.ts`, `security.spec.ts`, `rls_test.sql` |
| Accès aux documents d'un tiers | `canView` (rôle de partie dans `visible_to_roles`), URL signée liée à l'utilisateur et valable 5 min, ré-autorisation au téléchargement, journal d'accès (y compris les refus), contrôle d'intégrité SHA-256 | `security.test.ts`, `transaction-flow.spec.ts` |
| Isolation entre organisations | Accès en lecture pour les membres, écriture réservée à la partie nommée ; politiques RLS | `security.test.ts` (« organisation members… »), `rls_test.sql` |
| Privilèges excessifs du personnel | Rôles distincts ; `platform_admin` sans accès aux transactions ; auditeur sans accès au contenu des fichiers | `security.test.ts` (« least privilege »), `security.spec.ts` |
| Vol de session / action sensible | Cookie de session HMAC, `HttpOnly`, `SameSite=Lax`, `Secure` en production, durée de 12 h ; MFA TOTP pour le back-office (12 h) et pour les actions sensibles (15 min) : décision de litige, coordonnées de versement, gel, contrepassation, configuration | `payments-disputes.test.ts` (`MFA_REQUIRED`), `security.spec.ts` |
| Changement frauduleux de bénéficiaire | MFA, délai de carence de 72 h, alertes bloquantes, notification de sécurité | `payments-disputes.test.ts` |
| CSRF | Server Actions (contrôle d'origine par Next.js) ; API REST : `Origin` = hôte et `Content-Type: application/json` obligatoires | `security.spec.ts` |
| XSS / clickjacking | CSP avec nonce par requête et `strict-dynamic`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` ; React échappe le contenu | `security.spec.ts` (en-têtes) |
| Fichiers malveillants | Type détecté par signature binaire (le type déclaré n'est pas cru), liste blanche PDF/PNG/JPEG/WEBP, 10 Mo max, nom de fichier assaini, analyse **avant** stockage (quarantaine), téléchargement avec CSP `sandbox` | `security.test.ts` (« document intake controls ») |
| Énumération / force brute | Limitation de débit : connexion, MFA (5 essais / 5 min), invitations, téléversements, API, webhook ; jetons d'invitation de 256 bits stockés hachés | Unit `rate-limiter` |
| Altération de l'historique | Journal d'audit chaîné SHA-256 et vérifiable ; tables en ajout seul en base | `demo-seed.test.ts` (`chain.valid`), `rls_test.sql` |
| Signalement prématuré (tipping-off) | Les parties ne voient ni les alertes, ni les gels, ni la conformité ; seulement un message générique « en revue » | `security.test.ts` |
| Fuite de secrets ou de données bancaires | Aucun numéro de carte ni de compte stocké (identifiant masqué + jeton) ; secrets via variables d'environnement ; seule la référence du secret partenaire est stockée ; logs JSON sans données sensibles | Revue de code, CHECK SQL sur `masked_identifier` |
| Données de démonstration | Profils fictifs, domaine `.test`, fichiers marqués « FICTIF » ; le mode production refuse le fournisseur simulé | `config.ts` |
| Confusion entre partenaire simulé et livres de TrustCargo | Enregistrements du faux partenaire isolés dans `trustcargo_sim` (aucune clé étrangère vers `trustcargo`, références et montants uniquement) ; `service_role` seul, aucun privilège pour `anon` / `authenticated`, RLS active, montants et relevé non modifiables ; écritures hors unité de travail | `rls_test.sql`, `simulated-partner.test.ts` |
| Énumération de comptes à la connexion | Lien magique Supabase (aucun mot de passe) ; réponse identique quelle que soit l'adresse, y compris en cas de limite par adresse atteinte ou d'échec du fournisseur ; limitation par IP et par adresse pseudonymisée (HMAC) ; adresse brute jamais journalisée | `account-service.test.ts` (« magic link request ») — doublures uniquement |
| Rattachement silencieux de comptes | Le profil TrustCargo porte l'identifiant de l'utilisateur Supabase ; e-mail confirmé obligatoire ; une adresse déjà utilisée par un autre profil (par ex. un profil de démonstration) est refusée ; l'adresse du profil vient de l'identité vérifiée, jamais du formulaire ; aucun rôle du personnel à l'inscription | `account-service.test.ts` (« e-mail link callback », « onboarding ») — doublures uniquement |
| Redirection ouverte (`next`, `back`) | `safeRedirectPath` : chemin relatif de même origine uniquement ; refus de `//`, `/\`, des antislashs, des schémas, des caractères de contrôle et de leurs variantes encodées ; résultat normalisé revérifié ; utilisé par le callback, la MFA et le changement de langue | `safe-redirect.test.ts` |
| Contournement de la MFA (comptes réels) | Session TrustCargo marquée « MFA » seulement après `challengeAndVerify` Supabase **et** un niveau `aal2` lu dans le jeton que le serveur Auth valide (`GET /user`) ; la session Supabase doit appartenir au même utilisateur que la session TrustCargo ; 5 essais / 5 min ; audit des succès et échecs | `account-service.test.ts` (« step-up MFA »), `supabase-auth.test.ts` — doublures uniquement |
| Documents exposés par le stockage | Bucket privé, clé secrète côté serveur uniquement ; aucune politique `storage.objects` : une session Supabase d'utilisateur ne peut ni lire ni écrire dans le bucket ; fichier envoyé hors unité de travail, sous une clé propre à l'envoi ; aucune URL signée Supabase remise au navigateur (téléchargement par la route applicative, qui ré-autorise, journalise et vérifie le SHA-256) ; `upsert: false` (objets immuables) ; clés d'objet en liste blanche ; erreurs reconstruites sans clé, jeton ni message du fournisseur ; délai d'expiration des requêtes | `supabase-storage.test.ts` — faux `fetch` uniquement ; `rls_test.sql` (accès direct refusé) ; `document-storage.test.ts` |

## Ce qui reste à faire (bloquant pour la production)

1. **Authentification réelle** : le parcours Supabase Auth (lien magique, profil, MFA TOTP AAL2) est implémenté mais **n'a jamais été exécuté contre un projet Supabase réel**. Restent : validation sur un projet dédié, révocation de la session TrustCargo quand la session Supabase est révoquée ailleurs, verrouillage de compte, procédure de réinitialisation du second facteur (codes de secours).
2. **Adaptateur Postgres** : branché (transactions SQL, `service_role`, verrou global). Reste à le valider sur un projet Supabase de staging et à remplacer le verrou global par des verrous ciblés avant une charge réelle. Le client Supabase est réservé aux lectures sous RLS.
3. **Limitation de débit distribuée** (Redis/Upstash) : l'implémentation actuelle est en mémoire.
4. **Antivirus réel** (ClamAV, ou service géré) : l'implémentation actuelle détecte seulement la signature EICAR.
5. **Stockage** : adaptateur Supabase Storage privé implémenté, testé avec un faux `fetch` seulement. Aucune politique n'est créée sur `storage.objects` : seul le serveur (clé secrète) lit et écrit le bucket, après ses propres contrôles ; une session Supabase d'utilisateur n'y a aucun accès direct. `DocumentService` envoie l'objet **avant** l'unité de travail, après les contrôles d'autorisation, sous une clé propre à l'envoi (`<transaction>/<document>/<sha256>`) : aucun verrou de base n'est tenu pendant le transfert et une transaction rejouée ne renvoie jamais le fichier. Si la transaction échoue ensuite, un objet privé non référencé subsiste ; il n'existe pas encore de purge de ces objets orphelins.
6. **Gestion des secrets** (coffre, rotation) et clés distinctes par environnement.
7. **Chiffrement applicatif** des champs KYC sensibles si des données d'identité sont conservées hors du fournisseur KYC.
8. **Politique de rétention et suppression** conforme aux obligations applicables (LCB-FT, protection des données). À définir avec un conseil juridique.
9. **Sauvegardes et tests de restauration** (PITR Supabase) avec procédure documentée et exercée.
10. **Tests d'intrusion** et revue de sécurité indépendante ; programme de divulgation responsable.
11. **Supervision** : alertes sur les événements partenaires en échec, la balance du registre, la rupture de la chaîne d'audit, les écarts de réconciliation.
12. **CSP** : les styles inline sont autorisés pour Radix UI. Évaluer une alternative.

## Supabase Auth et Supabase Storage

> **Rien de cette section n'a été exécuté contre un projet Supabase réel.** L'environnement où ce code a été écrit bloque l'accès réseau à `*.supabase.co`. Les comportements décrits sont implémentés et testés avec des doublures : un faux `AuthGateway` pour les parcours, et le vrai code `@supabase/ssr` / `@supabase/supabase-js` branché sur un faux serveur Auth et un faux `fetch` Storage. Les formats de réponse de ces doublures sont tirés du code source des bibliothèques, pas d'un serveur réel.

### Principes

- **Côté serveur uniquement.** Aucune clé Supabase n'est envoyée au navigateur : pas de variable `NEXT_PUBLIC_*`, pas de client Supabase côté navigateur. La clé publiable sert à Auth, depuis le serveur ; la clé secrète sert uniquement à Storage.
- **Cookies.** La session Supabase vit dans des cookies `HttpOnly`, `SameSite=Lax`, `Secure` en production, sous un nom dédié (`tc-sb-auth*`) pour ne jamais être partagée avec une autre application du même hôte.
- **Pas d'appel Supabase pendant le rendu d'une page.** Supabase n'est appelé que depuis des Route Handlers et des Server Actions, qui peuvent écrire des cookies : un rafraîchissement de jeton (refresh token à usage unique) est toujours renvoyé au navigateur. Les pages `/onboarding` et `/mfa` n'appellent pas Supabase pendant leur rendu.
- **Deux sessions, une seule autorité.** La session TrustCargo (`tc_session`, signée HMAC, 12 h) reste la source de vérité pour l'autorisation ; rôles et statut sont relus en base à chaque requête. La session Supabase ne prouve que l'adresse e-mail et le second facteur.
- **Logique testable.** Les parcours sont dans `src/server/services/account-service.ts`, derrière le port `AuthGateway` (`src/server/ports/auth-gateway.ts`) ; l'implémentation Supabase est `src/server/adapters/supabase/supabase-auth.ts`. Les actions serveur et la route `/auth/callback` ne font que traduire le résultat.

### Parcours

1. **Demande de lien** (`requestMagicLink`) : adresse validée (zod), limites de 10 demandes / 15 min par IP et de 3 envois / 15 min par adresse pseudonymisée, plus un plafond de 20 envois / heure par processus quelle que soit l'IP (quota d'e-mails du projet). La limite par adresse est **silencieuse** (même réponse, aucun envoi) pour ne rien révéler. `shouldCreateUser: true`, `emailRedirectTo = APP_URL/auth/callback`. L'IP du client est l'entrée la plus à droite de `X-Forwarded-For` ou l'en-tête `CLIENT_IP_HEADER` de la plateforme (voir DEPLOYMENT).
2. **Callback** (`GET /auth/callback`) : `code` PKCE **uniquement** (lié au navigateur qui a demandé le lien ; `token_hash` est ignoré, pour empêcher la connexion d'une victime au compte d'un attaquant). Limites de 20 appels / 5 min par IP et de 120 échanges de code / heure par processus. Une requête sans `code` valide (absent, trop long, limité, refusé par Supabase) redirige vers `/?auth=error` sans fermer aucune session : un GET intersite ne déconnecte personne. E-mail confirmé obligatoire. Profil existant et actif → si l'adresse vérifiée par Supabase a changé, le profil la reprend dans la même unité de travail (audit `user.email_synced` avec les adresses pseudonymisées par HMAC, jamais en clair), sauf si un autre profil la porte (refus) ; une session TrustCargo d'un autre utilisateur dans ce navigateur est fermée et journalisée (`auth.session_ended`) ; puis session TrustCargo, événement de session (pays du profil, empreintes HMAC de l'IP et de l'agent utilisateur), audit `auth.signed_in`, redirection vers un `next` sûr ou `/dashboard`. Pas de profil → `/onboarding`. Adresse portée par un autre profil, profil suspendu ou toute autre erreur après l'échange du code → déconnexion de la session Supabase ouverte par ce lien, audit `auth.sign_in_refused` quand l'identité est connue, et `/?auth=error` (message générique).
3. **Profil** (`/onboarding`) : accessible avec un marqueur signé `tc_onboarding` (30 min) posé par le callback ; l'action revérifie l'identité auprès de Supabase et exige qu'elle corresponde au marqueur. Le profil est créé avec l'identifiant Supabase, l'adresse de l'identité vérifiée, `isDemo = false`, `kycStatus = NOT_STARTED`, aucun rôle, statut `ACTIVE`, dans une unité de travail avec l'événement d'audit `user.registered`.
4. **MFA** (`/mfa`) : les profils de démonstration gardent le TOTP local fictif. Les comptes réels utilisent Supabase : sans facteur TOTP vérifié, enrôlement (QR code SVG ré-encodé en `data:` base64 dans une balise `<img>`, déjà autorisé par `img-src` de la CSP, et clé affichée pour une saisie manuelle) ; puis `challengeAndVerify` ; la session TrustCargo n'est marquée « MFA » que si le niveau courant est `aal2`. Session Supabase absente, expirée ou appartenant à un autre utilisateur → fin des deux sessions et `/?auth=expired`.
5. **Déconnexion** : déconnexion Supabase de l'appareil (`scope: 'local'`), puis suppression de la session TrustCargo, même si Supabase ne répond pas.

### Rôles du personnel

Aucun rôle n'est attribué à l'inscription et l'application n'a pas encore d'écran de gestion des rôles. Les rôles sont attribués en SQL (premier administrateur, puis les suivants avec `granted_by`) : voir [DEPLOYMENT](DEPLOYMENT.md#premier-administrateur-plateforme). Ces attributions SQL n'apparaissent pas dans la chaîne d'audit applicative : les consigner à part.

### Limites connues

- Le lien doit être ouvert dans le navigateur qui l'a demandé (`code` PKCE seul accepté, par conception).
- auth-js laisse dans le navigateur les cookies de vérificateur PKCE par flux après l'échange (sans valeur une fois le code consommé) ; leur nombre est borné par la bibliothèque.
- La limitation de débit est en mémoire, par processus.
- Pas de codes de secours MFA ni de procédure de réinitialisation du second facteur.
- Une session TrustCargo déjà ouverte survit jusqu'à 12 h à une révocation de la session Supabase faite ailleurs ; la suspension du profil TrustCargo, elle, prend effet à la requête suivante.
