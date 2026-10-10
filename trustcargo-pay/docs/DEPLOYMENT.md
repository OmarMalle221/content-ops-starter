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
- `DATABASE_URL` est obligatoire (l'adaptateur mémoire est réservé à la démo) ;
- le fournisseur `mock` est refusé.

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
