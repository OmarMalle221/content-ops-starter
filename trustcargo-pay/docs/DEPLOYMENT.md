# Déploiement et environnements

## Environnements

| Environnement | `TRUSTCARGO_MODE` | Paiement | Données | Usage |
| --- | --- | --- | --- | --- |
| Local | `demo` | `mock` | Mémoire (ou Postgres local avec `DATABASE_URL`), scénarios fictifs | Développement, démonstration |
| Staging | `demo`, puis `production` avec la sandbox du partenaire | `mock`, puis sandbox | Projet Supabase dédié | Recette, tests E2E, tests RLS sur Supabase réel |
| Production | `production` | Partenaire habilité **uniquement** | Projet Supabase dédié, PITR | Après validation de [PRODUCTION_READINESS](PRODUCTION_READINESS.md) |

Chaque environnement a ses propres secrets, son propre projet Supabase et ses propres clés partenaire. Aucune donnée réelle ne doit circuler hors de la production.

## Variables

Voir [`.env.example`](../.env.example). En production :

- `SESSION_SECRET` est obligatoire, sinon l'application refuse de démarrer ;
- le fournisseur `mock` est refusé ;
- `DATABASE_URL` est obligatoire (l'adaptateur mémoire est réservé à la démo) ;
- `AUTH_PROVIDER=supabase` et `STORAGE_PROVIDER=supabase` sont obligatoires (aucune connexion par profil de démonstration, aucun stockage en mémoire).

Persistance Postgres : `DATABASE_URL` (connexion directe, rôle de migration ou rôle membre de `service_role`), `DATABASE_ROLE=service_role` (rôle pris dans chaque transaction), `DATABASE_POOL_MAX`, et `DATABASE_SSL_CA` (certificat CA PEM ; impose la vérification du serveur). Les migrations doivent être appliquées avant le démarrage ; l'application ne crée aucun objet dans le schéma `public`. En démo, le partenaire simulé conserve ses enregistrements fictifs dans le schéma `trustcargo_sim` (pool de 2 connexions au plus, en plus de `DATABASE_POOL_MAX`) : le simulateur continue de fonctionner après un redémarrage et entre instances.

## Démo (état actuel)

Sans `DATABASE_URL`, l'état de la démo est **en mémoire, par processus**. Il faut donc un seul processus Node de longue durée :

```bash
npm ci && npm run build
TRUSTCARGO_MODE=demo SESSION_SECRET=$(openssl rand -base64 48) \
MOCK_PROVIDER_WEBHOOK_SECRET=$(openssl rand -hex 24) APP_URL=https://demo.example.com \
npm start
```

Cibles adaptées : un conteneur unique (Fly.io, Railway, Render, Cloud Run avec `max-instances=1`) ou une VM.

Les plateformes serverless multi-instances (Netlify, Vercel Functions) ne conviennent **pas** avec l'adaptateur mémoire : chaque instance aurait des données différentes. Avec `DATABASE_URL`, plusieurs instances partagent la même base ; leurs unités de travail sont sérialisées par un verrou consultatif global (débit limité, voir [PRODUCTION_READINESS](PRODUCTION_READINESS.md)). Le `netlify.toml` à la racine du dépôt concerne le site existant, pas cette application.

En mémoire, un redémarrage ou l'action « Réinitialiser la démo » (administratrice plateforme) recrée les scénarios. Sur Postgres, les scénarios fictifs sont créés au premier démarrage d'une base vide (mode démo uniquement, jamais en production) et conservés ensuite ; la réinitialisation est refusée, car le journal d'audit, le registre et les événements partenaires sont en ajout seul. Pour repartir de zéro, utiliser une nouvelle base.

## Base de données

```bash
npm run test:db                        # migrations + tests RLS/registre sur PostgreSQL 16 local
npm run test:pg                        # suite d'intégration complète sur l'adaptateur Postgres (base clonée par test)
supabase link --project-ref <ref>      # staging d'abord
supabase db push
```

## CI/CD

Le workflow `.github/workflows/trustcargo-pay.yml` contient trois jobs.

1. **checks** : Prettier, ESLint, TypeScript strict, Vitest (unitaires + intégration).
2. **database** : PostgreSQL 16 (service), migrations Supabase, tests RLS et d'intégrité du registre, puis la suite d'intégration sur l'adaptateur Postgres (`npm run test:pg`).
3. **e2e** : build de production, Playwright. Couvre les parcours critiques, la sécurité, les en-têtes, l'accessibilité (axe) et le mobile.

Déploiement recommandé :

- fusion sur `main` → staging automatique ;
- promotion manuelle vers la production, avec application des migrations approuvée ;
- pas de migration destructive sans plan de retour arrière.

## Supabase Auth et Supabase Storage

> **Non testé contre un projet Supabase réel.** Tout ce qui suit a été implémenté et testé avec des doublures depuis un environnement qui n'a pas accès à `*.supabase.co`. La première mise en service sur un projet réel doit dérouler la [vérification manuelle](#première-vérification-sur-un-projet-réel) ci-dessous.

### Variables (serveur uniquement)

| Variable | Rôle |
| --- | --- |
| `AUTH_PROVIDER` | `demo` (profils fictifs) ou `supabase` (lien magique + MFA TOTP). `supabase` obligatoire en production. |
| `STORAGE_PROVIDER` | `memory` ou `supabase` (bucket privé). `supabase` obligatoire en production. |
| `SUPABASE_URL` | URL du projet, `https://<ref>.supabase.co`. |
| `SUPABASE_PUBLISHABLE_KEY` | Clé publiable (`sb_publishable_…`) ou ancienne clé `anon`. Utilisée **côté serveur** pour Auth. |
| `SUPABASE_SECRET_KEY` | Clé secrète (`sb_secret_…`) ou ancienne clé `service_role`. Utilisée **uniquement** pour Storage. Secret : coffre de l'hébergeur, jamais dans le dépôt. |
| `SUPABASE_STORAGE_BUCKET` | `trustcargo-documents` par défaut (bucket privé créé par la migration RLS). |
| `APP_URL` | URL publique de l'application ; base du lien de connexion (`APP_URL/auth/callback`) et des redirections. |

Aucune de ces variables ne doit être préfixée par `NEXT_PUBLIC_` : l'application n'a pas de client Supabase dans le navigateur.

### Configuration d'Auth (tableau de bord Supabase)

1. **Authentication → URL Configuration → Redirect URLs** : ajouter exactement `APP_URL/auth/callback` pour chaque environnement (par exemple `http://localhost:3000/auth/callback`, `https://staging.example.com/auth/callback`). Sur un projet dédié, régler aussi **Site URL** sur `APP_URL`.
2. **Authentication → Providers → Email** : activé, avec confirmation de l'adresse. Configurer un SMTP personnalisé pour la production (l'envoi par défaut de Supabase est fortement limité).
3. **Modèles d'e-mail** (« Magic Link » et « Confirm signup ») :
   - le modèle par défaut (`{{ .ConfirmationURL }}`) fonctionne : Supabase renvoie vers `APP_URL/auth/callback?code=…` (PKCE). Le lien doit alors être ouvert dans le navigateur qui l'a demandé ;
   - sur un projet dédié, modèle recommandé, utilisable depuis n'importe quel navigateur : `<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">Se connecter à TrustCargo Pay</a>`.
