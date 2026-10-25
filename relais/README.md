# Relais

Application web mobile qui aide les proches aidants du Québec à coordonner les soins d'un parent et à
obtenir les services et les aides auxquels il a droit. Relais n'est pas un service de santé : il ne pose
aucun diagnostic et ne donne aucun conseil médical.

**Statut : étape 1 sur 6 livrée** (socle, authentification, consentements, écran d'urgence). Suivi dans
[`PROGRESS.md`](PROGRESS.md).

## Démarrer

```bash
npm ci
npm run dev            # nécessite .env.local (voir .env.example) et un projet Supabase
npm test               # tests unitaires et de composants (Vitest)
npm run test:db        # migrations + tests RLS sur PostgreSQL 16 (local ou DATABASE_URL)
npm run test:e2e       # parcours sur téléphone (Playwright + axe + Lighthouse), faux Supabase local
```

Démonstration locale sans Supabase : `node tests/e2e/fake-supabase.mjs` puis
`npx vite --mode e2e` ; code de connexion `123456`, code TOTP `654321` (adresses commençant par
`intervenante` ou `admin` pour les rôles internes).

| Document                                       | Contenu                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture, flux de données, IA, sécurité et vie privée         |
| [`docs/schema.sql`](docs/schema.sql)           | Schéma cible des 6 étapes (les migrations livrées font foi)       |
| [`docs/PLAN.md`](docs/PLAN.md)                 | Plan en 6 étapes livrables et portes avant le pilote              |
| [`docs/VALIDATIONS.md`](docs/VALIDATIONS.md)   | Points à faire valider par un juriste et une travailleuse sociale |
