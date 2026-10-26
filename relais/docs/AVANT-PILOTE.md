# Relais — liste de contrôle avant le pilote

Le code des 6 étapes est livré et testé (voir [`PROGRESS.md`](../PROGRESS.md)). Le pilote (10 familles,
6 semaines) ne commence que lorsque **toutes** les cases ci-dessous sont cochées. Chaque ligne indique qui
s'en occupe et où se trouve le détail.

Rôles : **R** = responsable du projet Relais, **J** = juriste, **TS** = travailleuse sociale,
**T** = personne technique, **A** = admin de contenu (compte `admin` dans Relais).

## 1. Juridique et gouvernance (Loi 25)

- [ ] **EFVP terminée et signée** (J, R) — partir de [`EFVP-brouillon.md`](EFVP-brouillon.md).
- [ ] Personne responsable de la protection des renseignements personnels désignée ; ses coordonnées
      ajoutées à la politique de confidentialité (R).
- [ ] Textes de consentement approuvés (J) : `src/content/consent-texts.fr.json`, 7 textes dont « Mon
      bilan de la semaine » (étape 6). Toute correction = nouvelle version (`npm run generate:reference`).
- [ ] Formulaire de consentement imprimable de la personne aidée approuvé (J).
- [ ] Procédure d'incident de confidentialité et registre prêts (avis à la CAI et aux personnes) (J, R).
- [ ] Ententes avec les sous-traitants signées : Supabase, Amazon Web Services (SES), Anthropic, Netlify
      (J, R).
- [ ] Conditions de traitement de l'API d'Anthropic vérifiées : conservation, entraînement, lieu de
      traitement ; décrites dans la politique (règle 6) (J, T).
- [ ] Durée de conservation des données du pilote fixée (et procédure d'effacement à la fin) (J, R).
- [ ] Points juridiques ouverts tranchés : [`VALIDATIONS.md`](VALIDATIONS.md), partie A (J).

## 2. Contenu

- [ ] Les 8 fiches de programmes vérifiées à la source dans `/admin/programmes` (date et initiales) :
      plus aucune « À VÉRIFIER » (A). Points précis : PROGRESS.md, « Avant le pilote : vérifier les 8
      fiches ».
- [ ] Toutes les ressources d'aide vérifiées dans `/admin/ressources` (numéros, heures, liens) (A).
- [ ] Lexique et corpus de détresse validés (TS) : `src/shared/distress/detect.ts`,
      `tests/unit/distress-corpus.ts`.
- [ ] Questions du bilan de la semaine et seuil (total ≥ 12 ou une réponse à 5) validés (TS) :
      `src/shared/checkin/score.ts`.
- [ ] Textes des courriels (rappel quotidien, avis aux intervenantes) et heure d'envoi validés (TS).
- [ ] Points de la partie B de [`VALIDATIONS.md`](VALIDATIONS.md) tranchés (TS).

## 3. Infrastructure (projet Supabase en `ca-central-1`)

- [ ] Projet Supabase créé en `ca-central-1` ; migrations `supabase/migrations/` appliquées **dans
      l'ordre** (la migration `20261031000001` doit être validée avant `20261031000002`), puis
      `supabase/reference/*.sql`. Ne **jamais** appliquer `supabase/seed/` (démonstration seulement) (T).
- [ ] Réglages Auth reproduits (`supabase/config.toml`), gabarit du code par courriel
      (`supabase/templates/code.html`), SMTP au Canada (Amazon SES) (T).
- [ ] Vérification en deux étapes active ; comptes `admin` et `relais_worker` attribués par SQL
      (`update public.users set app_role = …`) (T).
- [ ] Fonctions Edge déployées : `extract-document`, `get-document-url`, `delete-document`,
      `delete-care-file`, `explain-program`, `draft-letter`, `notify-support`, `send-reminders`,
      `purge-storage`. Elles sont vérifiées et essayées sous Deno 2.9 en CI (`npm run test:functions`) ;
      vérifier au déploiement que la CLI empaquette les imports de `src/shared` (T).
- [ ] Secrets des fonctions : `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `RELAIS_APP_ORIGINS`,
      `RELAIS_APP_URL`, `RELAIS_EMAIL_FROM`, `RELAIS_CRON_SECRET`, `AWS_SES_ACCESS_KEY_ID`,
      `AWS_SES_SECRET_ACCESS_KEY`, `AWS_SES_REGION` (T).
- [ ] Amazon SES en `ca-central-1` : domaine vérifié, sortie du bac à sable (T).
- [ ] Tâches planifiées : secrets Vault `relais_functions_url` et `relais_cron_secret`, puis
      `supabase/cron/send_reminders.sql` (rappels, chaque matin) et `supabase/cron/purge_storage.sql`
      (purge de Storage, chaque heure) (T).
- [ ] Une heure plus tard : les deux tâches réussies dans `cron.job_run_details`, et la file
      `storage_deletion_queue` vide (T).
- [ ] Région effective des fonctions vérifiée (en-tête de réponse) (T).
- [ ] `delete_my_account` vérifiée sur Supabase hébergé (suppression dans `auth.users`) (T).
- [ ] Sauvegardes et restauration (PITR) activées et testées une fois (T).
- [ ] Netlify : variables `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY`, en-têtes de sécurité et CSP
      (`netlify.toml`, `security-headers.ts`) vérifiés sur le site déployé (T).

## 4. Vérifications en préproduction

- [ ] `ANTHROPIC_API_KEY=… npm run test:ai-live` : brouillon réel en moins de 30 s sur le PDF de 3 pages ;
      repli serveur ouvert au compte (T).
- [ ] Un rappel réel et un avis aux intervenantes réels reçus à des adresses de l'équipe (T).
- [ ] Parcours complet sur deux téléphones (Android et iPhone), PWA installée : connexion par code,
      dossier, document, droits, agenda, page imprimée, bilan, demande d'intervenante (R, TS).
- [ ] Export et suppression d'un compte et d'un dossier de test, fichiers Storage compris (T).
- [ ] Lighthouse (accessibilité ≥ 90) sur le site déployé ; `npm run check:bundle` vert (T).

## 5. Équipe et pilote

- [ ] **Intervenantes** (question Q4) : combien, statut, heures de service, délai de rappel promis. Mettre à
      jour les textes de « Parler à une intervenante » s'il faut annoncer des heures ou un délai (R, TS).
- [ ] Intervenantes formées : tableau de suivi, conduite après l'écran d'urgence, maltraitance (A13),
      tenue des notes internes (J, TS).
- [ ] Familles dont le parent ne peut plus consentir et n'a pas de représentant (Q5) : critère
      d'admission du pilote écrit (R, J).
- [ ] 10 familles recrutées ; consentements recueillis (personne aidée et aidants) (R).
- [ ] Suivi du pilote : tableau `/admin/pilote` consulté chaque semaine ; point d'étape à mi-parcours (R).
