# Relais — PROGRESS

Dernière mise à jour : 2026-10-25

## Fait

- Proposition de démarrage :
  [architecture](docs/ARCHITECTURE.md), [plan en 6 étapes](docs/PLAN.md),
  [schéma SQL et politiques RLS](docs/schema.sql), [points à valider](docs/VALIDATIONS.md).
- Schéma vérifié sur PostgreSQL 16 avec le shim Supabase de TrustCargo Pay : il s'applique sans erreur et
  passe un test de fumée de 34 vérifications (consentements requis avant toute écriture, matrice
  d'accès par rôle, MFA des intervenantes, admin sans accès aux dossiers, ressources lisibles sans
  session, liens impossibles entre dossiers, suppression qui ne laisse que sa trace). Ce test deviendra
  `rls_test.sql` aux étapes 1 et 2.

## En cours

- En attente : réponses aux questions bloquantes et feu vert. Aucune étape n'est commencée.

## Décisions (proposées, réversibles d'ici le feu vert)

| # | Décision | Raison |
|---|---|---|
| D1 | Front Vite + React + TypeScript en PWA (pas de rendu serveur) | Même base que Rempart ; Netlify ne sert que des fichiers statiques |
| D2 | Code serveur dans des Edge Functions Supabase épinglées à `ca-central-1` | Les données de santé restent dans la région Canada ; clé IA côté serveur seulement |
| D3 | Permissions appliquées par la base (RLS + fonctions `private.*`), matrice par zone de données | Un client modifié ne peut rien lire de plus |
| D4 | Écritures bloquées sans consentement actif de la personne aidée ; écritures de santé bloquées sans consentement `health_information` de l'auteur | Loi 25 appliquée dans la base, pas seulement à l'écran |
| D5 | Membre « coordination » : profil, tâches, rendez-vous, journal de bord, contacts ; ni documents, ni santé, ni droits | Minimisation |
| D6 | Bilan de l'aidant visible par son auteur seulement | Confidentialité de l'aidant |
| D7 | Intervenantes et admins : rôle global + MFA obligatoire ; admin jamais membre d'un dossier par défaut | Règle « admin sans accès aux dossiers » |
| D8 | Lecture des fichiers seulement par URL signée de 60 s émise et journalisée par une fonction serveur | Journal des accès fiable pour les documents |
| D9 | Année de naissance au lieu de la date ; NAM jamais stocké en champ structuré | Minimisation |
| D10 | Détecteur de détresse déterministe exécuté sur le téléphone ; numéros lus dans `resources` | Déclenchement garanti et testable ; aucun numéro généré |
| D11 | Moteur de règles sans IA ; l'IA n'explique qu'à partir de la fiche ; lettres à espaces réservés remplis sur le téléphone | Aucune invention ; aucun nom envoyé pour les lettres |
| D12 | Page « Préparer un rendez-vous » sans IA | Faits du dossier seulement |
| D13 | Courriels (rappels, invitations, avis) sans aucun contenu de santé | Règle 5 |
| D14 | Pas de cache hors ligne des données du dossier (seulement l'app et l'écran d'urgence) | Téléphones partagés |
| D15 | Suppression d'un dossier : fichiers effacés par l'API Storage, puis purge en base ; bilans de l'aidant conservés (ses propres données) | Critère d'acceptation ; à confirmer par le juriste |
| D16 | Connexion par code reçu par courriel | Fonctionne dans une PWA installée, sans mot de passe à retenir |

## Questions ouvertes

### Bloquantes (posées le 2026-10-25)

1. **Où vit le code, et que reprend-on de Rempart ?** Rempart n'est pas dans ce dépôt. Recommandation :
   dépôt dédié `relais` ; sinon dossier `relais/` ici. Accès au dépôt de Rempart pour en reprendre le
   socle, ou base neuve sur la même pile ?
2. **Par où passe Claude ?** API Anthropic directe (traitement aux États-Unis ou « mondial ») ou Claude
   via Amazon Bedrock en région Canada, si le modèle y est offert. Comptes existants ?
   Recommandation : Bedrock Canada si disponible ; sinon API Anthropic avec texte pseudonymisé
   seulement et demande de rétention nulle.
3. **Photos et PDF numérisés.** OCR hébergé au Canada puis pseudonymisation (recommandé), OCR sur le
   téléphone (moins précis), ou image envoyée telle quelle à Claude avec un consentement spécifique ?
4. **Intervenantes Relais.** Combien, quel statut, quelles heures, quel délai de rappel promettre ?
5. **Parent inapte sans représentant.** Ces familles font-elles partie du pilote ? Par défaut : non, la
   saisie de renseignements de santé reste bloquée sans consentement valide.

### Non bloquantes

- Questions du bilan hebdomadaire et seuil : à valider par la travailleuse sociale.
- Fournisseur de courriel : Amazon SES `ca-central-1` proposé.
- Forfait Supabase : sauvegardes à un instant donné (PITR) recommandées pour le pilote.
- Domaine et nom d'expéditeur des courriels.
