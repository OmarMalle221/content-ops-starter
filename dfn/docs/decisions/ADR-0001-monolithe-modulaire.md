# ADR-0001 — Monolithe modulaire plutôt que microservices

| Champ     | Valeur                                                      |
| --------- | ----------------------------------------------------------- |
| Statut    | Accepté                                                     |
| Date      | 2026-10-11                                                  |
| Décideurs | Équipe produit et ingénierie DFN                            |
| Portée    | Architecture globale (`apps/api`, `apps/web`, `packages/*`) |

## Contexte

DFN couvre six modules (Protect, Wallet, Transfer, Business, API, DDA) partageant les mêmes entités fondamentales : utilisateurs, organisations, registre comptable, documents, audit, moteur de risque. L'équipe est réduite, la plateforme est en mode sandbox et le besoin dominant est la **cohérence transactionnelle** : une libération de jalon doit, dans une même transaction base de données, changer l'état du jalon, écrire au registre, enregistrer l'événement et produire l'audit. Les exigences de conformité (traçabilité, réversibilité, isolation par organisation) rendent les écritures distribuées coûteuses et risquées.

Alternatives envisagées : microservices par module, « serverless » par fonction, monolithe non structuré.

## Décision

Construire un **monolithe modulaire** :

- une seule API NestJS (`apps/api`) organisée en modules Nest alignés sur les domaines (auth, organizations, verification, transactions, documents, disputes, ledger, risk, admin, sandbox-partner) ;
- une seule application web Next.js (`apps/web`) ;
- la logique métier partagée et pure est isolée dans des paquets du monorepo pnpm : `@dfn/shared` (énumérations, machines à états, RBAC, schémas zod, monnaie), `@dfn/financial-ledger`, `@dfn/compliance`, `@dfn/payment-adapters`, `@dfn/contracts`, `@dfn/database`, `@dfn/ui` ;
- une seule base PostgreSQL, un seul schéma Prisma ; Redis/BullMQ pour les tâches asynchrones ;
- les frontières entre modules sont des **interfaces TypeScript** (adaptateurs, services) et non des frontières réseau.

## Conséquences

Positives :

- Transactions ACID couvrant état métier + registre + audit (`LedgerService.post(instruction, tx)` acceptant un client Prisma transactionnel).
- Un seul déploiement, un seul `.env`, un seul garde `DFN_MODE` à auditer.
- Refactorisations transverses simples ; typage de bout en bout (énumérations Prisma miroitées dans `@dfn/shared`).
- Tests d'intégration rapides sur une base unique (`TEST_DATABASE_URL`).

Négatives / risques :

- Le couplage peut dériver si les modules s'appellent directement ; mitigation : règles de dépendance (les paquets `packages/*` ne dépendent jamais de `apps/*` ; `@dfn/shared` ne dépend d'aucun autre paquet métier), revue de code.
- Scalabilité horizontale uniforme (impossible de scaler le seul module Transfer) ; acceptable en sandbox et pour les volumes visés en Phase 3–4.
- Un incident affecte tous les modules ; mitigation : files BullMQ isolées, limitation de débit par route.

## Alternatives

| Alternative              | Raison du rejet                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Microservices par module | Écritures distribuées (saga) pour chaque libération de jalon ; complexité opérationnelle et d'audit disproportionnée pour l'équipe et le stade |
| Fonctions serverless     | Transactions longues avec verrouillage de lignes mal adaptées ; démarrage à froid ; difficulté à garantir l'ordre des événements               |
| Monolithe sans paquets   | Logique métier non testable isolément ; impossibilité de réutiliser les machines à états et le RBAC entre web et API                           |

Révision prévue : lorsque le module Transfer (Phase 4) ou l'API publique (Phase 5) imposera des profils de charge différents, extraire d'abord les **workers** (files) avant toute extraction de service.

## Règles de dépendance vérifiables

| Règle                                                                                                                                      | Vérification                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `packages/*` ne dépendent jamais de `apps/*`                                                                                               | Lint des `package.json` en CI          |
| `@dfn/shared` ne dépend d'aucun autre paquet métier                                                                                        | Idem                                   |
| `@dfn/financial-ledger`, `@dfn/compliance`, `@dfn/payment-adapters`, `@dfn/contracts` ne dépendent que de `@dfn/shared` et `@dfn/database` | Idem                                   |
| `apps/web` n'importe jamais `@dfn/database` (client Prisma)                                                                                | Énumérations miroir dans `@dfn/shared` |
| Un module Nest n'accède aux tables d'un autre domaine que via le service de ce domaine                                                     | Revue de code                          |
