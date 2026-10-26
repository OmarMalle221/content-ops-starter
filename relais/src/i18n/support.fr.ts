// Textes de l'étape 6 : bilan de la semaine, demandes d'intervenante, tableau de suivi, évaluation du
// pilote, mesures agrégées. Aucun délai n'est promis (Q4 : heures et délais des intervenantes à confirmer).

export const SCALE_LABELS = ['Pas du tout', 'Un peu', 'Moyennement', 'Beaucoup', 'Énormément'] as const;
export const SATISFACTION_LABELS = ['Pas du tout', 'Peu', 'Moyennement', 'Bien', 'Tout à fait'] as const;

export const support = {
    // ------------------------------------------------------------------------------------------ bilan
    checkinTitle: 'Comment allez-vous cette semaine ?',
    checkinIntro: 'Trois questions, pour vous. Ce n’est pas un test : seulement un moment pour faire le point.',
    questions: {
        fatigue: 'Cette semaine, avez-vous manqué d’énergie ?',
        overwhelm: 'Avez-vous eu l’impression de ne plus arriver à tout faire ?',
        isolation: 'Avez-vous eu l’impression de porter tout ça sans aide ?'
    },
    checkinError: 'Répondez aux trois questions pour voir votre bilan.',
    seeResult: 'Voir mon bilan',
    redo: 'Refaire le bilan',
    keptPrivate:
        'Vos réponses sont gardées pour vous seulement : ni votre famille, ni les intervenantes, ni l’équipe Relais ne les voient.',
    notKept: 'Vos réponses ne sont pas gardées : le résultat s’affiche, puis elles sont oubliées.',
    keepLink: 'Pour voir votre évolution d’une semaine à l’autre : « Mon bilan de la semaine », dans Mes consentements',
    heavyTitle: 'Cette semaine semble lourde.',
    heavyText:
        'Vous n’avez pas à tout porter sans aide. Des services de répit et d’écoute existent pour les personnes proches aidantes, et une intervenante de Relais peut vous rappeler.',
    lightTitle: 'Merci d’avoir pris ce moment pour vous.',
    lightText: 'Si les choses changent, ces ressources sont là pour vous, et vous pouvez refaire le bilan quand vous voulez.',
    talkToWorker: 'Parler à une intervenante',
    historyTitle: 'Mes dernières semaines',
    weekOf: (date: string) => `Semaine du ${date}`,
    historyLine: (fatigue: number, overwhelm: number, isolation: number) =>
        `Fatigue ${fatigue} sur 5, débordement ${overwhelm} sur 5, isolement ${isolation} sur 5`,
    saved: 'Bilan gardé.',

    // ----------------------------------------------------------------------------- parler à une intervenante
    requestTitle: 'Parler à une intervenante',
    requestIntro:
        'Une intervenante de l’équipe Relais peut vous rappeler pour vous écouter, vous informer ou vous aider à trouver du soutien. C’est gratuit.',
    requestNoDelay: 'Elle vous contactera dès que possible.',
    notEmergency: 'Relais n’est pas un service d’urgence. Si quelqu’un est en danger ou si vous pensez au suicide :',
    contactName: 'Votre prénom',
    contactNameError: 'Indiquez comment vous appeler.',
    contactBy: 'Comment vous joindre ?',
    byPhone: 'Par téléphone',
    byEmail: 'Par courriel',
    byEmailHint: 'À l’adresse de votre compte Relais.',
    phone: 'Votre numéro de téléphone',
    phoneError: 'Entrez un numéro de téléphone d’au moins 7 chiffres.',
    times: 'Quand vous joindre ? (facultatif)',
    timesHint: 'Par exemple : en soirée, ou le mardi matin.',
    message: 'Ce dont vous voulez parler (facultatif)',
    file: 'Au sujet de quel dossier ? (facultatif)',
    noFile: 'Aucun en particulier',
    fileHint: 'Mentionner un dossier ne donne pas accès à son contenu.',
    checkinNotShared: 'Vos réponses au bilan ne sont pas transmises.',
    send: 'Envoyer ma demande',
    sending: 'Envoi…',
    sent: 'Votre demande est envoyée. Une intervenante vous contactera dès que possible. Si la situation devient urgente, appelez le 911.',
    myRequests: 'Mes demandes',
    noRequests: 'Aucune demande pour l’instant.',
    sentOn: (date: string) => `Envoyée le ${date}`,
    statusLabels: {
        new: 'Reçue : une intervenante va vous contacter.',
        assigned: 'Prise en charge par une intervenante.',
        closed: 'Fermée.'
    } as Record<string, string>,
    cancel: 'Je n’en ai plus besoin',
    cancelled: 'Demande retirée.',
    distressTitle: 'Une intervenante de Relais peut aussi vous rappeler',
    distressAsk: 'Demander qu’on me rappelle',

    // -------------------------------------------------------------------------------- tableau intervenantes
    workerTitle: 'Demandes d’intervenante',
    workerOnly: 'Cette section est réservée aux intervenantes de Relais.',
    workerIntro:
        'Les demandes des familles. Les courriels d’avis ne contiennent rien : tout est ici, derrière la vérification en deux étapes.',
    filterLegend: 'Afficher',
    filters: {
        new: (n: number) => `Nouvelles (${n})`,
        mine: (n: number) => `Les miennes (${n})`,
        open: (n: number) => `Toutes les ouvertes (${n})`,
        closed: (n: number) => `Fermées (${n})`
    },
    none: 'Aucune demande.',
    origins: {
        button: 'Bouton « Parler à une intervenante »',
        distress_screen: 'Écran d’urgence',
        checkin: 'Bilan de la semaine'
    } as Record<string, string>,
    receivedOn: (date: string, time: string) => `Reçue le ${date} à ${time}`,
    assignedToMe: 'Prise en charge par vous',
    assignedToColleague: 'Prise en charge par une collègue',
    requestNotFound: 'Cette demande n’existe pas ou n’est plus visible.',
    backToBoard: 'Toutes les demandes',
    contact: 'Joindre la personne',
    callName: (name: string) => `Appeler ${name}`,
    writeName: (name: string) => `Écrire à ${name}`,
    timesLabel: 'Disponibilités',
    messageLabel: 'Message',
    fileLinked: 'Dossier mentionné',
    fileOpen: 'Ouvrir le dossier confié',
    fileNotShared: 'Dossier mentionné, non confié à Relais : demandez à la personne de vous inviter si elle le souhaite.',
    take: 'Je m’en occupe',
    close: 'Fermer la demande',
    reopen: 'Rouvrir la demande',
    statusSaved: 'Demande mise à jour.',
    notesTitle: 'Notes internes',
    notesHint: 'Invisibles pour la personne. Notez les faits utiles au suivi, sans plus.',
    noNotes: 'Aucune note.',
    noteLabel: 'Nouvelle note interne',
    addNote: 'Ajouter la note',
    noteBy: (who: string, date: string) => `${who}, ${date}`,
    you: 'Vous',
    colleague: 'Une collègue',

    // ----------------------------------------------------------------------------------- évaluation
    feedbackTitle: 'Évaluation du pilote',
    feedbackIntro: 'Deux questions facultatives sur la semaine. Vos réponses sont présentées de façon regroupée, sans votre nom.',
    feedbackNoConsent: 'Pour répondre, acceptez « Évaluation du pilote » dans Mes consentements.',
    feedbackConsentLink: 'Mes consentements',
    hours: 'Combien d’heures Relais vous a-t-il fait gagner cette semaine ? (estimation)',
    hoursHint: 'Par demi-heure, par exemple 1,5. Laissez vide si vous ne savez pas.',
    hoursError: 'Entrez un nombre d’heures entre 0 et 80, par demi-heure.',
    satisfaction: 'Cette semaine, Relais vous a-t-il donné satisfaction ?',
    feedbackEmpty: 'Répondez à au moins une question.',
    feedbackSave: 'Envoyer mes réponses',
    feedbackSaved: 'Merci ! Vos réponses de la semaine sont enregistrées.',
    feedbackThisWeek: (date: string) => `Semaine du ${date}`,

    // --------------------------------------------------------------------------------------- admin
    pilotTitle: 'Mesures du pilote',
    pilotIntro:
        'Chiffres regroupés, sans nom. Les réponses de moins de 3 personnes sont masquées. Le bilan de la semaine des aidants n’apparaît jamais ici.',
    participation: 'Participation',
    careFiles: (n: number) => `${n} dossier${n > 1 ? 's' : ''}`,
    members: (n: number) => `${n} membre${n > 1 ? 's' : ''} de famille`,
    pilotConsents: (n: number) => `${n} personne${n > 1 ? 's' : ''} participant${n > 1 ? 'ent' : ''} à l’évaluation`,
    feedbackSection: 'Réponses hebdomadaires',
    suppressed: (n: number, min: number) => `Résultats masqués : ${n} répondant${n > 1 ? 's' : ''}, il en faut au moins ${min}.`,
    respondents: (n: number, responses: number) => `${n} répondants, ${responses} réponses`,
    hoursAvg: (h: string) => `Temps gagné : ${h} h par semaine en moyenne`,
    satisfactionAvg: (s: string) => `Satisfaction : ${s} sur 5 en moyenne`,
    satisfactionCount: (label: string, n: number) => `${label} : ${n}`,
    byWeek: 'Par semaine',
    weekRow: (date: string) => `Semaine du ${date}`,
    weekSuppressed: 'masquée (moins de 3 répondants)',
    weekValues: (h: string, s: string, n: number) => `${h} h, satisfaction ${s} sur 5 (${n} répondants)`,
    programsSection: 'Navigateur de droits (dossiers participant à l’évaluation)',
    programsLine: (identified: number, requested: number, obtained: number, refused: number) =>
        `${identified} programmes repérés, ${requested} demandés, ${obtained} obtenus, ${refused} refusés`,
    medianDays: (d: string) => `Délai médian entre repéré et demandé : ${d} jours`,
    supportSection: 'Demandes d’intervenante',
    supportLine: (total: number, open: number, closed: number) => `${total} demandes : ${open} ouvertes, ${closed} fermées`,
    supportOrigins: (button: number, distress: number, checkin: number) =>
        `Origine : ${button} par le bouton, ${distress} depuis l’écran d’urgence, ${checkin} depuis le bilan`,
    medianHours: (h: string) => `Délai médian de prise en charge : ${h} h`,
    noData: '—',
    generatedAt: (date: string) => `Calculé le ${date}`,

    // ----------------------------------------------------------------------------------- accueil
    homeCheckin: 'Comment allez-vous cette semaine ?',
    homeCheckinText: 'Trois questions pour faire le point, rien que pour vous.',
    homeSupport: 'Parler à une intervenante',
    homeSupportText: 'Pour être écouté, informé ou orienté. C’est gratuit.',
    homeFeedback: 'Évaluation du pilote : 2 questions',
    homeWorker: 'Tableau de suivi des demandes'
};
