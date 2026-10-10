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

- [x] **Adaptateur de persistance Postgres** (`src/server/adapters/postgres/`) implémentant `Db`/`UnitOfWork` : transaction SQL par unité de travail, rôle `service_role`, verrou optimiste, chaîne d'audit vérifiée par la base, nouvelle tentative sur `40001`/`40P01`. La même suite d'intégration passe sur les deux adaptateurs (`npm test` en mémoire, `npm run test:pg` sur PostgreSQL 16 + migrations, aussi en CI). Testé uniquement sur PostgreSQL 16 local et le service CI, **pas encore sur un projet Supabase**. Limites connues du MVP :
  - un verrou consultatif global sérialise toutes les unités de travail (même garantie que l'adaptateur mémoire, entre processus) : le débit est d'une unité de travail à la fois par base. À remplacer par des verrous ciblés (par transaction) avant une charge réelle ;
  - une erreur SQL annule toute l'unité de travail (pas de reprise partielle dans une même unité) ;
  - les enregistrements du **partenaire simulé** (instructions, virements, relevé) sont conservés dans le schéma `trustcargo_sim` (migration `20261010000001_simulated_partner.sql`) : ils survivent à un redémarrage et sont partagés entre instances. Ce sont les données **fictives du faux partenaire, jamais les livres de TrustCargo**, écrites dans leurs propres transactions courtes (pool de connexions séparé), hors de toute unité de travail. Seul le compteur de panne simulée (`simulateOutage`) reste en mémoire du processus : avec plusieurs instances, seule l'instance qui a reçu la demande échoue à ses prochains appels. Ce schéma disparaît avec l'adaptateur du partenaire réel ;
  - les données de démonstration sont créées au premier démarrage sur une base vide (jamais en production) ; la réinitialisation de la démo est refusée sur Postgres (enregistrements en ajout seul). En production, les données de référence (corridors, connexion partenaire) sont à provisionner par migration ou procédure d'exploitation ;
  - premier démarrage : un seul processus, sinon deux instances peuvent tenter le même amorçage (l'une échoue sur les contraintes d'unicité).
- [ ] Appliquer les migrations sur un projet Supabase de **staging**, exécuter `supabase/tests/rls_test.sql` et les contrôles `supabase db lint`, puis appliquer en production.
- [ ] Supabase Auth + MFA (AAL2) ; supprimer la connexion par profil (`DEMO_ALLOW_PERSONA_LOGIN=false`).
- [ ] Adaptateur `PaymentProvider` du partenaire réel :
  - signatures webhook selon sa spécification ;
  - mTLS si proposé ;
  - liste d'IP ;
  - idempotence ;
  - relevés de réconciliation quotidiens.
- [ ] Supabase Storage privé, antivirus réel, chiffrement au repos (natif), durées des URL signées.
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
