# Relais v0.1 — Points à faire valider avant le pilote

Relais est une application web qui aide les proches aidants du Québec à coordonner les soins d'un parent
et à repérer les aides auxquelles il a droit. Pilote prévu : 6 semaines, 10 familles. Relais n'est ni un
service de santé ni un service de crise.

## A. Juriste — Loi 25 et responsabilité

1. **Qui peut consentir pour la personne aidée.** Modes prévus : la personne elle-même (dans
   l'application ou par formulaire signé que l'aidant téléverse) ou son représentant légal. Statuts
   enregistrés : la personne consent elle-même, mandat de protection homologué, tutelle, procuration,
   autre. Une procuration suffit-elle pour des renseignements de santé, ou vise-t-elle seulement les
   biens ? Que faire si le parent est inapte et n'a aucun représentant ?
2. **Partage dans la famille.** L'aidant principal invite des membres à différents niveaux (complet,
   coordination, lecture seule). Le consentement de la personne aidée doit-il nommer chaque membre ou
   chaque niveau ?
3. **Communication hors Québec.** Les documents sont envoyés, pseudonymisés, à un fournisseur d'IA
   (Claude, Anthropic), dont le traitement peut avoir lieu aux États-Unis. EFVP, entente écrite et
   mesures requises ; ce que le consentement doit en dire.
4. **Pseudonymisation.** Les noms, le NAM et les adresses sont remplacés avant l'envoi ; les
   renseignements restent personnels. Est-ce une mesure suffisante, avec quel risque résiduel déclaré ?
5. **Textes de consentement.** Six consentements distincts et révocables (politique, renseignements de
   santé, traitement IA des documents, courriels, évaluation du pilote, consentement de la personne
   aidée). Clarté, granularité, durée, effets d'une révocation.
6. **Conservation et destruction.** Durées pour les documents, extractions et journaux ; à la
   suppression d'un dossier, le journal ne garde que la trace de la suppression (pendant combien de
   temps ?) ; sauvegardes du fournisseur conservées jusqu'à leur expiration.
7. **Journal des accès.** Granularité prévue (ouverture du dossier, téléchargements, membres,
   consentements, suppression). Suffisant ? Qui doit pouvoir le consulter ?
8. **Droits des personnes.** Accès, rectification, suppression et portabilité (export structuré) :
   procédure et délais de réponse.
9. **Gouvernance.** Responsable de la protection des renseignements personnels, politique de
   confidentialité publiée, registre et procédure d'incident de confidentialité (avis à la CAI et aux
   personnes).
10. **Sous-traitants.** Supabase (Canada), Netlify (fichiers statiques seulement), fournisseur de
    courriel (Amazon SES, région Canada : il reçoit l'adresse et un rappel générique), fournisseur d'IA,
    OCR éventuel : ententes nécessaires.
11. **Intervenantes Relais.** Statut, confidentialité, secret professionnel, tenue de dossiers si ce sont
    des professionnelles membres d'un ordre ; accès limité aux dossiers que l'aidant leur confie.
12. **Avertissements.** Pas de conseil médical, pas un service d'urgence, admissibilité aux programmes à
    confirmer, lettres préparées par l'IA à relire : formulation et responsabilité.
13. **Maltraitance.** Conduite si un texte ou un document évoque de la maltraitance envers la personne
    aidée ; obligations de signalement éventuelles.
14. **Évaluation du pilote.** Consentement à l'usage des réponses (temps gagné, satisfaction) ; faut-il
    un comité d'éthique si les résultats sont publiés ou faits avec un partenaire de recherche ?
15. **Retrait par la personne aidée.** Si la personne retire elle-même son accord dans Relais, l'aidant ne
    peut plus le rétablir par un formulaire signé ; seuls la personne ou son représentant légal le peuvent.
    Est-ce la bonne règle ? Et si la personne devient inapte ensuite, l'accord du mandataire suffit-il ?
16. **Invitations.** Le lien d'invitation est envoyé par l'aidant lui-même (texto, courriel) ; il ne
    fonctionne que pour l'adresse invitée, pendant 7 jours. Le consentement de la personne aidée couvre-t-il
    ce partage ?
17. **Lecture automatique des documents.** Consentement distinct et facultatif de la personne aidée (ou
    de son représentant), enregistré dans Relais ou sur le formulaire papier (case « J'accepte / Je
    refuse ») ; texte pseudonymisé transmis hors Québec. Le texte de consentement
    (`ai_document_processing`) dit-il assez clairement où va le texte et ce qui reste masqué ? Les
    brouillons rejetés sont effacés ; ce qui est confirmé reste au dossier après un retrait : est-ce correct ?
18. **Médicaments « tels qu'écrits ».** Relais recopie les médicaments des documents vérifiés, sans
    interprétation, avec la mention que ce n'est pas une liste à jour. Formulation et responsabilité si une
    famille s'y fie comme à une liste officielle.
19. **Carnet de bord et suppression d'un compte.** Les notes d'un membre restent au dossier quand il
    supprime son compte (son nom est effacé) : elles font partie de l'histoire du dossier de la personne
    aidée. Est-ce compatible avec son droit à la suppression, ou faut-il effacer ses notes aussi ?
20. **Page « Préparer un rendez-vous ».** Elle réunit des renseignements de santé sur papier ; son
    impression est notée au journal des accès. Mention « gardez la copie en lieu sûr » suffisante ?
21. **Bilan de la semaine et évaluation du pilote.** Nouveau consentement distinct « Mon bilan de la
    semaine » (texte à approuver). Retirer ce consentement, ou celui de l'évaluation du pilote, efface les
    réponses déjà données : est-ce la bonne règle pour l'évaluation (le texte dit seulement « pour
    arrêter ») ? Les mesures ne montrent que des agrégats, masqués sous 3 répondants : seuil suffisant
    pour 10 familles ?
