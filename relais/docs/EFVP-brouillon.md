# Relais — évaluation des facteurs relatifs à la vie privée (EFVP)

> **BROUILLON TECHNIQUE, à compléter et à faire valider par le juriste avant le pilote.** Rédigé à partir
> de ce que fait réellement le code (migrations, fonctions serveur, application). Les décisions qui
> relèvent de l'organisation (durées de conservation, ententes, personne responsable) sont marquées
> **À DÉCIDER**. Référence : Loi 25, articles 3.3 et 17 de la Loi sur la protection des renseignements
> personnels dans le secteur privé ; guide de la Commission d'accès à l'information sur l'EFVP.

## 1. Le projet

- **Quoi** : application web mobile (PWA) qui aide les personnes proches aidantes du Québec à coordonner
  les soins d'un parent (dossier partagé, documents, agenda, tâches) et à repérer les aides auxquelles il a
  droit. Pas un service de santé : aucun diagnostic, aucun conseil médical.
- **Pilote** : 10 familles, 6 semaines.
- **Organisation responsable** : **À DÉCIDER** (nom, personne responsable de la protection des
  renseignements personnels, coordonnées).
- **Pourquoi une EFVP** : renseignements de santé (sensibles) ; texte de documents transmis hors Québec à
  un fournisseur d'IA (article 17) ; nouvelle technologie (IA).

## 2. Personnes concernées

Personnes proches aidantes (comptes), membres de la famille invités, personne aidée (souvent âgée, parfois
en perte d'autonomie), professionnels nommés dans le dossier (contacts), intervenantes et admins de Relais.

## 3. Renseignements recueillis, finalités et accès

| Renseignements                                                                  | Où (table)                                                                                         | Finalité                                       | Qui y a accès                                                             |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Adresse courriel, prénom choisi                                                 | `auth.users`, `users`                                                                              | Connexion par code, affichage                  | La personne ; prénom visible des membres de ses dossiers                  |
| Consentements (type, version, dates)                                            | `consents`                                                                                         | Preuve du consentement (Loi 25)                | La personne ; l'aidante principale pour ceux du dossier                   |
| Prénom, nom, année de naissance, milieu de vie de la personne aidée             | `care_recipients`                                                                                  | Coordination, navigateur de droits             | Membres du dossier selon leur niveau                                      |
| Autonomie, services en place, besoins d'adaptation                              | `care_needs`                                                                                       | Coordination, page « Préparer un rendez-vous » | Membres ayant accès à la santé                                            |
| Contacts (professionnels, résidence, pharmacie)                                 | `contacts`                                                                                         | Coordination                                   | Membres du dossier                                                        |
| Documents médicaux (PDF, photos) et leur contenu confirmé                       | Storage `documents`, `documents`, `document_extractions`, `medication_mentions`, `timeline_events` | Organiser et résumer ce qui est écrit          | Membres ayant accès à la santé ; lien de 60 s pour l'original             |
| Réponses au questionnaire, programmes, statuts, lettres                         | `benefit_assessments`, `care_file_programs`, `program_checklist_items`                             | Navigateur de droits                           | Membres ayant accès aux droits                                            |
| Tâches, rendez-vous                                                             | `tasks`, `appointments`                                                                            | Coordination                                   | Tous les membres, y compris « coordination »                              |
| Questions à poser, carnet de bord                                               | `appointment_questions`, `journal_entries`                                                         | Coordination des soins                         | Membres ayant accès à la santé                                            |
| Bilan de la semaine de l'aidant (3 notes de 1 à 5)                              | `caregiver_checkins`                                                                               | Soutien à l'aidant                             | **La personne seulement** ; gardé seulement avec un consentement distinct |
| Demande d'intervenante (prénom, téléphone ou courriel, disponibilités, message) | `support_requests`                                                                                 | Rappel par une intervenante                    | La personne ; intervenantes (vérification en deux étapes)                 |
| Notes internes des intervenantes                                                | `support_request_notes`                                                                            | Suivi de la demande                            | Intervenantes seulement                                                   |
| Réponses d'évaluation (heures gagnées, satisfaction)                            | `pilot_feedback`                                                                                   | Évaluer le pilote                              | La personne ; l'admin ne voit que des agrégats (≥ 3 répondants)           |
| Journal des accès (qui, quoi, quand ; jamais de contenu)                        | `access_log`                                                                                       | Traçabilité (Loi 25)                           | L'aidante principale pour son dossier ; chacun pour ses actions           |
| Appels à l'IA (statut, durée, compteurs ; jamais de contenu)                    | `ai_calls`                                                                                         | Suivi technique et coûts                       | Admin                                                                     |
| Rappels envoyés (date, nombres)                                                 | `reminder_deliveries`                                                                              | Un seul courriel par jour                      | La personne                                                               |

**Minimisation appliquée** : année de naissance plutôt que date ; aucun numéro d'assurance maladie en
champ structuré ; métadonnées des photos (GPS) retirées sur le téléphone ; brouillons d'extraction rejetés
effacés ; aucun montant dans le navigateur de droits ; pas de question sur le revenu ; journaux applicatifs
sans aucune saisie (liste blanche de champs).

## 4. Cycle de vie

### Collecte

Par la personne elle-même, dans l'application. Consentements distincts et révocables : politique de
confidentialité (obligatoire), renseignements de santé, rappels par courriel, évaluation du pilote, bilan
de la semaine ; au niveau du dossier : consentement de la personne aidée (ou de son représentant légal) et
lecture automatique des documents. La base refuse les écritures sans les consentements requis.

### Utilisation

- **Lecture automatique d'un document** (si la personne aidée l'a autorisée) : le texte est
  **pseudonymisé sur le serveur** (noms, NAM, NAS, adresses, téléphones, dates de naissance, numéros de
  dossier remplacés par des jetons) avant l'envoi au fournisseur d'IA ; la réponse est filtrée par des
  garde-fous (aucun conseil, aucun chiffre absent du document) et **rien n'entre au dossier sans la
  confirmation d'un membre**. Les photos et PDF numérisés ne sont jamais envoyés (saisie à la main).
