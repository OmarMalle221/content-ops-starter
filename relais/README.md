# Relais

Application web mobile qui aide les proches aidants du Québec à coordonner les soins d'un parent et à
obtenir les services et les aides auxquels il a droit. Relais n'est pas un service de santé : il ne pose
aucun diagnostic et ne donne aucun conseil médical.

**Statut : étapes 1 à 5 sur 6 livrées** (socle, consentements, écran d'urgence ; dossier familial et
membres ; documents, lecture automatique pseudonymisée et chronologie ; navigateur de droits ; tâches,
agenda, rappels et page « Préparer un rendez-vous »). Suivi dans [`PROGRESS.md`](PROGRESS.md).

## Démarrer

```bash
npm ci
npm run dev            # nécessite .env.local (voir .env.example) et un projet Supabase
npm test               # tests unitaires et de composants (Vitest)
npm run test:db        # migrations + tests RLS sur PostgreSQL 16 (local ou DATABASE_URL)
npm run test:e2e       # parcours sur téléphone (Playwright + axe + Lighthouse), faux Supabase local
npm run test:ai-live   # extraction réelle avec Claude (ANTHROPIC_API_KEY requis), cible < 30 s
```

Démonstration locale sans compte Supabase (PostgreSQL 16 requis) :
`bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs`, puis `npx vite --mode e2e`. Code de
connexion `123456`, code TOTP `654321` (adresses commençant par `intervenante` ou `admin` pour les rôles
internes). Les données passent par la vraie base migrée, sous RLS ; les fonctions serveur (lecture des
documents, explications, lettres, URL signées, suppressions) tournent avec une IA simulée, sans appel
réseau ; les rappels par courriel se déclenchent par `POST /functions/v1/send-reminders` avec l'en-tête
`x-relais-cron-secret: test-cron-secret` et restent en mémoire (jamais envoyés). Avec
`RELAIS_DEMO_SEED=1` devant la première commande, deux familles fictives sont chargées
(`claire.demo@example.test`, `marc.demo@example.test`, `denis.demo@example.test`).

| Document                                       | Contenu                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture, flux de données, IA, sécurité et vie privée         |
| [`docs/schema.sql`](docs/schema.sql)           | Schéma cible des 6 étapes (les migrations livrées font foi)       |
| [`docs/PLAN.md`](docs/PLAN.md)                 | Plan en 6 étapes livrables et portes avant le pilote              |
| [`docs/VALIDATIONS.md`](docs/VALIDATIONS.md)   | Points à faire valider par un juriste et une travailleuse sociale |
