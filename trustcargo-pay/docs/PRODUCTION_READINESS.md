# Avant toute mise en production financière

TrustCargo Pay **ne doit traiter aucun fonds réel** tant que les étapes ci-dessous ne sont pas validées. Le code empêche déjà de démarrer en mode `production` avec le fournisseur simulé (`src/server/config.ts`).

> Les points réglementaires listés ici servent à **préparer le travail avec des conseillers juridiques et de conformité qualifiés** au Canada (fédéral et Québec) et au Sénégal (UEMOA). Ils ne constituent pas un avis juridique et ne sont pas exhaustifs. Aucune autorisation n'a été obtenue à ce jour.

## 1. Cadre juridique et partenaire financier

- [ ] Qualification juridique du service (séquestre, services de paiement, mandat, place de marché) dans chaque juridiction : Canada, Québec, Sénégal / UEMOA.
- [ ] Analyse des régimes potentiellement applicables. À faire confirmer par un conseil :
  - Canada : LRPCFAT / FINTRAC (entreprise de services monétaires) ; Loi sur les activités associées aux paiements de détail (Banque du Canada).
  - Québec : Loi sur les entreprises de services monétaires (Revenu Québec) ; protection des renseignements personnels (Loi 25).
  - Sénégal / UEMOA : réglementation BCEAO des services de paiement et de la monnaie électronique ; CENTIF (LBC/FT) ; loi sur les données personnelles (CDP).
  - Règles de change applicables aux flux CAD/XOF.
- [ ] Sélection d'un **partenaire juridiquement habilité** (fiducie, établissement de paiement ou banque) pour détenir les fonds et exécuter les instructions. Contrat précisant :
  - qui détient les fonds ;
  - qui a le pouvoir d'instruction ;
  - les SLA ;
  - la gestion des litiges et des gels ;
  - la responsabilité de chaque partie.
- [ ] Conditions générales, politique de confidentialité, procédure de plainte, mentions légales (FR/EN), revues par un conseil.
- [ ] Assurance (responsabilité professionnelle, cyber).

## 2. Conformité opérationnelle

- [ ] Programme LBC/FT : évaluation des risques, KYC/KYB proportionnés, bénéficiaires effectifs, personnes politiquement exposées, déclarations de soupçon, conservation des registres.
- [ ] Fournisseur **KYC/KYB habilité**, branché derrière `IdentityVerificationProvider`, avec callbacks signés.
- [ ] Fournisseur de **filtrage sanctions/PPE**, branché derrière `ScreeningProvider`, avec filtrage continu.
- [ ] Sources habilitées pour les **véhicules** : vol, sûretés/liens (RDPRM au Québec, par exemple), historique. Ajouter un port `VehicleHistoryProvider`. Le contrôle VIN local ne certifie rien.
- [ ] Exigences douanières d'exportation (déclaration d'exportation, délais de présentation au port) et d'importation au Sénégal. Les documents attendus par corridor sont paramétrés dans `corridors`.
- [ ] Procédures écrites : revue des alertes, gels, levée de gel à quatre yeux, décisions de litige, contrepassations.

## 3. Technique

- [ ] **Adaptateur de persistance Postgres** implémentant `Db`/`UnitOfWork` (transactions SQL, verrou optimiste, `post_ledger_journal`, chaîne d'audit avec retry sur `40001`), testé contre la même suite d'intégration que l'adaptateur mémoire.
- [ ] Appliquer les migrations sur un projet Supabase de **staging**, exécuter `supabase/tests/rls_test.sql` et les contrôles `supabase db lint`, puis appliquer en production.
- [ ] Supabase Auth + MFA (AAL2) ; supprimer la connexion par profil (`DEMO_ALLOW_PERSONA_LOGIN=false`). Code branché (`AUTH_PROVIDER=supabase`), testé avec des doublures seulement : à valider sur un projet Supabase **dédié** (voir [DEPLOYMENT](DEPLOYMENT.md#supabase-auth-et-supabase-storage)).
- [ ] Adaptateur `PaymentProvider` du partenaire réel :
  - signatures webhook selon sa spécification ;
  - mTLS si proposé ;
  - liste d'IP ;
  - idempotence ;
  - relevés de réconciliation quotidiens.
- [ ] Supabase Storage privé, antivirus réel, chiffrement au repos (natif), durées des URL signées. Adaptateur branché (`STORAGE_PROVIDER=supabase`), testé avec un faux `fetch` seulement.
- [ ] Limitation de débit distribuée, file de tâches pour les relances (outbox), tâches planifiées : réconciliation quotidienne, expiration des invitations, relances des versements `REQUESTED`.
- [ ] Observabilité : journaux structurés centralisés, métriques, alertes. Points à surveiller :
  - balance du registre ;
  - chaîne d'audit ;
  - événements partenaires en échec ;
  - écarts de réconciliation.
- [ ] Sauvegardes PITR, test de restauration documenté, plan de continuité.
- [ ] Pentest externe, revue de code sécurité, analyse des dépendances (`npm audit`, Renovate déjà présent au niveau du dépôt).
- [ ] Accessibilité : audit manuel WCAG 2.2 AA (navigation clavier, lecteurs d'écran) en complément des tests axe automatisés.

## 4. Mise en service progressive

1. Pilote fermé en **sandbox** du partenaire avec des montants fictifs.
2. Pilote réel avec un nombre limité de vendeurs vérifiés, des plafonds bas par transaction, une revue humaine de chaque versement et une réconciliation quotidienne.
3. Relèvement progressif des plafonds selon les indicateurs : litiges, alertes, écarts.
