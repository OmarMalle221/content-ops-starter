# Relais v0.1 — Plan en 6 étapes

Chaque étape se termine par une démo sur téléphone, des tests verts en CI et la mise à jour de
[`../PROGRESS.md`](../PROGRESS.md). Les migrations SQL sont découpées dans le même ordre que
[`schema.sql`](schema.sql).

## Étape 1 — Socle, authentification et consentements

**Livrables**

- Projet Vite + React + TypeScript en PWA, mise en page mobile, jetons de design AA, `fr.ts`.
- Supabase : migrations `users`, `consents`, `resources`, `access_log`, `ai_calls`, fonctions `private.*` ;
  shim de test et `rls_test.sql` ; CI (lint, types, unitaires, base, e2e, Lighthouse).
- Connexion par code reçu par courriel (pratique pour une PWA installée), MFA TOTP pour intervenantes et
  admins.
- Accueil : explication claire de l'usage des données, consentements distincts et révocables
  (politique, renseignements de santé, IA, courriels, évaluation du pilote), page « Mes consentements ».
- **Détecteur de détresse et écran d'urgence**, posés dès le socle parce que toutes les saisies libres
  des étapes suivantes s'y branchent.
- Journaliseur applicatif à liste blanche ; suppression de compte et export de mes données.

**Tests** : corpus de détresse (100 % de déclenchement), consentements (création, révocation, effet sur
les écritures), journaliseur (aucun champ libre), axe + Lighthouse sur les écrans d'accueil.

## Étape 2 — Dossier et membres

**Livrables**

- `care_files`, `care_file_members`, invitations par courriel, `care_recipients`, `care_needs`,
  `contacts`.
- Enregistrement du consentement de la personne aidée et de son statut juridique (elle-même, mandat
  homologué, tutelle, procuration, autre) ; blocage des écritures sans consentement valide.
- Niveaux d'accès (complet, coordination, lecture seule), accès optionnel de la personne aidée,
  confiement à une intervenante.
- Journal des accès consultable par l'aidant principal ; export du dossier ; **suppression du dossier**.

**Tests** : `rls_test.sql` complet (chaque rôle × table × opération), invitation (expiration, mauvaise
adresse), suppression qui efface tout et ne laisse que la trace. Critère couvert : _un membre invité ne
voit que ce que ses permissions autorisent_.

## Étape 3 — Documents et extraction IA

**Livrables**

- Bucket privé, téléversement PDF / photo (compression, retrait EXIF), URL signées journalisées.
- Fonction `extract-document` : texte (ou OCR selon Q3), pseudonymisation, appel Claude via
  `LlmClient`, validation Zod, garde-fous, `ai_calls`.
- Écran de relecture : garder, corriger, rejeter chaque élément ; marque « à vérifier » ;
  `confirm_extraction` ; chronologie avec lien vers la source.

**Tests** : pseudonymisation (NAM, noms, adresses, téléphones sur documents fictifs), garde-fous
(conseil médical, chiffres inventés), pipeline avec IA simulée, test réel < 30 s sur un PDF de 3 pages,
suppression étendue aux fichiers Storage.

## Étape 4 — Navigateur de droits

**Livrables**

- Table `programs` + 8 fiches « À VÉRIFIER » sans montant, `resources` de répit et lignes d'aide.
- Questionnaire, moteur de règles, liste personnalisée avec statut (`to_explore`, `in_progress`,
  `obtained`, `refused`), pièces à fournir, lien officiel, mention « admissibilité à confirmer ».
- Explication IA tirée de la seule fiche (mise en cache), brouillon de lettre à espaces réservés.
- Écrans d'admin pour les fiches et les ressources (date et auteur de vérification).

**Tests** : moteur de règles (tables de vérité), aucune donnée de semence ne contient de montant, chaque
carte affichée porte source et date de vérification (e2e), garde-fou « je ne sais pas ».

## Étape 5 — Coordination et rendez-vous

**Livrables**

- Tâches (responsable, échéance), calendrier partagé, journal de bord, export `.ics` d'un rendez-vous
  généré sur le téléphone.
- Rappels quotidiens par courriel au contenu générique (`pg_cron` → `send-reminders`).
- Page imprimable « Préparer un rendez-vous », sans IA.

**Tests** : RLS coordination, contenu des courriels (aucune donnée de santé), page imprimable (seulement
des faits du dossier, chacun avec sa source), axe sur la version imprimable.

## Étape 6 — Charge de l'aidant et demandes d'intervenante

**Livrables**

- Bilan hebdomadaire (3 questions, 1 à 5), seuil, suggestions de répit tirées de `resources`.
- Bouton « Parler à une intervenante », tableau de suivi interne (MFA), avis par courriel sans contenu.
- Mesures du pilote : temps gagné, satisfaction, programmes repérés puis demandés ; tableau admin
  agrégé.
- Passe finale accessibilité et performance ; liste de contrôle avant pilote.

**Tests** : confidentialité du bilan (invisible aux autres membres et aux intervenantes), seuil, flux de
demande, Lighthouse ≥ 90 sur toutes les pages.

## Avant le pilote (portes de sortie)

- EFVP terminée et signée ; textes de consentement approuvés par le juriste.
- 8 programmes et toutes les ressources vérifiés (source, date, auteur) — plus aucune fiche « À VÉRIFIER ».
- Corpus de détresse, questions du bilan et seuil validés par la travailleuse sociale.
- Conditions de traitement du fournisseur d'IA vérifiées (rétention, entraînement, lieu de traitement).
- Région des fonctions vérifiée en préproduction ; procédure d'incident de confidentialité prête ;
  responsable de la protection des renseignements personnels désigné.
