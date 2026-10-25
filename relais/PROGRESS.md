# Relais — PROGRESS

Dernière mise à jour : 2026-10-25 (étape 2)

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

## En cours

- Rien. **Prochaine étape : 3 — Documents et extraction IA**, à lancer sur ton feu vert. Elle dépend des
  réponses aux questions 2 (fournisseur de l'IA) et 3 (photos et PDF numérisés).

## Décisions

| #   | Décision                                                                                                                                                                    | Raison                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D1  | Front Vite + React + TypeScript en PWA (pas de rendu serveur)                                                                                                               | Même base que Rempart ; Netlify ne sert que des fichiers statiques                              |
| D2  | Code serveur dans des Edge Functions Supabase épinglées à `ca-central-1` (à partir de l'étape 2)                                                                            | Les données de santé restent dans la région Canada ; clé IA côté serveur seulement              |
| D3  | Permissions appliquées par la base (RLS + fonctions `private.*`), matrice par zone de données                                                                               | Un client modifié ne peut rien lire de plus                                                     |
| D4  | Écritures bloquées sans consentement actif de la personne aidée ; écritures de santé bloquées sans consentement `health_information` de l'auteur                            | Loi 25 appliquée dans la base, pas seulement à l'écran                                          |
| D5  | Membre « coordination » : profil, tâches, rendez-vous, journal de bord, contacts ; ni documents, ni santé, ni droits                                                        | Minimisation                                                                                    |
| D6  | Bilan de l'aidant visible par son auteur seulement                                                                                                                          | Confidentialité de l'aidant                                                                     |
| D7  | Intervenantes et admins : rôle global + MFA obligatoire ; admin jamais membre d'un dossier par défaut                                                                       | Règle « admin sans accès aux dossiers »                                                         |
| D8  | Lecture des fichiers seulement par URL signée de 60 s émise et journalisée par une fonction serveur                                                                         | Journal des accès fiable pour les documents                                                     |
| D9  | Année de naissance au lieu de la date ; NAM jamais stocké en champ structuré                                                                                                | Minimisation                                                                                    |
| D10 | Détecteur de détresse déterministe exécuté sur le téléphone ; numéros lus dans `resources`                                                                                  | Déclenchement garanti et testable ; aucun numéro généré                                         |
| D11 | Moteur de règles sans IA ; l'IA n'explique qu'à partir de la fiche ; lettres à espaces réservés remplis sur le téléphone                                                    | Aucune invention ; aucun nom envoyé pour les lettres                                            |
| D12 | Page « Préparer un rendez-vous » sans IA                                                                                                                                    | Faits du dossier seulement                                                                      |
| D13 | Courriels (code, rappels, invitations, avis) sans aucun contenu de santé                                                                                                    | Règle 5                                                                                         |
| D14 | Pas de cache hors ligne des données du dossier (seulement l'app)                                                                                                            | Téléphones partagés                                                                             |
| D15 | Suppression d'un dossier : fichiers effacés par l'API Storage, puis purge en base ; bilans de l'aidant conservés                                                            | Critère d'acceptation ; à confirmer par le juriste                                              |
| D16 | Connexion par code à 6 chiffres reçu par courriel, sans mot de passe                                                                                                        | Fonctionne dans une PWA installée (un lien magique ouvrirait le navigateur)                     |
| D17 | Consentements écrits seulement par `grant_consent` / `revoke_consent` ; une nouvelle version clôt l'accord précédent ; la politique ne se retire qu'en supprimant le compte | Historique complet et preuve de la version acceptée                                             |
| D18 | Textes de consentement versionnés dans le dépôt ; la base garde leur empreinte SHA-256 et refuse qu'une version publiée change                                              | Preuve de ce qui a été affiché                                                                  |
| D19 | Export et suppression du compte par fonctions SQL (pas de fonction serveur à l'étape 1)                                                                                     | Moins de pièces ; testables sur PostgreSQL                                                      |
| D20 | Écran d'urgence en `<dialog>` modal, avec repli plein écran pour les navigateurs sans `showModal` (anciens iPhone)                                                          | L'écran ne doit jamais manquer de s'afficher                                                    |
| D21 | Tests de bout en bout contre un faux Supabase local (Auth simulée ; données sur la vraie base, voir D29)                                                                    | Tests reproductibles sans compte ; sert aussi aux démonstrations                                |
| D22 | Police Atkinson Hyperlegible servie par l'app ; aucune ressource externe (CSP)                                                                                              | Lisibilité ; aucune adresse IP transmise à un tiers                                             |
| D23 | « Parler à une intervenante » absent de l'écran d'urgence jusqu'à l'étape 6                                                                                                 | Pas de bouton qui ne fait rien sur un écran de crise                                            |
| D24 | Ressources de départ (911, 9-8-8, Info-Social 811, Info-Santé 811) toutes « à vérifier », sans URL source                                                                   | Les sites officiels n'étaient pas joignables d'ici ; la vérification revient à la TS (porte B3) |
| D25 | Invitations par lien que l'aidant partage lui-même (texto, courriel) plutôt que par un courriel envoyé par Relais                                                           | Aucun fournisseur de courriel nécessaire à l'étape 2 ; les familles se textent                  |
| D26 | Jeton d'invitation dans le fragment de l'adresse (`#`), lié à l'adresse invitée, valable 7 jours, stocké seulement sous forme d'empreinte                                   | Jamais dans les journaux web ; un lien transféré ne sert à personne d'autre                     |
| D27 | La personne aidée qui retire son accord ne peut pas être « recontredite » par un formulaire signé : seul son accord ou celui d'un représentant légal le rétablit            | Autodétermination ; à valider par le juriste (A15)                                              |
| D28 | Création de dossier par une fonction (`create_care_file`), suppression du compte refusée tant qu'on est propriétaire d'un dossier                                           | Pas de dossier orphelin ; pas de transfert de propriété en v0.1                                 |
| D29 | Tests de bout en bout sur la base migrée (mini PostgREST du faux Supabase) au lieu d'une imitation en mémoire                                                               | Les parcours vérifient la vraie RLS, les vrais déclencheurs et les vraies fonctions             |

### Hypothèses appliquées en attendant les réponses aux questions bloquantes

- **Q1** : code dans `relais/` de ce dépôt ; base neuve sur la même pile que Rempart (Rempart n'est pas
  accessible ici). Déménagement vers un dépôt dédié possible à tout moment : `relais/` est autonome.
- **Q2** : fournisseur IA isolé derrière une interface ; rien n'est appelé avant l'étape 3.
- **Q3** : OCR hébergé au Canada prévu pour les photos ; à confirmer avant l'étape 3.
- **Q4** : l'écran d'urgence dit seulement que Relais n'est pas un service d'urgence ; aucun délai promis.
- **Q5** : appliquée à l'étape 2 : sans consentement valide (personne ou représentant légal), la base refuse
  les renseignements sur la personne aidée ; la page de consentement explique que le dossier ne peut pas
  être accueilli pendant le pilote si le parent ne peut plus consentir et n'a pas de représentant.

## Questions ouvertes

### Bloquantes (posées le 2026-10-25, toujours sans réponse)

1. **Où vit le code, et que reprend-on de Rempart ?** Dépôt dédié recommandé ; accès au dépôt de Rempart ?
2. **Par où passe Claude ?** API Anthropic (traitement aux États-Unis ou « mondial ») ou Bedrock en région
   Canada si le modèle y est offert. Comptes existants ? À trancher avant l'étape 3.
3. **Photos et PDF numérisés** : OCR au Canada puis pseudonymisation (recommandé), OCR sur le téléphone, ou
   image envoyée telle quelle avec consentement spécifique ? À trancher avant l'étape 3.
4. **Intervenantes Relais** : combien, quel statut, quelles heures, quel délai de rappel promettre ? Avant
   l'étape 6.
5. **Parent inapte sans représentant** : ces familles font-elles partie du pilote ? (Hypothèse appliquée : non.)

### À vérifier dès qu'un projet Supabase existe (région `ca-central-1`)

- `delete_my_account` supprime une ligne de `auth.users` par SQL : à confirmer sur Supabase hébergé (sinon,
  passer par l'API d'administration dans une fonction serveur).
- Gabarits de courriel « code » (`supabase/templates/code.html`) et réglages Auth de
  `supabase/config.toml` à reproduire dans le tableau de bord ; SMTP au Canada (ex. Amazon SES).
- Région effective des Edge Functions (étape 2) : vérifier l'en-tête de réponse en préproduction.

### Non bloquantes

- Questions du bilan hebdomadaire et seuil : à valider par la travailleuse sociale.
- Lexique de détresse (`src/shared/distress/detect.ts`) et corpus (`tests/unit/distress-corpus.ts`) : à
  valider et compléter par la travailleuse sociale (B1).
- Textes de consentement (`src/content/consent-texts.fr.json`) : à faire valider par le juriste ;
  coordonnées de la personne responsable des renseignements personnels à fournir.
- Taille de l'application : 200 ko compressés au premier chargement ; découpage par page à prévoir.
- Mode sombre non pris en charge en v0.1.
- Transfert de la propriété d'un dossier à un autre membre : hors v0.1 (la personne doit supprimer le
  dossier pour supprimer son compte).
- Invitations par courriel envoyé par Relais : à ajouter avec le fournisseur de courriel de l'étape 5.
- ESLint 9 n'est plus maintenu ; passer à ESLint 10 quand `eslint-plugin-jsx-a11y` le prendra en charge.
