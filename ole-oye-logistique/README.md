# Site exportateur — Ole Oye Logistique

Site vitrine bilingue (français, anglais) pour un exportateur de véhicules et de conteneurs, avec demande de devis et, en option, suivi d'expédition et petite administration. Il est conçu comme un **modèle réutilisable** : tout ce qui est propre au client se trouve dans un seul fichier, [`src/config/site.config.ts`](src/config/site.config.ts).

- **Astro** (site statique) et **Tailwind CSS**, TypeScript partout
- **Netlify** pour l'hébergement et les fonctions serveur
- **Supabase** pour les devis, les expéditions et la connexion à l'administration
- **Resend** pour le courriel de notification des devis

Aucune clé n'est envoyée au navigateur : le site ne parle qu'aux fonctions `/api/*`, qui sont les seules à lire et à écrire dans Supabase.

## Sommaire

1. [Installation locale](#installation-locale)
2. [Variables d'environnement](#variables-denvironnement)
3. [Mise en place de Supabase](#mise-en-place-de-supabase)
4. [Déploiement sur Netlify](#déploiement-sur-netlify)
5. [Utiliser l'administration](#utiliser-ladministration)
6. [Dupliquer ce modèle pour un nouveau client](#dupliquer-ce-modèle-pour-un-nouveau-client)
7. [Activer ou désactiver le suivi d'expédition](#activer-ou-désactiver-le-suivi-dexpédition)
8. [Ajouter une langue](#ajouter-une-langue)
9. [Structure du projet](#structure-du-projet)
10. [Brancher l'API d'un transporteur](#brancher-lapi-dun-transporteur)

## Installation locale

Il faut Node.js 22 ou plus récent.

```bash
npm install
```

```bash
npm run dev
```

Le site s'ouvre sur `http://localhost:4321/fr/`. Cette commande sert les pages, mais pas les fonctions : le formulaire de devis, le suivi et `/admin` répondront par une erreur.

Pour tout faire tourner en local, fonctions comprises, copier `.env.example` en `.env`, le remplir, puis lancer le site avec l'outil de Netlify :

```bash
npx netlify-cli dev
```

Le site est alors sur `http://localhost:8888`.

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Pages seulement, rechargement à chaud |
| `npm run build` | Produit le site dans `dist/` |
| `npm run check` | Vérifie les types (pages et fonctions) |
| `npm test` | Tests de la validation et des fonctions serveur |
| `npm run og` | Régénère l'image d'aperçu `public/og-image.png` |

## Variables d'environnement

Toutes les variables sont décrites dans [`.env.example`](.env.example). Elles ne servent qu'aux fonctions serveur.

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `SUPABASE_URL` | oui | Adresse du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | Clé secrète du projet. Elle contourne la sécurité des tables : ne jamais la publier |
| `SITE_TENANT_ID` | oui | UUID du client dans l'ERP. Toutes les données du site sont filtrées dessus |
| `ADMIN_SESSION_SECRET` | oui | Signe les sessions de `/admin`, 32 caractères minimum |
| `RATE_LIMIT_SALT` | conseillé | Sel des empreintes d'adresses IP de la limite de débit |
| `RESEND_API_KEY` | pour le courriel | Clé Resend |
| `QUOTE_NOTIFY_EMAIL` | pour le courriel | Adresse qui reçoit les demandes de devis (plusieurs possibles, séparées par des virgules) |
| `QUOTE_FROM_EMAIL` | pour le courriel | Adresse d'expédition, sur un domaine vérifié dans Resend |
| `SITE_URL` | non | Adresse publique du site, si elle diffère de celle fournie par Netlify |

Sans les trois variables Resend, les demandes de devis sont quand même enregistrées ; seul le courriel n'est pas envoyé.

Pour générer les deux secrets :

```bash
openssl rand -base64 48
```

## Mise en place de Supabase

1. Créer un projet Supabase, ou utiliser celui de l'ERP : les migrations ne créent et ne modifient que leurs propres objets, les tables déjà présentes gardent leurs droits.
2. Exécuter dans l'ordre les fichiers de [`supabase/migrations/`](supabase/migrations/) dans **SQL Editor**, ou avec `supabase db push` si le projet est lié à la CLI :
   - `0001_init.sql` crée les tables, le déclencheur de statut et la limite de débit ;
   - `0002_service_role_grants.sql` donne à la clé de service ses droits sur ces tables. Sans lui, les fonctions reçoivent « permission denied » dans les projets où les nouvelles tables ne sont pas ouvertes d'office.
3. Choisir l'UUID du client (`SITE_TENANT_ID`). Avec l'ERP, c'est l'identifiant du tenant ; sinon, en générer un et le garder.
4. Autoriser la ou les personnes qui gèrent les expéditions, dans **SQL Editor** :

   ```sql
   insert into admin_users (email, tenant_id)
   values ('personne@exemple.com', '00000000-0000-0000-0000-000000000000');
   ```

5. Dans **Authentication → URL Configuration**, mettre l'adresse du site dans *Site URL* et ajouter `https://votre-domaine/admin/` dans *Redirect URLs*. Sans cela, le lien de connexion ne ramène pas vers l'administration.
6. Facultatif : dans **Authentication → Email Templates → Magic Link**, ajouter `{{ .Token }}` au message. La personne peut alors taper le code à six chiffres au lieu de cliquer sur le lien, ce qui est plus fiable quand la messagerie ouvre les liens dans un autre navigateur.

### Ce que créent les migrations

| Table | Contenu |
| --- | --- |
| `quote_requests` | Demandes de devis, avec la preuve de consentement (date et version de la politique) |
| `shipments` | Expéditions : dossier, conteneur, ports, date prévue, statut actuel |
| `shipment_events` | Étapes d'une expédition, avec leur source (`manual` ou `carrier_api`) |
| `admin_users` | Courriels autorisés à se connecter à `/admin` |
| `rate_limits` | Compteurs de la limite de débit (empreintes, jamais d'adresse IP en clair) |

La sécurité par ligne (RLS) est activée sur ces cinq tables, sans aucune règle d'accès, et les rôles `anon` et `authenticated` n'y ont aucun droit : ils ne peuvent rien lire ni écrire. Seule la clé de service, utilisée par les fonctions, a accès aux données.

Le statut d'une expédition (`shipments.current_status`) est recalculé par un déclencheur à chaque ajout, correction ou retrait d'étape : c'est toujours celui de l'étape la plus récente.

## Déploiement sur Netlify

1. Dans Netlify, **Add new site → Import an existing project**, choisir le dépôt et la branche `main`.
2. Régler **Base directory** sur le dossier du site (ici `ole-oye-logistique`). La commande de build et le dossier publié sont lus dans [`netlify.toml`](netlify.toml).
3. Dans **Site configuration → Environment variables**, ajouter les variables du tableau ci-dessus.
4. Lancer le déploiement, puis brancher le nom de domaine.
5. Mettre l'adresse définitive dans `url` de `site.config.ts`, et dans *Site URL* côté Supabase.

À vérifier après la mise en ligne :

- `/` redirige vers `/fr/` (ou `/en/` pour un navigateur en anglais) ;
- une demande de devis d'essai arrive dans `quote_requests` et par courriel ;
- si le suivi est actif : `/admin` envoie le courriel de connexion, et une expédition créée s'affiche dans `/fr/suivi/` ;
- le lien du site partagé dans WhatsApp montre l'image d'aperçu.

## Utiliser l'administration

L'adresse est `/admin`. Elle n'apparaît ni dans le menu ni dans le sitemap.

- **Se connecter** : saisir son courriel, puis ouvrir le lien reçu (ou taper le code). La session dure 7 jours sur l'appareil.
- **Créer une expédition** : « Nouvelle expédition », numéro de dossier, port d'arrivée. Le numéro de conteneur peut être ajouté plus tard avec « Modifier ». La première étape, « Reçu à l'entrepôt », est créée automatiquement.
- **Ajouter une étape en deux clics** : « Étape suivante : … », puis « Confirmer ». La date est celle du moment ; on peut la changer ou choisir une autre étape avant de confirmer.
- **Corriger une erreur** : ouvrir « Étapes enregistrées » et retirer l'étape en trop.
- **Envoyer le suivi à un client** : le lien `https://votre-domaine/fr/suivi/?q=NUMERO` affiche directement son expédition.

La page de suivi ne montre que le statut, les étapes, les deux ports et la date d'arrivée prévue. La note interne et les autres colonnes ne sortent jamais de la base.

## Dupliquer ce modèle pour un nouveau client

Copier le dossier dans un nouveau dépôt, puis suivre cette liste.

### 1. `src/config/site.config.ts` — le seul fichier de contenu à modifier

| Bloc | À remplir |
| --- | --- |
| Identité | `name`, `shortName`, `legalName`, `url`, `referencePrefix` |
| `brand.colors` | Couleurs de la marque. Garder un contraste suffisant : texte foncé sur `accent`, texte blanc sur `primary` |
| `features` | `tracking` : active ou non le suivi d'expédition (voir plus bas) |
| `contact` | Téléphone, WhatsApp, courriel, adresse, lien Google Maps, heures d'ouverture |
| `origin`, `region` | Ville et port de départ, zone desservie |
| `tagline`, `trust` | Slogan et les trois arguments de confiance (avec un chiffre dans `value` si le client en a) |
| `services` | Un bloc par service : titre, résumé, liste « ce qui est inclus » |
| `destinations` | Ports desservis et délais de transit (`transit: null` affiche « à confirmer ») |
| `privacy` | Responsable de la protection des renseignements personnels, date de la politique, durée de conservation |

Les champs encore à `[À COMPLÉTER]` s'affichent tels quels sur le site, pour qu'aucun oubli ne passe inaperçu.

### 2. Fichiers de marque dans `public/`

- `logo.svg` : le logo du client. Si le fichier contient déjà le nom, passer `brand.logoIncludesName` à `true`.
- `favicon.svg` : l'icône de l'onglet.
- `og-image.png` : l'image d'aperçu. `npm run og` la régénère à partir de la config ; cette commande demande Playwright (`npm install --no-save playwright && npx playwright install chromium`).

### 3. Textes

Les textes génériques sont dans `src/i18n/fr.json` et `en.json` et utilisent `{company}`, `{city}` et `{region}` : ils s'adaptent seuls au nouveau client. Les modifier seulement pour changer le ton ou une formulation.

Faire relire la politique de confidentialité et les mentions légales (clés `privacy` et `legal`) par le client : ce sont des modèles, pas un avis juridique.

### 4. Infrastructure

- Un projet Supabase (ou un nouveau `tenant_id` dans le projet de l'ERP), la migration appliquée, les courriels dans `admin_users`.
- Un site Netlify avec ses variables d'environnement, dont de **nouveaux** secrets `ADMIN_SESSION_SECRET` et `RATE_LIMIT_SALT`.
- Un domaine d'expédition vérifié dans Resend.

Rien d'autre n'est à toucher : composants, pages, fonctions et schéma SQL sont communs à tous les clients.

## Activer ou désactiver le suivi d'expédition

Le suivi est optionnel. Il se règle dans `site.config.ts` :

```ts
features: {
  tracking: false,
},
```

À `false` (réglage actuel d'Ole Oye Logistique) :

- la page « Suivi » et `/admin` ne sont pas publiées, et « Suivi » disparaît du menu ;
- `/api/track` et `/api/admin/*` répondent 404 ;
- les textes d'interface qui parlent du suivi sont retirés (accueil, politique de confidentialité, mentions légales).

À `true`, tout revient sans autre changement. Les textes propres au client, dans `trust` et `services`, ne suivent pas ce réglage : y ajouter ou retirer soi-même les mentions du suivi.

Les tables `shipments` et `shipment_events` restent dans la base dans les deux cas ; elles ne servent simplement pas tant que le suivi est désactivé. Les sections « Utiliser l'administration » et « Brancher l'API d'un transporteur » ne concernent que les sites où le suivi est actif.

## Ajouter une langue

Exemple avec le wolof :

1. Copier `src/i18n/fr.json` en `src/i18n/wo.json` et traduire. Une clé manquante s'affiche en français.
2. Ajouter la langue dans `locales` de `site.config.ts` :

   ```ts
   { code: 'wo', label: 'Wolof', htmlLang: 'wo', ogLocale: 'wo_SN' },
   ```

3. Ajouter les traductions `wo` aux textes de la config (services, destinations, slogan). Sans elles, ces textes restent en français.

Les pages `/wo/…`, le sélecteur de langue, les balises `hreflang` et le sitemap suivent sans autre changement.

## Structure du projet

```
src/
  config/site.config.ts     tout ce qui est propre au client
  i18n/                     textes de l'interface (un fichier par langue) et moteur de traduction
  lib/                      validation du devis, statuts, règles de saisie, SEO
  components/               en-tête, pied de page, formulaire de devis, suivi, administration
  layouts/BaseLayout.astro  mise en page commune, balises SEO, données structurées
  pages/[lang]/             accueil, services, destinations, devis, suivi, contact, pages légales
  pages/admin.astro         administration
netlify/
  functions/                quote, track, admin-auth, admin-shipments
  lib/                      accès Supabase, limite de débit, courriel, session, CarrierAdapter
supabase/migrations/        schéma SQL
tests/                      tests Vitest et faux Supabase en mémoire
```

| Route | Fonction | Rôle |
| --- | --- | --- |
| `POST /api/quote` | `quote.ts` | Valide et enregistre un devis, envoie le courriel |
| `GET /api/track?q=` | `track.ts` | Suivi public d'une expédition |
| `/api/admin/auth` | `admin-auth.ts` | Connexion par courriel, session |
| `/api/admin/shipments` | `admin-shipments.ts` | Création et mise à jour des expéditions |

Protections en place : validation côté navigateur et côté serveur, champ piège contre les robots, limite de débit par adresse IP (5 devis par 10 minutes, 30 recherches de suivi par 5 minutes, 8 tentatives de connexion par quart d'heure), refus des requêtes venues d'un autre site, session d'administration dans un témoin `HttpOnly` et `SameSite=Strict`.

## Brancher l'API d'un transporteur

Pour l'instant, toutes les étapes sont saisies à la main (`source = 'manual'`). Le fichier [`netlify/lib/carriers/CarrierAdapter.ts`](netlify/lib/carriers/CarrierAdapter.ts) décrit l'interface à implémenter pour Maersk, CMA CGM ou MSC et la fonction planifiée à ajouter. Les étapes automatiques s'enregistrent dans la même table avec `source = 'carrier_api'` et la réponse d'origine dans `raw_payload` ; le site n'a pas à changer.
