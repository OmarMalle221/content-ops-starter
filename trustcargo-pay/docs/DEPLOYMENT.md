# Déploiement et environnements

## Environnements

| Environnement | `TRUSTCARGO_MODE` | Paiement | Données | Usage |
| --- | --- | --- | --- | --- |
| Local | `demo` | `mock` | Mémoire, scénarios fictifs | Développement, démonstration |
| Staging | `demo`, puis `production` avec la sandbox du partenaire | `mock`, puis sandbox | Projet Supabase dédié | Recette, tests E2E, tests RLS sur Supabase réel |
| Production | `production` | Partenaire habilité **uniquement** | Projet Supabase dédié, PITR | Après validation de [PRODUCTION_READINESS](PRODUCTION_READINESS.md) |

Chaque environnement a ses propres secrets, son propre projet Supabase et ses propres clés partenaire. Aucune donnée réelle ne doit circuler hors de la production.

## Variables

Voir [`.env.example`](../.env.example). En production :

- `SESSION_SECRET` est obligatoire, sinon l'application refuse de démarrer ;
- le fournisseur `mock` est refusé.

## Démo (état actuel)

L'état de la démo est **en mémoire, par processus**. Il faut donc un seul processus Node de longue durée :

```bash
npm ci && npm run build
TRUSTCARGO_MODE=demo SESSION_SECRET=$(openssl rand -base64 48) \
MOCK_PROVIDER_WEBHOOK_SECRET=$(openssl rand -hex 24) APP_URL=https://demo.example.com \
npm start
```

Cibles adaptées : un conteneur unique (Fly.io, Railway, Render, Cloud Run avec `max-instances=1`) ou une VM.

Les plateformes serverless multi-instances (Netlify, Vercel Functions) ne conviennent **pas** tant que l'adaptateur Postgres n'est pas branché : chaque instance aurait des données différentes. Le `netlify.toml` à la racine du dépôt concerne le site existant, pas cette application.

Un redémarrage ou l'action « Réinitialiser la démo » (administratrice plateforme) recrée les scénarios.

## Base de données

```bash
npm run test:db                        # migrations + tests RLS/registre sur PostgreSQL 16 local
supabase link --project-ref <ref>      # staging d'abord
supabase db push
```

## CI/CD

Le workflow `.github/workflows/trustcargo-pay.yml` contient trois jobs.

1. **checks** : Prettier, ESLint, TypeScript strict, Vitest (unitaires + intégration).
2. **database** : PostgreSQL 16 (service), migrations Supabase, tests RLS et d'intégrité du registre.
3. **e2e** : build de production, Playwright. Couvre les parcours critiques, la sécurité, les en-têtes, l'accessibilité (axe) et le mobile.

Déploiement recommandé :

- fusion sur `main` → staging automatique ;
- promotion manuelle vers la production, avec application des migrations approuvée ;
- pas de migration destructive sans plan de retour arrière.