- **Explications et lettres du navigateur de droits** : l'IA ne reçoit que la fiche publique du
  programme, aucun renseignement du dossier ; les noms sont ajoutés à la lettre sur le téléphone.
- **Page « Préparer un rendez-vous »** : construite sur le téléphone, sans IA ; son impression est notée.
- **Écran d'urgence** : la détection se fait **sur le téléphone** ; aucune saisie n'est transmise pour
  cela ; seul un événement sans contenu est journalisé.

### Communication

| Destinataire                                      | Ce qui est transmis                                                                                  | Lieu                                                       | Base                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase (hébergement, base, fichiers, fonctions) | Tout le dossier, chiffré au repos et en transit                                                      | `ca-central-1` (Montréal) — à confirmer pour les fonctions | Entente de sous-traitance **À SIGNER**                                                                                                 |
| Anthropic (API Claude)                            | Texte **pseudonymisé** d'un document ; fiches publiques des programmes                               | **Hors Québec** (États-Unis ou traitement « mondial »)     | Article 17 : cette EFVP ; consentement distinct de la personne aidée ; conditions de l'API **À VÉRIFIER** (conservation, entraînement) |
| Amazon Web Services (SES)                         | Adresse courriel et texte fixe (rappel, avis aux intervenantes)                                      | `ca-central-1` (Montréal)                                  | Entente **À SIGNER**                                                                                                                   |
| Netlify                                           | Aucun renseignement du dossier (fichiers de l'application seulement) ; adresses IP dans ses journaux | Réseau mondial                                             | Entente **À VÉRIFIER**                                                                                                                 |
| Calendrier du téléphone (choix de la personne)    | Objet, heure et lieu d'un rendez-vous (.ics)                                                         | Selon le téléphone                                         | Action volontaire, rappelée à l'écran                                                                                                  |

### Conservation et destruction

- Suppression du compte et du dossier à la demande, en cascade (fichiers compris), le journal ne gardant
  que la trace de la suppression. Export complet du dossier et des données personnelles.
- Fichiers effacés de Storage aussitôt, ou au plus tard dans l'heure par une tâche planifiée si l'effacement
  immédiat échoue ; envoi de document resté incomplet effacé après 24 h (noté au journal du dossier).
- Retrait du consentement « bilan de la semaine » ou « évaluation du pilote » : réponses effacées.
- **À DÉCIDER** : durée de conservation après le pilote, effacement des comptes inactifs, sauvegardes.

## 5. Sécurité

- RLS (sécurité au niveau des lignes) sur toutes les tables : chaque accès est décidé par la base selon le
  niveau du membre (complet, coordination, lecture seule) et les consentements ; 412 vérifications
  automatisées, rejouées à chaque modification (CI).
- Vérification en deux étapes obligatoire pour les intervenantes et les admins, vérifiée aussi par la base.
- Fichiers : bucket privé, aucune lecture directe ; liens signés de 60 secondes, journalisés.
- Courriels sans aucun renseignement sur la personne aidée ; politique de sécurité du contenu (CSP)
  stricte ; aucune donnée du dossier mise en cache sur le téléphone par l'application hors ligne.
- Clés de l'IA et du courriel uniquement sur le serveur.

## 6. Risques et mesures

| Risque                                               | Gravité | Mesures                                                                                            | Risque résiduel                                                                          |
| ---------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Ré-identification d'un document transmis à l'IA      | Élevée  | Pseudonymisation testée sur documents fictifs ; consentement distinct ; option de saisie à la main | Moyen : un nom mal reconnu peut passer — **à évaluer** avec de vrais documents caviardés |
| Conservation ou entraînement par le fournisseur d'IA | Élevée  | Vérification des conditions avant le pilote ; fournisseur remplaçable (Bedrock au Canada)          | **À ÉVALUER**                                                                            |
| Accès d'un membre au-delà de son rôle                | Élevée  | RLS testée par rôle × table × opération ; contrôles par mutation                                   | Faible                                                                                   |
| Conflit familial (membre retiré, notes du carnet)    | Moyenne | Retrait d'un membre libère ses tâches ; notes modifiables par leur auteur seulement                | Moyen — VALIDATIONS A19                                                                  |
| Courriel lu par un tiers                             | Moyenne | Contenu générique, aucun nom ni titre                                                              | Faible                                                                                   |
| Détresse non détectée, ou délai de rappel            | Élevée  | Détecteur sur le téléphone, numéros tirés d'une table vérifiée, aucun délai promis                 | Moyen — corpus et procédure à valider (TS)                                               |
| Bilan de l'aidant vu par d'autres                    | Moyenne | Visible par la personne seulement (y compris pour l'équipe) ; absent des mesures                   | Faible                                                                                   |
| Fiche de programme erronée                           | Moyenne | « À VÉRIFIER » visible, admissibilité à confirmer, aucun montant                                   | Faible après vérification                                                                |

## 7. Droits des personnes

Accès et portabilité (export JSON du compte et du dossier), rectification (dans l'application),
suppression (compte, dossier, document, note), retrait de chaque consentement, journal des accès consultable
par l'aidante principale. **À DÉCIDER** : délai de réponse et voie pour les demandes faites hors de
l'application.

## 8. Conclusion et approbation

**À COMPLÉTER** par la personne responsable : risques acceptés, mesures exigées avant le pilote,
signatures et date.
