# Relais — PROGRESS

Dernière mise à jour : 2026-10-25 (étape 5)

## Fait

### Démarrage

- Proposition : [architecture](docs/ARCHITECTURE.md), [plan en 6 étapes](docs/PLAN.md),
  [schéma cible et politiques RLS](docs/schema.sql), [points à valider](docs/VALIDATIONS.md).

### Étape 1 — Socle, authentification et consentements (livrée)

- **Base de données** (`supabase/migrations/20261026000001_foundation.sql`) : `users`, `consent_texts`,
  `consents`, `resources`, `access_log`, `ai_calls`, fonctions d'accès `private.*`, fonctions
  `grant_consent`, `revoke_consent`, `export_my_data`, `delete_my_account`. Données de référence générées
  depuis le dépôt (`supabase/reference/`) : 4 versions de textes de consentement, 4 ressources d'aide.
- **PWA** (Vite + React + TypeScript, installable, en français) : accueil public, connexion par code à
  6 chiffres reçu par courriel, accueil des nouveaux avec 4 consentements distincts (aucun pré-coché, seule
  la politique de confidentialité est obligatoire), prénom, « Mes consentements » (accorder, retirer avec
  confirmation, nouvelle version à accepter), « Mon compte » (nom, téléchargement de mes renseignements en
  JSON, déconnexion, suppression du compte), vérification en deux étapes obligatoire pour intervenantes et
  admins (une inscription abandonnée est retirée avant d'en recommencer une), page publique « Aide immédiate » visible dans l'en-tête de chaque page, politique de
  confidentialité publique.
- **Détresse** : détecteur déterministe (`src/shared/distress`) et écran d'urgence branchés sur le champ
  `FreeTextField`, que toutes les saisies libres des étapes suivantes utiliseront. Numéros lus dans
  `resources`, avec une copie de secours tirée de la même source. Ordre adapté : 911 d'abord en cas de
  danger, 9-8-8 d'abord pour des idées suicidaires, Info-Social 811 d'abord pour l'épuisement aigu.
- **Journaux** : journaliseur à liste blanche (aucun texte libre, aucun message d'erreur) ; journal des
  accès écrit par la base pour chaque accord, retrait, export et suppression.
- **Sécurité** : CSP stricte (aucun script ni style externe ou en ligne), mêmes en-têtes en préproduction
  et sur Netlify (vérifié par un test) ; aucune donnée du dossier mise en cache sur le téléphone.
- **Tests, tous verts en local** :
  - Base : 72 vérifications RLS sur PostgreSQL 16 (structure, anon, profil, consentements, journal,
    ressources, rôles avec et sans MFA, export, suppression), plus un test qui refuse un texte de
    consentement modifié sans nouvelle version.
  - Unitaires et composants : 205 tests (Vitest). Corpus de détresse : 51 phrases qui doivent toujours
    déclencher, 33 qui ne le doivent pas. Les 51 sont aussi saisies dans le vrai champ, et l'écran avec le
    911 doit apparaître (critère d'acceptation).
  - Bout en bout : 10 parcours sur Pixel 7 (Playwright) contre un faux Supabase local, axe WCAG 2.2 AA sur
    chaque écran, aucune violation de CSP.
  - Lighthouse accessibilité mobile : 100 sur les 8 pages (publiques et connectées), seuil 90.
- **CI** : `.github/workflows/relais.yml` (format, lint, types, données de référence, Vitest ;
  PostgreSQL 16 + RLS ; build, e2e, axe, Lighthouse). Verte sur GitHub.

### Étape 2 — Dossier et membres (livrée)

- **Base de données** (`supabase/migrations/20261027000001_care_files.sql`) : `care_files`,
  `care_file_members`, `care_file_invitations`, `care_recipients`, `care_needs`, `contacts` ; matrice
  d'accès `private.can_read` / `private.can_write` par zone (profil, coordination, santé, droits, gestion) ;
  fonctions `create_care_file`, `record_file_consent`, `create_invitation`, `accept_invitation`,
  `log_access`, `export_care_file`, `delete_care_file` ; `revoke_consent`, `delete_my_account` et
  `export_my_data` étendues. Nouveau texte de consentement « personne aidée » (à faire valider).
- **Consentement de la personne aidée** : formulaire signé (imprimable depuis Relais) enregistré par
  l'aidant, ou accord du représentant légal (mandat homologué, tutelle, procuration, autre ; nom
  obligatoire), ou accord donné par la personne elle-même depuis son accès. Sans consentement, la base
  refuse tout ajout. Si la personne retire elle-même son accord, l'aidant ne peut plus le rétablir par
  formulaire.
- **PWA** : mes dossiers, création guidée (nom → consentement → profil), aperçu, profil (année de
  naissance seulement), autonomie et services (renseignements de santé, saisie libre surveillée par le
  détecteur de détresse), contacts clés (appel en un geste), membres (niveaux complet, coordination,
  lecture seule ; retrait ; départ volontaire), invitations par lien partagé, journal des accès,
  paramètres (renommer, télécharger, supprimer). Les onglets et actions suivent les droits.
- **Invitations** : le lien porte le jeton dans le fragment (`#`), jamais transmis aux serveurs web ; il ne
  fonctionne que pour l'adresse invitée, pendant 7 jours ; il est retiré de l'adresse affichée et gardé le
  temps de se connecter. Une intervenante ne peut rejoindre qu'avec le rôle global `relais_worker`.
- **Tests de bout en bout sur la vraie base** : le faux Supabase traduit désormais chaque requête en SQL,
  exécuté sous le rôle et l'identité de l'appelant sur la base migrée (`scripts/test-db.sh --serve`) : les
  parcours vérifient la vraie RLS.
- **Tests, tous verts en local** :
  - Base : 154 vérifications RLS (chaque niveau d'accès × table × opération, intervenante avec et sans MFA,
    admin, personne extérieure, invitations expirées, remplacées ou à la mauvaise adresse, consentement et
    retrait, suppression qui ne laisse que sa trace). Un contrôle par mutation confirme qu'une matrice
    affaiblie fait échouer les tests.
  - Unitaires et composants : 219 tests (dont la matrice d'accès de l'interface et le formulaire de
    consentement).
  - Bout en bout : 15 parcours, dont 5 pour l'étape 2 (aidante, invitations et niveaux, saisie libre et
    écran d'urgence, export et suppression du dossier, accord donné puis retiré par la personne aidée).
  - Lighthouse accessibilité mobile : 100 sur les 18 pages auditées.
- **Accessibilité corrigée en route** : le focus passe au titre de la page même quand celle-ci charge ses
  données après la navigation.

### Étape 3 — Documents et extraction IA (livrée)

- **Base de données** (`supabase/migrations/20261028000001_documents.sql`) : `documents`,
  `document_extractions`, `medication_mentions`, `timeline_events`, `storage_deletion_queue` ; bucket privé
  `documents` (20 Mo, PDF/JPEG/PNG, dépôt seulement par l'auteur d'une entrée en attente, aucune lecture
  directe) ; fonctions `register_document`, `complete_document_upload`, `start_document_extraction`,
  `confirm_document`, `discard_extraction`, `delete_document`, `authorize_document_download`, et, pour le
  serveur seulement, `save_document_extraction`, `fail_document_extraction` ; `delete_care_file` et
  `export_care_file` (format `relais-dossier/2`) étendues aux documents.
- **Consentement distinct « Lecture automatique des documents »** (facultatif, au niveau du dossier) :
  donné par la personne aidée dans Relais, par formulaire signé (case « J'accepte / Je refuse » ajoutée au
  formulaire imprimable) ou par son représentant ; la base refuse toute lecture sans lui. Texte à faire
  valider (A17).
- **Fonctions serveur** (`supabase/functions/`) : `extract-document`, `get-document-url`,
  `delete-document`, `delete-care-file`. Logique indépendante de Deno (`_shared/handlers.ts`).
- **Pipeline** : texte du PDF lu sur le serveur → pseudonymisation (dictionnaire du dossier + motifs :
  NAM, NAS, numéros de dossier, date de naissance, adresses, codes postaux, téléphones, courriels, noms
  après un titre ou une étiquette) → Claude (sortie structurée validée par Zod) → garde-fous → ré-
  identification locale (NAM, NAS, date de naissance, code postal et numéros restent masqués) → brouillon.
  `ai_calls` : statut, modèle, jetons, durée, compteurs ; jamais de contenu.
- **PWA** : onglets « Documents » et « Chronologie » (selon les droits), photo ou fichier (photo réduite et
  réencodée sur le téléphone : métadonnées et GPS retirés), écran de relecture (garder, corriger,
  décocher chaque élément ; « à vérifier » ; rappel « aucun conseil médical » avec Info-Santé tiré des
  ressources ; saisies libres surveillées par le détecteur de détresse), saisie à la main quand la lecture
  automatique est impossible ou non autorisée, document original par lien signé de 60 s, suppression,
  chronologie reliée à ses sources, médicaments tels qu'écrits avec leur document.
- **Tests, tous verts en local** :
  - Base : 220 vérifications RLS (dont 66 pour l'étape 3 : dépôt Storage, lecture par niveau, intervenante
    avec et sans MFA, consentement de lecture automatique et retrait par la personne aidée, confirmation,
    saisie à la main, rejet, échec, suppression d'un document et du dossier avec inscription des fichiers à
    effacer). Contrôle par mutation : une politique affaiblie fait échouer les tests.
  - Unitaires et composants : 275 tests, dont pseudonymisation sur documents fictifs (14), garde-fous
    (13), pipeline avec IA simulée sur un PDF de 3 pages (10), fonctions serveur (8), relecture (11).
  - Bout en bout : 17 parcours, dont 2 pour l'étape 3 (PDF de 3 pages → brouillon en moins de 30 s avec IA
    simulée, aucun identifiant envoyé, relecture, chronologie, lien signé, suppression ; photo dont les
    métadonnées GPS sont retirées, saisie à la main, garde-fous, suppression du dossier et de ses fichiers).
  - Lighthouse accessibilité mobile : 100 sur les 21 pages auditées (dont documents, relecture,
    chronologie).
  - **Non exécuté ici : le test réel avec Claude** (`npm run test:ai-live`, cible < 30 s sur le PDF de
    3 pages), faute de clé d'API dans cet environnement.
- **Corrigé en route** : un nom en fin de ligne après un titre (« Dre … ») emportait la ligne suivante dans
  la pseudonymisation (trouvé par les tests de bout en bout) ; un brouillon rejeté ou remplacé était
  conservé : il est maintenant effacé.

### Étape 4 — Navigateur de droits (livrée)

- **Base de données** (`supabase/migrations/20261029000001_benefits.sql`) : `programs` (catalogue,
  version, source, état de vérification), `program_explanations` et `program_letter_templates` (cache de
  l'IA par version de fiche), `benefit_assessments` (réponses au questionnaire), `care_file_programs`
  (démarches du dossier : niveau, raisons, statut `to_explore` / `in_progress` / `obtained` / `refused`,
  notes, lettre, dates repéré → demandé → décision posées par la base), `program_checklist_items` (pièces
  à fournir : de la fiche ou ajoutées par la famille). Contrôles de la base : **aucun montant** dans une
  fiche (`$`, `%`, `€`, « dollars », « cents », « taux » refusés), fiche vérifiée = lien officiel + date +
  initiales, tout changement de contenu → nouvelle version « à vérifier » (sauf vérification du jour).
  Fonctions `save_benefit_assessment`, `program_for_ai` et, pour le serveur seulement,
  `save_program_explanation`, `save_program_letter_template`. `delete_care_file` et `export_care_file`
  (format `relais-dossier/3`) étendues aux démarches.
- **8 fiches « À VÉRIFIER », sans montant** (`src/content/programs.fr.json` → `supabase/reference/`) :
  crédit pour maintien à domicile des aînés, crédit pour personne aidante, PEFSAD, montant canadien pour
  aidant naturel, CIPH, programme d'adaptation de domicile, soutien à domicile du CLSC, Info-aidant et
  répit (L'Appui). Ressources ajoutées : Info-aidant, répertoire de répit de L'Appui, Ligne Aide Abus Aînés
  (section « Pour les proches aidants » de la page d'aide).
- **Moteur de règles sans IA** (`src/shared/benefits/engine.ts`) : critères JSON validés, logique à trois
  valeurs (« Je ne sais pas » → « à vérifier » plutôt qu'une exclusion), raisons = libellés de la fiche.
- **Fonctions serveur** `explain-program` et `draft-letter` : l'IA ne reçoit que la fiche ; garde-fous
  (aucun montant, aucun chiffre absent de la fiche, espaces réservés connus seulement) ; cache par version
  de fiche ; une sortie refusée n'est jamais mise en cache et l'écran dit « Je ne sais pas ».
- **PWA** : onglet « Droits » (questionnaire prérempli par le profil ; liste en trois groupes, les
  programmes peu probables repliés ; chaque carte porte la source, la date de vérification ou « Fiche À
  VÉRIFIER » et « Admissibilité à confirmer auprès de… ») ; fiche d'un programme (conditions, démarche,
  statut, pièces à cocher ou à ajouter, notes, explication simple, lettre dont les noms et la date sont
  ajoutés sur le téléphone) ; administration (`/admin`, rôle admin + vérification en deux étapes) des
  fiches (critères JSON vérifiés à la saisie, vérification datée avec initiales) et des ressources d'aide.
- **Familles fictives de démonstration** (`supabase/seed/demo_families.sql`, générées par le vrai moteur) :
  Claire et Marc pour Louise, 82 ans, à domicile ; Denis pour Roger, 79 ans, en RPA, en attente de CHSLD.
  Démonstration locale : `RELAIS_DEMO_SEED=1 bash scripts/test-db.sh --serve node
tests/e2e/fake-supabase.mjs`, puis `npx vite --mode e2e`, connexion `claire.demo@example.test` (code
  `123456`). Jamais en production.
- **Tests, tous verts en local** :
  - Base : 292 vérifications RLS (48 de plus : catalogue en lecture seule pour les familles, écriture admin
    avec MFA seulement, montants refusés, versionnage et vérification, évaluations et démarches par niveau
    d'accès, pièces de la fiche non supprimables, cache IA réservé au serveur, export et suppression) ;
    familles de démonstration appliquées par les vraies fonctions puis vérifiées (`demo_seed_test.sql`).
  - Unitaires et composants : 310 tests, dont moteur de règles en tables de vérité et les deux familles
    (12), garde-fous d'explication et de lettre (8), fonctions serveur avec IA simulée (7), écrans (8).
  - Bout en bout : 20 parcours, dont 3 pour l'étape 4 (famille A : questionnaire → 8 cartes sourcées,
    statut, pièces, explication puis cache, lettre sans aucun nom envoyé ; famille B : programmes peu
    probables repliés mais sourcés ; administration : montant refusé, vérification datée et signée,
    ressource vérifiée, « je ne sais pas » quand l'IA invente un montant).
  - Lighthouse accessibilité mobile : 100 sur les 28 pages auditées (dont droits, fiche d'un programme et
    les 5 pages d'administration).
- **Corrigé en route** : le statut d'une démarche et les cases des pièces ne changeaient qu'après la
  réponse du serveur (trouvé par les tests de bout en bout) ; ils changent tout de suite et reviennent en
  arrière si l'enregistrement échoue.

### Étape 5 — Coordination et rendez-vous (livrée)

- **Base de données** (`supabase/migrations/20261030000001_coordination.sql`) : `tasks` et `appointments`
  (zone « coordination »), `appointment_questions` et `journal_entries` (carnet de bord, zone « santé »),
  `reminder_deliveries`. La base impose l'auteur, la date et l'auteur d'une tâche faite, un responsable ou
  un accompagnateur membre du dossier, et libère les tâches d'un membre retiré. Une tâche liée à un
  document ou à une démarche ne peut être créée que par quelqu'un qui voit cette source. Fonctions
  réservées au serveur : `reminders_due` (des nombres seulement) et `record_reminder_sent`.
  `export_care_file` (format `relais-dossier/4`), `delete_care_file` et `export_my_data` étendues.
- **Rappels quotidiens** : fonction `send-reminders` appelée chaque matin par `pg_cron`
  (`supabase/cron/send_reminders.sql`, secret partagé), courriel au contenu fixe (« Vous avez 1 tâche à
  faire d'ici demain et 1 rendez-vous aujourd'hui ou demain dans Relais »), un lien et la façon d'arrêter.
  Envoi par Amazon SES en `ca-central-1`, signé SigV4 (vérifié sur les exemples officiels d'AWS), un
  courriel par personne et par jour au plus. Seulement pour qui a accepté « Rappels par courriel ».
- **PWA** : navigation du dossier en deux groupes (« Au quotidien », « Le dossier ») ; **Tâches** (à faire
  par échéance, retards signalés, « mes tâches », faites repliées, case cochée tout de suite) ; **Agenda**
  (rendez-vous par jour, à l'heure du Québec, accompagnement, contact) ; fiche d'un rendez-vous (questions
  à poser, **ajout au calendrier du téléphone** par un fichier .ics produit sur place : objet, heure et lieu
  seulement) ; **Préparer un rendez-vous** (page à imprimer sans IA, chaque élément avec sa source,
  lignes pour les réponses, impression notée au journal) ; **Carnet de bord** ; « Cette semaine » dans
  l'aperçu ; « Créer une tâche » depuis un « à faire » de document et depuis une démarche.
- **Familles de démonstration** enrichies : tâches, rendez-vous (dans les jours qui suivent la démo),
  question à poser, notes du carnet, tâche liée à la démarche du CIPH.
- **Tests, tous verts en local** :
  - Base : 343 vérifications RLS (51 de plus : tâches, agenda, questions et carnet par niveau d'accès,
    auteurs et dates non falsifiables, rappels réservés au serveur et sans contenu, un courriel par jour,
    membre retiré, export et suppression) ; contrôle par mutation (une lecture du carnet élargie ou un
    rappel compté pour tous font échouer les tests).
  - Unitaires et composants : 342 tests, dont signature SigV4 (5), fichier .ics (5), courriel de rappel
    (3), fonction de rappels (5), heures au Québec et changements d'heure (3), écrans (11).
  - Bout en bout : 22 parcours, dont 2 pour l'étape 5 (document → tâche → rendez-vous → questions →
    .ics → page à imprimer sourcée, accessible aussi en version imprimée → carnet ; rappel générique, un
    seul par jour, secret exigé).
  - Lighthouse accessibilité mobile : 100 sur les 34 pages auditées (dont tâches, agenda, rendez-vous,
    page à imprimer et carnet).
- **Non vérifié ici** : envoi réel par SES (aucun compte AWS dans cet environnement) ; la signature est
  vérifiée sur les exemples officiels, la requête SES sans réseau.

## En cours

- Rien. **Prochaine étape : 6 — Charge de l'aidant, demandes d'intervenante, mesures du pilote et passe
  finale (performance, accessibilité)**, à lancer sur ton feu vert.

## Décisions

| #   | Décision                                                                                                                                                                                     | Raison                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| D1  | Front Vite + React + TypeScript en PWA (pas de rendu serveur)                                                                                                                                | Même base que Rempart ; Netlify ne sert que des fichiers statiques                                                  |
| D2  | Code serveur dans des Edge Functions Supabase épinglées à `ca-central-1` (à partir de l'étape 2)                                                                                             | Les données de santé restent dans la région Canada ; clé IA côté serveur seulement                                  |
| D3  | Permissions appliquées par la base (RLS + fonctions `private.*`), matrice par zone de données                                                                                                | Un client modifié ne peut rien lire de plus                                                                         |
| D4  | Écritures bloquées sans consentement actif de la personne aidée ; écritures de santé bloquées sans consentement `health_information` de l'auteur                                             | Loi 25 appliquée dans la base, pas seulement à l'écran                                                              |
| D5  | Membre « coordination » : profil, tâches, rendez-vous, journal de bord, contacts ; ni documents, ni santé, ni droits                                                                         | Minimisation                                                                                                        |
| D6  | Bilan de l'aidant visible par son auteur seulement                                                                                                                                           | Confidentialité de l'aidant                                                                                         |
| D7  | Intervenantes et admins : rôle global + MFA obligatoire ; admin jamais membre d'un dossier par défaut                                                                                        | Règle « admin sans accès aux dossiers »                                                                             |
| D8  | Lecture des fichiers seulement par URL signée de 60 s émise et journalisée par une fonction serveur                                                                                          | Journal des accès fiable pour les documents                                                                         |
| D9  | Année de naissance au lieu de la date ; NAM jamais stocké en champ structuré                                                                                                                 | Minimisation                                                                                                        |
| D10 | Détecteur de détresse déterministe exécuté sur le téléphone ; numéros lus dans `resources`                                                                                                   | Déclenchement garanti et testable ; aucun numéro généré                                                             |
| D11 | Moteur de règles sans IA ; l'IA n'explique qu'à partir de la fiche ; lettres à espaces réservés remplis sur le téléphone                                                                     | Aucune invention ; aucun nom envoyé pour les lettres                                                                |
| D12 | Page « Préparer un rendez-vous » sans IA                                                                                                                                                     | Faits du dossier seulement                                                                                          |
| D13 | Courriels (code, rappels, invitations, avis) sans aucun contenu de santé                                                                                                                     | Règle 5                                                                                                             |
| D14 | Pas de cache hors ligne des données du dossier (seulement l'app)                                                                                                                             | Téléphones partagés                                                                                                 |
| D15 | Suppression d'un dossier : fichiers effacés par l'API Storage, puis purge en base ; bilans de l'aidant conservés                                                                             | Critère d'acceptation ; à confirmer par le juriste                                                                  |
| D16 | Connexion par code à 6 chiffres reçu par courriel, sans mot de passe                                                                                                                         | Fonctionne dans une PWA installée (un lien magique ouvrirait le navigateur)                                         |
| D17 | Consentements écrits seulement par `grant_consent` / `revoke_consent` ; une nouvelle version clôt l'accord précédent ; la politique ne se retire qu'en supprimant le compte                  | Historique complet et preuve de la version acceptée                                                                 |
| D18 | Textes de consentement versionnés dans le dépôt ; la base garde leur empreinte SHA-256 et refuse qu'une version publiée change                                                               | Preuve de ce qui a été affiché                                                                                      |
| D19 | Export et suppression du compte par fonctions SQL (pas de fonction serveur à l'étape 1)                                                                                                      | Moins de pièces ; testables sur PostgreSQL                                                                          |
| D20 | Écran d'urgence en `<dialog>` modal, avec repli plein écran pour les navigateurs sans `showModal` (anciens iPhone)                                                                           | L'écran ne doit jamais manquer de s'afficher                                                                        |
| D21 | Tests de bout en bout contre un faux Supabase local (Auth simulée ; données sur la vraie base, voir D29)                                                                                     | Tests reproductibles sans compte ; sert aussi aux démonstrations                                                    |
| D22 | Police Atkinson Hyperlegible servie par l'app ; aucune ressource externe (CSP)                                                                                                               | Lisibilité ; aucune adresse IP transmise à un tiers                                                                 |
| D23 | « Parler à une intervenante » absent de l'écran d'urgence jusqu'à l'étape 6                                                                                                                  | Pas de bouton qui ne fait rien sur un écran de crise                                                                |
| D24 | Ressources de départ (911, 9-8-8, Info-Social 811, Info-Santé 811) toutes « à vérifier », sans URL source                                                                                    | Les sites officiels n'étaient pas joignables d'ici ; la vérification revient à la TS (porte B3)                     |
| D25 | Invitations par lien que l'aidant partage lui-même (texto, courriel) plutôt que par un courriel envoyé par Relais                                                                            | Aucun fournisseur de courriel nécessaire à l'étape 2 ; les familles se textent                                      |
| D26 | Jeton d'invitation dans le fragment de l'adresse (`#`), lié à l'adresse invitée, valable 7 jours, stocké seulement sous forme d'empreinte                                                    | Jamais dans les journaux web ; un lien transféré ne sert à personne d'autre                                         |
| D27 | La personne aidée qui retire son accord ne peut pas être « recontredite » par un formulaire signé : seul son accord ou celui d'un représentant légal le rétablit                             | Autodétermination ; à valider par le juriste (A15)                                                                  |
| D28 | Création de dossier par une fonction (`create_care_file`), suppression du compte refusée tant qu'on est propriétaire d'un dossier                                                            | Pas de dossier orphelin ; pas de transfert de propriété en v0.1                                                     |
| D29 | Tests de bout en bout sur la base migrée (mini PostgREST du faux Supabase) au lieu d'une imitation en mémoire                                                                                | Les parcours vérifient la vraie RLS, les vrais déclencheurs et les vraies fonctions                                 |
| D30 | Q2 appliquée : API Anthropic derrière `LlmClient`, modèle `ANTHROPIC_MODEL` (défaut `claude-sonnet-5-5`), sortie structurée Zod, effort bas, 25 s sans nouvel essai, repli serveur sur refus | Cible de 30 s ; fournisseur remplaçable (Bedrock au Canada) sans toucher au reste                                   |
| D31 | Q3 appliquée : aucune image envoyée à l'IA ; photos et PDF numérisés notés à la main tant qu'aucun OCR au Canada n'est branché (`OcrClient`)                                                 | On ne pseudonymise qu'un texte (règle 6)                                                                            |
| D32 | Lecture automatique soumise à un consentement distinct du dossier (`ai_document_processing`), vérifié par la base                                                                            | Loi 25 : consentement explicite et distinct ; la personne peut refuser l'IA et garder Relais                        |
| D33 | Garde-fous déterministes après le modèle : conseil, interprétation ou chiffre absents du document retirés ; éléments introuvables tels qu'écrits marqués et décochés                         | Règles 1 et 3, vérifiables par des tests                                                                            |
| D34 | Ré-identification locale partielle : NAM, NAS, date de naissance, code postal et numéros de dossier restent masqués dans le brouillon                                                        | Minimisation : ces valeurs ne servent pas à la coordination                                                         |
| D35 | Rien n'entre au dossier sans `confirm_document` ; les « à faire » restent avec le document jusqu'à l'étape 5 (tâches) ; les rendez-vous datés vont à la chronologie                          | Pas de table de tâches avant l'étape 5                                                                              |
| D36 | Effacement Storage par file (`storage_deletion_queue`) remplie par la base avant la cascade, vidée par la fonction serveur                                                                   | La base ne peut pas effacer un objet Storage ; aucun fichier oublié si l'appel échoue                               |
| D37 | Logique des fonctions serveur sans dépendance à Deno ; le faux Supabase exécute ce même code avec une IA simulée                                                                             | Les parcours e2e testent le vrai code serveur, sans réseau ni clé                                                   |
| D38 | Brouillon rejeté ou remplacé effacé (une seule extraction par document)                                                                                                                      | Minimisation                                                                                                        |
| D39 | Photos réduites à 2000 px et réencodées en JPEG sur le téléphone ; PDF envoyés tels quels                                                                                                    | Aucune métadonnée (GPS, appareil) ne quitte le téléphone ; PDF lisibles par le serveur                              |
| D40 | Moteur de règles en TypeScript pur, sur le téléphone ; critères JSON validés dans chaque fiche ; « Je ne sais pas » rend un critère inconnu (→ « possible »)                                 | Règle 3 : aucune IA pour choisir ; ne pas exclure une aide faute d'information                                      |
| D41 | Seuls les programmes probables ou possibles entrent dans les démarches ; refaire le questionnaire met à jour le niveau sans toucher au statut ni aux pièces                                  | Les démarches en cours ne disparaissent pas quand une réponse change                                                |
| D42 | Aucun montant dans une fiche, contrôlé par la base ; l'explication renvoie le montant à l'organisme                                                                                          | Règle 3 ; les montants changent chaque année et dépendent du revenu                                                 |
| D43 | Fiche modifiée → nouvelle version « à vérifier », sauf vérification datée du jour (heure du Québec) ; fiche vérifiée = lien, date, initiales                                                 | Une vérification ne vaut que pour le contenu vérifié ; trace de qui a vérifié                                       |
| D44 | Explication et lettre produites à partir de la seule fiche, mises en cache par version ; `ai_calls` sans dossier                                                                             | Règles 3 et 6 ; coût et délai réduits ; aucune donnée du dossier vers l'IA                                          |
| D45 | Lettre à espaces réservés fixes, remplis sur le téléphone ; tout autre crochet devient « [À COMPLÉTER] »                                                                                     | Aucun nom envoyé ; rien n'est rempli au hasard                                                                      |
| D46 | Aucune question sur le revenu en v0.1                                                                                                                                                        | Minimisation ; les fiches disent quand le revenu compte et l'organisme tranche                                      |
| D47 | Familles fictives générées par le vrai moteur, appliquées par les fonctions et la RLS de l'application, démonstration locale seulement                                                       | La démonstration ne peut pas diverger des fiches ; aucun compte fictif en production                                |
| D48 | Carnet de bord et questions à poser en zone « santé » ; tâches et agenda en zone « coordination »                                                                                            | Les observations du quotidien sont des renseignements de santé ; un voisin qui conduit voit l'agenda, pas le carnet |
| D49 | Rappels : la base ne donne que des nombres à la fonction serveur ; courriel au texte fixe                                                                                                    | Aucun titre, nom ni lieu ne peut sortir dans un courriel (règle 5), même par erreur                                 |
| D50 | Courriel par l'API HTTPS d'Amazon SES en `ca-central-1`, signée SigV4 sans dépendance                                                                                                        | Les fonctions Edge n'ouvrent pas de connexion SMTP ; hébergement au Canada                                          |
| D51 | Fichier .ics produit sur le téléphone avec l'objet, l'heure et le lieu seulement                                                                                                             | Le calendrier du téléphone est souvent synchronisé ailleurs : minimisation                                          |
| D52 | Heures de l'agenda saisies et affichées à l'heure du Québec, changements d'heure compris                                                                                                     | Pilote au Québec ; un téléphone réglé ailleurs n'en décale pas les rendez-vous                                      |
| D53 | Page « Préparer un rendez-vous » sans IA : faits du dossier avec leur source, chronologie des 3 derniers mois                                                                                | Rien d'inventé ni d'interprété ; le professionnel voit d'où vient chaque élément                                    |
| D54 | Une note du carnet reste au dossier si son auteur supprime son compte (auteur effacé)                                                                                                        | Elle appartient à l'histoire du dossier ; à valider par le juriste (A19)                                            |

### Hypothèses appliquées en attendant les réponses aux questions bloquantes

- **Q1** : code dans `relais/` de ce dépôt ; base neuve sur la même pile que Rempart (Rempart n'est pas
  accessible ici). Déménagement vers un dépôt dédié possible à tout moment : `relais/` est autonome.
- **Q2** : appliquée à l'étape 3 : API Anthropic (D30), remplaçable par Bedrock au Canada si le modèle y
  est offert.
- **Q3** : appliquée à l'étape 3 : aucune image envoyée ; saisie à la main en attendant un OCR hébergé au
  Canada (D31).
- **Q4** : l'écran d'urgence dit seulement que Relais n'est pas un service d'urgence ; aucun délai promis.
- **Q5** : appliquée à l'étape 2 : sans consentement valide (personne ou représentant légal), la base refuse
  les renseignements sur la personne aidée ; la page de consentement explique que le dossier ne peut pas
  être accueilli pendant le pilote si le parent ne peut plus consentir et n'a pas de représentant.

## Questions ouvertes

### Bloquantes (posées le 2026-10-25, toujours sans réponse)

1. **Où vit le code, et que reprend-on de Rempart ?** Dépôt dédié recommandé ; accès au dépôt de Rempart ?
2. **Par où passe Claude ?** API Anthropic (traitement aux États-Unis ou « mondial ») ou Bedrock en région
   Canada si le modèle y est offert. Comptes existants ? (Hypothèse appliquée : API Anthropic.)
3. **Photos et PDF numérisés** : OCR au Canada puis pseudonymisation (recommandé), OCR sur le téléphone, ou
   image envoyée telle quelle avec consentement spécifique ? (Hypothèse appliquée : saisie à la main.)
4. **Intervenantes Relais** : combien, quel statut, quelles heures, quel délai de rappel promettre ? Avant
   l'étape 6.
5. **Parent inapte sans représentant** : ces familles font-elles partie du pilote ? (Hypothèse appliquée : non.)

### À vérifier dès qu'un projet Supabase existe (région `ca-central-1`)

- `delete_my_account` supprime une ligne de `auth.users` par SQL : à confirmer sur Supabase hébergé (sinon,
  passer par l'API d'administration dans une fonction serveur).
- Gabarits de courriel « code » (`supabase/templates/code.html`) et réglages Auth de
  `supabase/config.toml` à reproduire dans le tableau de bord ; SMTP au Canada (ex. Amazon SES).
- Région effective des Edge Functions : vérifier l'en-tête de réponse en préproduction.
- Déploiement des fonctions (`supabase functions deploy`) : vérifier que les imports de `src/shared`
  (hors du dossier `functions`) sont bien empaquetés ; sinon, les copier par un script de construction.
  Secrets : `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `RELAIS_APP_ORIGINS`.
- Lancer `ANTHROPIC_API_KEY=… npm run test:ai-live` : brouillon réel en moins de 30 s sur le PDF de
  3 pages (non exécuté ici, faute de clé), et vérifier que le repli serveur (`server-side-fallback`) est
  ouvert au compte.
- Conditions de traitement de l'API (conservation, entraînement, lieu) : à vérifier et à décrire dans la
  politique de confidentialité (règle 6, A3, A17).
- Tâche planifiée (`pg_cron` → fonction) qui reprend `storage_deletion_queue` et efface les dépôts
  abandonnés (`pending_upload` de plus de 24 h).
- Compte admin de l'équipe Relais : rôle `admin` à attribuer par SQL (`public.users.app_role`), MFA
  obligatoire à la première connexion.
- Rappels : compte Amazon SES en `ca-central-1` (domaine vérifié, sortie du bac à sable), secrets
  `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `RELAIS_EMAIL_FROM`, `RELAIS_APP_URL`,
  `RELAIS_CRON_SECRET` ; Vault (`relais_functions_url`, `relais_cron_secret`) puis
  `supabase/cron/send_reminders.sql`. Envoyer un premier rappel réel à une adresse de l'équipe.

### Avant le pilote : vérifier les 8 fiches à la source

Les fiches ont été rédigées à partir des pages officielles trouvées par recherche web (les sites de Revenu
Québec, de la RAMQ, de l'ARC et de la SHQ ne sont pas joignables depuis cet environnement). Une personne de
l'équipe doit relire chacune à la source, puis la marquer vérifiée dans `/admin/programmes` (initiales).
Points précis :

- PEFSAD : le lien pointe vers un dépliant PDF de la RAMQ ; trouver la page de référence.
- Montant canadien pour aidant naturel : lien vers la page anglaise de l'ARC ; trouver la page française.
- Programme d'adaptation de domicile : Montréal gère sa propre version ; décider s'il faut une fiche à part.
- Critères simplifiés volontairement (pas de revenu, pas de durée d'aide de 365 jours posée en question) :
  à valider par la travailleuse sociale (B8) avec les conditions exactes de chaque fiche.

### Non bloquantes

- Questions du bilan hebdomadaire et seuil : à valider par la travailleuse sociale.
- Lexique de détresse (`src/shared/distress/detect.ts`) et corpus (`tests/unit/distress-corpus.ts`) : à
  valider et compléter par la travailleuse sociale (B1).
- Textes de consentement (`src/content/consent-texts.fr.json`) : à faire valider par le juriste ;
  coordonnées de la personne responsable des renseignements personnels à fournir.
- Taille de l'application : 256 ko compressés au premier chargement (245 avant l'étape 5) ;
  découpage par page prévu à la passe de performance de l'étape 6.
- Revérification périodique des fiches (ex. rappel aux admins pour toute fiche vérifiée il y a plus de
  12 mois) : le fournisseur de courriel existe maintenant ; à ajouter à l'étape 6 si l'équipe le veut.
- Heure d'envoi des rappels (8 h l'été, 7 h l'hiver) et texte du courriel : à valider par la travailleuse
  sociale (B12).
- Documents qui évoquent une crise (B5) : l'écran d'urgence ne se déclenche que sur ce que la famille tape,
  pas sur le contenu des documents lus. À trancher avec la travailleuse sociale.
- Les « à faire » d'un document deviennent des tâches à la demande (« Créer une tâche »), pas
  automatiquement : la famille choisit le titre que verront les membres « coordination ».
- Mode sombre non pris en charge en v0.1.
- Transfert de la propriété d'un dossier à un autre membre : hors v0.1 (la personne doit supprimer le
  dossier pour supprimer son compte).
- Invitations par courriel envoyé par Relais : possible maintenant (SES) ; non fait, l'invitation par lien
  partagé suffit au pilote.
- ESLint 9 n'est plus maintenu ; passer à ESLint 10 quand `eslint-plugin-jsx-a11y` le prendra en charge.