22. **Demandes d'intervenante.** Les notes internes des intervenantes ne sont pas montrées au demandeur ni
    incluses dans son export : compatible avec son droit d'accès ? Les demandes et notes sont effacées si
    la personne supprime son compte : faut-il garder une trace minimale (obligations professionnelles) ?
    Les consultations du tableau ne sont pas journalisées en v0.1 : faut-il les ajouter ?

## B. Travailleuse sociale — sécurité, ton et parcours

1. **Lexique de détresse et corpus de test.** Phrases qui doivent toujours déclencher l'écran
   d'urgence et phrases qui ne doivent pas le faire, y compris des expressions québécoises. Préférence
   assumée : en cas de doute, on déclenche.
2. **Écran d'urgence.** Texte, ordre des ressources (911, 9-8-8, Info-Social 811, autres), ton, ce qu'on
   promet sur le rappel d'une intervenante, suivi après l'affichage.
3. **Ressources.** Vérification de chaque numéro, des heures et des régions (urgence, crise, répit,
   Info-aidant, maltraitance) ; qui vérifie et à quelle fréquence.
4. **Bilan hebdomadaire.** Les 3 questions proposées (fatigue, débordement, isolement), l'échelle de 1 à
   5, le seuil (total ≥ 12 ou une réponse à 5) et la formulation des suggestions de répit. Le bilan doit
   rester privé et ne pas passer pour un outil clinique. Formulation actuelle : `src/i18n/support.fr.ts`.
5. **Documents qui évoquent une crise** (ex. note clinique mentionnant des idées suicidaires) : afficher
   l'écran d'urgence à l'aidant, ou seulement un bandeau discret ?
6. **Demandes d'intervenante.** Triage, priorités, délai de réponse, conduite quand la demande vient de
   l'écran d'urgence ou arrive hors des heures de service.
7. **Ton et lisibilité.** Relecture des textes : accueil, consentements, résumés, écrans d'erreur et
   d'urgence.
8. **Navigateur de droits.** Éviter les faux espoirs (« admissibilité à confirmer »), rôle de
   l'évaluation du CLSC, pièces à fournir présentées simplement. Questionnaire volontairement court (six
   questions, sans revenu) : formulation des questions et conditions simplifiées de chaque fiche
   (`src/content/programs.fr.json`) à confirmer, ainsi que le regroupement « probable / à vérifier / peu
   probable ».
9. **Dynamiques familiales.** Niveaux d'accès adaptés aux conflits (retrait d'un membre, visibilité),
   place de la personne aidée (dignité, autodétermination, accès en lecture).
10. **Préparer un rendez-vous.** Contenu de la page imprimable et exemples de questions à poser, sans
    conseil médical.
11. **Relecture d'un document.** Formulation de l'écran de relecture (« gardez, corrigez ou décochez »),
    des points « à vérifier » et du rappel « aucun conseil médical — Info-Santé » ; les éléments douteux
    sont décochés par défaut. Est-ce compris par des aidants fatigués, sur un téléphone ?
12. **Rappels et carnet.** Texte du courriel de rappel (générique, sans nom) et heure d'envoi (8 h l'été,
    7 h l'hiver). Carnet de bord visible seulement par les membres qui ont accès à la santé : le bon
    partage ? Faut-il un rappel de ce qu'on évite d'y écrire ?
