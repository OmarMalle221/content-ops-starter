# TrustCargo Pay

Infrastructure de confiance transactionnelle pour le commerce international. Le MVP couvre l'achat et l'exportation de véhicules d'occasion entre le **Canada et le Sénégal**.

> **Environnement de démonstration : aucun fonds réel.**
> TrustCargo Pay n'est pas une banque et ne détient aucun fonds. Le MVP fonctionne **uniquement en mode simulation**. Les paiements passent par un partenaire financier simulé (`MockPaymentProvider`). La vérification d'identité et le filtrage sanctions sont simulés aussi. Aucun séquestre réel n'est proposé tant qu'un partenaire juridiquement habilité n'est pas intégré et que la conformité requise n'est pas validée (voir [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md)).

## Démarrage rapide

```bash
cd trustcargo-pay
npm ci
npm run dev            # http://localhost:3000 (démo pré-remplie, données fictives)
```

Sur la page d'accueil, choisissez un profil fictif. Les profils du back-office passent par une vérification TOTP ; en démo, le code courant est affiché sous le formulaire.

| Profil | Rôle | Scénario conseillé |
| --- | --- | --- |
| Julien Tremblay | Vendeur (Autos Saint-Laurent Export, Montréal) | Créer une transaction (assistant en 7 étapes), déposer des preuves |
| Awa Ndiaye | Acheteuse (Dakar) | Valider le jalon « Preuve d'expédition » du RAV4, payer le CR-V (simulateur) |
| Cheikh Fall | Acheteur professionnel, identité non vérifiée | Rejoindre la Corolla, faire la vérification KYC simulée, accepter le contrat |
| Marie-Ève Gagnon | Inspectrice | Accès limité : rapport d'inspection et photos, pas de paiements |
| Ibrahima Sarr | Transitaire | Accès limité aux documents d'expédition |
| Sophie Martin | Analyste conformité | Alertes de risque, KYC, mesures de gel |
| Thomas Roy | Contrôle documentaire + conformité | Revue des documents, levée de gel (principe des quatre yeux) |
| Karim Benali | Gestionnaire des litiges | Décider le litige du Lexus RX 350 |
| Léa Bouchard | Opérations financières | Registre, réconciliation, simulateur partenaire, contrepassation |
| Nadia Haddad | Administratrice plateforme | Corridors, paramètres de sécurité, réinitialisation de la démo (pas d'accès aux transactions) |
| Paul Lefebvre | Auditeur | Lecture seule, journal d'audit chaîné |

Toutes les données sont fictives : les noms sont inventés et les courriels utilisent le domaine réservé `.test`. Les fichiers générés portent la mention « DOCUMENT FICTIF ».

### Scénarios pré-chargés

1. **Toyota RAV4 2021, 18 500 CAD.** Jalon 1 versé, jalon 2 (preuve d'expédition) en attente de validation par l'acheteuse.
2. **Honda CR-V 2019, 14 200 CAD.** Contrat accepté, en attente du paiement (simulé).
3. **Toyota Corolla 2020, 9 800 CAD.** Invitation en attente pour un acheteur non vérifié.
4. **Lexus RX 350 2020, 27 900 CAD.** En litige. Le connaissement porte un VIN différent et un autre destinataire. Alertes critiques ouvertes.
5. **Toyota Highlander 2019, 21 750 CAD.** Terminée, trois versements exécutés.

Ces scénarios ne sont pas insérés en base « à la main ». Ils sont produits en exécutant les vrais services et les webhooks signés du partenaire simulé, avec une horloge décalée. Statuts, registre, chaîne d'audit et alertes sont donc exactement ceux que produirait le produit.

## Scripts

| Commande | Effet |
| --- | --- |
| `npm run dev` | Serveur de développement |
| `npm run build && npm start` | Build et serveur de production |
| `npm test` | Tests unitaires et d'intégration (Vitest) |
| `npm run test:db` | Schéma Supabase, RLS et intégrité du registre sur PostgreSQL 16 |
| `npm run test:e2e` | Parcours critiques, sécurité, accessibilité (axe) et mobile (Playwright) |
| `npm run typecheck` / `npm run lint` | TypeScript strict, ESLint |

## Structure

```
src/
  domain/          Règles métier pures : monnaie (bigint), VIN, machine à états, registre, antifraude, documents
  server/
    ports/         Interfaces : base de données, PaymentProvider, KYC, filtrage, stockage, antivirus
    adapters/      Mémoire (démo/tests), MockPaymentProvider et autres fournisseurs simulés
    services/      Services métier : autorisation côté serveur, unité de travail, audit chaîné
    security/      HMAC, TOTP, signatures webhook, URL signées, limitation de débit
    demo/          Profils et scénarios fictifs
    app.ts         Racine de composition (le seul endroit où l'on choisit les adaptateurs)
  app/             Next.js App Router : pages, server actions, API REST /api/v1
  components/      Design system (shadcn/ui), écrans transaction, back-office
  i18n/            Français et anglais
supabase/          Migrations (schéma, intégrité du registre, RLS) et tests SQL
tests/             unit/, integration/, e2e/
docs/              Architecture, workflows, données, sécurité, déploiement, mise en production
```

## Documentation

- [Architecture et décisions](docs/ARCHITECTURE.md)
- [Moteur de transaction et workflows](docs/WORKFLOWS.md)
- [Modèle de données](docs/DATA_MODEL.md)
- [Sécurité](docs/SECURITY.md)
- [Déploiement et environnements](docs/DEPLOYMENT.md)
- [Avant toute mise en production financière](docs/PRODUCTION_READINESS.md)

## État du MVP et limites connues

- **Persistance.** La démo et les tests utilisent un adaptateur mémoire transactionnel. Le schéma Supabase (40 tables, RLS) est écrit et testé sur PostgreSQL 16, mais l'**adaptateur Postgres/Supabase des services n'est pas encore branché**. La démo doit donc tourner sur **un seul processus Node** : elle n'est pas compatible avec un hébergement serverless multi-instances.
- **Authentification.** La connexion par profil de démonstration et le TOTP sont implémentés. L'intégration Supabase Auth (comptes réels, MFA AAL2) n'est pas branchée.
- **Fournisseurs.** Paiement, KYC, filtrage sanctions, antivirus et stockage sont des adaptateurs simulés derrière des interfaces. Aucun fournisseur réel n'est intégré.
- **Courriels.** Les invitations sont des liens à usage unique affichés une seule fois. Les invitations destinées à un compte existant apparaissent aussi dans son tableau de bord. Aucun e-mail n'est envoyé.