4. **Authentication → Multi-Factor** : activer TOTP (enrôlement et vérification). L'application exige `aal2` avant de marquer la session TrustCargo « MFA ».
5. Les clés restent côté serveur : seules `SUPABASE_URL` et `SUPABASE_PUBLISHABLE_KEY` servent à Auth, depuis les Route Handlers et Server Actions.

### Storage

Le bucket privé `trustcargo-documents` est créé par `supabase/migrations/20261009000003_rls.sql` quand le schéma `storage` existe. L'application y écrit avec la clé secrète, côté serveur, sans jamais écraser un objet (`upsert: false`). Elle ne produit **aucune** URL signée Supabase : les téléchargements passent par `/api/v1/documents/{id}/content`, qui ré-autorise l'utilisateur, journalise l'accès et vérifie le SHA-256.

### Premier administrateur plateforme

Aucun rôle du personnel n'est attribué à l'inscription et il n'existe pas encore d'écran de gestion des rôles. La personne se connecte d'abord une fois par lien magique et crée son profil (`/onboarding`) ; ensuite, dans l'éditeur SQL du projet :

```sql
-- Premier administrateur (granted_by reste null : amorçage).
insert into trustcargo.user_platform_roles (user_id, role, granted_by)
select id, 'platform_admin', null
from trustcargo.users
where lower(email) = lower('admin@example.com')
on conflict (user_id, role) do nothing;

-- Rôles suivants : attribués par un administrateur existant, tracés par granted_by.
insert into trustcargo.user_platform_roles (user_id, role, granted_by)
select u.id, 'compliance_analyst', a.id
from trustcargo.users u, trustcargo.users a
where lower(u.email) = lower('analyste@example.com') and lower(a.email) = lower('admin@example.com')
on conflict (user_id, role) do nothing;
```

Ces insertions ne passent pas par la chaîne d'audit applicative : les consigner dans le registre des changements d'accès. Le personnel doit enrôler son second facteur à la première ouverture du back-office.

### Projet de développement partagé (`cargoflow-verify`)

En développement, le projet Supabase cible `cargoflow-verify` **partage ses utilisateurs Auth avec une autre application, CargoFlow**. Conséquences :

- chaque inscription TrustCargo, et même chaque demande de lien pour une adresse inconnue (`shouldCreateUser: true`), crée une ligne dans `auth.users` et donc, par le déclencheur de ce projet sur `auth.users`, **un profil CargoFlow** ;
- les réglages Auth sont communs aux deux applications : Site URL, liste des URL de redirection, modèles d'e-mail, SMTP, MFA. Ne pas modifier le Site URL ni les modèles de CargoFlow : ajouter seulement `http://localhost:3000/auth/callback` aux Redirect URLs et garder le modèle par défaut (lien `code`, même navigateur). Activer TOTP le rend disponible aux utilisateurs CargoFlow, sans le leur imposer ;
- n'y utiliser que des adresses de test, jamais de données personnelles réelles.

C'est acceptable **pour le développement uniquement**. Staging et production exigent chacun un projet Supabase **dédié** à TrustCargo Pay.

### Première vérification sur un projet réel

À faire sur un projet dédié avant de considérer l'intégration comme validée (rien de cela n'a encore été fait) :

1. demander un lien, le recevoir, l'ouvrir : profil créé via `/onboarding`, une seule ligne `trustcargo.users` avec l'identifiant de `auth.users` ;
2. rouvrir un lien pour le même compte : connexion directe au tableau de bord ;
3. demander un lien pour l'adresse d'un profil existant d'une autre identité : refus générique ;
4. enrôler TOTP avec une vraie application d'authentification, vérifier qu'un mauvais code échoue, que le bon code ouvre le back-office et que le jeton porte `aal: aal2` ;
5. téléverser un document, vérifier l'objet dans le bucket privé, le télécharger par l'application, vérifier qu'un second envoi sur la même clé est refusé ;
6. déconnexion : cookies `tc-sb-auth*` et `tc_session` supprimés.
