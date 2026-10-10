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
| `npm run test:pg` | Suite d'intégration sur l'adaptateur Postgres (PostgreSQL 16 local + migrations, une base par test) |
| `npm run test:e2e` | Parcours critiques, sécurité, accessibilité (axe) et mobile (Playwright) |
| `npm run typecheck` / `npm run lint` | TypeScript strict, ESLint |

## Structure

```
src/
  domain/          Règles métier pures : monnaie (bigint), VIN, machine à états, registre, antifraude, documents
  server/
    ports/         Interfaces : base de données, PaymentProvider, KYC, filtrage, stockage, antivirus
    adapters/      Mémoire (démo/tests), Postgres (schéma Supabase), MockPaymentProvider et autres fournisseurs simulés
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

- **Persistance.** Par défaut, la démo et les tests utilisent un adaptateur mémoire transactionnel : la démo doit alors tourner sur **un seul processus Node**. Avec `DATABASE_URL`, l'adaptateur Postgres utilise le schéma Supabase (RLS, registre et audit en ajout seul) ; la même suite d'intégration passe sur les deux adaptateurs. Il a été testé sur PostgreSQL 16 local et en CI, **pas encore sur un projet Supabase réel**. Ses unités de travail sont sérialisées par un verrou global (débit limité, voir [mise en production](docs/PRODUCTION_READINESS.md)). Les enregistrements fictifs du partenaire simulé y sont conservés dans un schéma séparé (`trustcargo_sim`), qui ne fait pas partie des livres de TrustCargo.
- **Authentification.** La connexion par profil de démonstration et le TOTP local sont implémentés. Supabase Auth (lien magique par e-mail, profil, MFA TOTP exigeant AAL2) est branché derrière `AUTH_PROVIDER=supabase` et le stockage Supabase privé derrière `STORAGE_PROVIDER=supabase`. Ces deux intégrations sont testées **uniquement avec des doublures** (faux serveur, faux `fetch`) : rien n'a été exécuté contre un projet Supabase réel depuis l'environnement de développement (voir [SECURITY](docs/SECURITY.md#supabase-auth-et-supabase-storage)).
- **Fournisseurs.** Paiement, KYC, filtrage sanctions et antivirus sont des adaptateurs simulés derrière des interfaces. Aucun fournisseur réel de paiement, de KYC ou de filtrage n'est intégré. Le stockage des documents est en mémoire par défaut, ou dans Supabase Storage (voir ci-dessus).
- **Courriels.** Les invitations sont des liens à usage unique affichés une seule fois. Les invitations destinées à un compte existant apparaissent aussi dans son tableau de bord. TrustCargo n'envoie aucun e-mail ; seuls les liens de connexion de Supabase Auth sont envoyés par Supabase lorsque `AUTH_PROVIDER=supabase`.
