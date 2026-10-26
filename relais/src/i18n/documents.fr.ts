// Textes de l'étape 3 : documents, lecture automatique, relecture, chronologie, médicaments.

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
    pending_upload: 'Envoi incomplet',
    uploaded: 'À lire',
    processing: 'Lecture en cours',
    draft_ready: 'Brouillon à vérifier',
    confirmed: 'Ajouté au dossier',
    failed: 'À noter à la main'
};

export const EXTRACTION_ERROR_LABELS: Record<string, string> = {
    ai_consent_missing: 'La lecture automatique n’est pas autorisée pour ce dossier.',
    no_text_layer: 'Ce PDF est une image numérisée : Relais ne peut pas encore le lire automatiquement.',
    photo_without_ocr: 'Relais ne lit pas encore les photos automatiquement.',
    too_long: 'Ce document est trop long pour la lecture automatique (30 pages au plus).',
    unreadable_pdf: 'Ce fichier PDF n’a pas pu être ouvert (protégé ou abîmé).',
    refusal: 'La lecture automatique n’a pas abouti pour ce document.',
    invalid_output: 'La lecture automatique n’a pas donné un résultat fiable.',
    ai_unavailable: 'La lecture automatique est indisponible pour le moment.'
};

/** Erreurs pour lesquelles un nouvel essai a des chances d'aboutir. */
export const RETRYABLE_ERRORS = new Set(['refusal', 'invalid_output', 'ai_unavailable']);

export const documents = {
    tab: 'Documents',
    title: 'Documents',
    intro: 'Résumés de départ, ordonnances, avis de rendez-vous, lettres : gardez-les ici, au même endroit, pour toute la famille.',
    noDocuments: 'Aucun document pour le moment.',
    readOnly: 'Vous pouvez consulter les documents sans en ajouter.',
    noHealthConsent: 'Pour ajouter des documents, acceptez d’abord le consentement « Renseignements de santé » (Mes consentements).',
    aiOn: 'Lecture automatique activée : Relais prépare un brouillon que vous vérifiez avant qu’il entre au dossier.',
    aiOff: 'Lecture automatique non activée : vous noterez vous-même ce que contient chaque document.',
    aiOffOwner: 'Activer la lecture automatique',

    addTitle: 'Ajouter un document',
    takePhoto: 'Prendre une photo',
    chooseFile: 'Choisir un fichier (PDF ou photo)',
    addHint:
        'PDF, JPEG ou PNG, 20 Mo au plus. Les photos sont réduites et leurs métadonnées (dont la position GPS) sont retirées avant l’envoi.',
    preparing: 'Préparation de la photo…',
    uploading: 'Envoi du document…',
    reading: 'Lecture du document… Cela prend habituellement moins de 30 secondes.',
    tooBig: 'Ce fichier dépasse 20 Mo.',
    badType: 'Ce type de fichier n’est pas pris en charge. Utilisez un PDF, une photo JPEG ou PNG.',
    badImage: 'Cette photo n’a pas pu être ouverte. Essayez de la reprendre avec l’appareil photo.',
    uploadError: 'L’envoi n’a pas abouti. Vérifiez votre connexion et réessayez.',

    untitled: (date: string) => `Document ajouté le ${date}`,
    pages: (n: number) => (n === 1 ? '1 page' : `${n} pages`),
    photo: 'Photo',
    toCheck: 'À vérifier',
    addedBy: (name: string) => `Ajouté par ${name}`,

    notFound: 'Ce document n’existe pas, ou vous n’y avez pas accès.',
    cancel: 'Annuler',
    backToList: 'Tous les documents',
    openOriginal: 'Afficher le document original',
    openingOriginal: 'Préparation du lien…',
    originalReady: 'Ouvrir le document (lien valable 60 secondes)',
    originalError: 'Le document n’a pas pu être ouvert. Réessayez.',

    pendingUpload:
        'L’envoi de ce document n’est pas terminé. Supprimez-le et ajoutez-le de nouveau. Sinon, Relais l’effacera de lui-même dans les 24 heures.',
    toRead: 'Ce document n’a pas encore été lu.',
    readAuto: 'Lire automatiquement',
    readAgain: 'Réessayer la lecture automatique',
    enterManually: 'Noter moi-même le contenu',
    processing: 'Lecture en cours…',
    waitingForFamily: 'Un membre de la famille doit vérifier ce brouillon avant qu’il entre au dossier.',

    reviewTitle: 'Vérifier le brouillon',
    manualTitle: 'Noter le contenu du document',
    reviewIntro:
        'Relais a préparé ce brouillon à partir du document. Vérifiez chaque élément : gardez-le, corrigez-le ou décochez-le. Rien n’entre au dossier avant votre confirmation.',
    manualIntro: 'Notez ce que vous voulez garder de ce document. Vous pouvez laisser des sections vides.',
    noAdvice:
        'Relais résume ce qui est écrit, sans l’interpréter : il ne donne aucun conseil médical. Pour une question de santé ou sur un médicament, adressez-vous au professionnel qui suit votre proche, au pharmacien ou à Info-Santé.',
    noAdviceShort: 'Pour une question de santé ou sur un médicament :',
    callInfoSante: (number: string) => `Info-Santé : ${number}`,
    reasonsTitle: 'Points à vérifier',

    documentSection: 'Le document',
    docTitle: 'Titre',
    docType: 'Type de document',
    docDate: 'Date du document (facultatif)',
    docAuthor: 'Auteur ou établissement (facultatif)',
    markToCheck: 'Marquer ce document « à vérifier » (manuscrit, flou, incomplet)',
    summary: 'Résumé',
    summaryHint: 'Préparé automatiquement à partir du document. Corrigez-le au besoin.',
    summaryManualHint: 'Quelques phrases, dans vos mots (facultatif).',

    medicationsSection: 'Médicaments tels qu’écrits',
    medicationsHint: 'Recopiés du document, sans interprétation. Corrigez-les seulement s’ils ne correspondent pas au document.',
    medication: (n: number, name: string) => `Médicament ${n}${name ? ` : ${name}` : ''}`,
    medName: 'Nom',
    medDosage: 'Dose (facultatif)',
    medFrequency: 'Fréquence (facultatif)',
    addMedication: 'Ajouter un médicament',

    eventsSection: 'Événements et rendez-vous',
    eventsHint: 'Ils seront ajoutés à la chronologie, avec un lien vers ce document.',
    event: (n: number, title: string) => `Événement ${n}${title ? ` : ${title}` : ''}`,
    eventDate: 'Date',
    eventType: 'Type',
    eventTitle: 'Description courte',
    eventDetails: 'Précisions (facultatif)',
    addEvent: 'Ajouter un événement',

    actionsSection: 'À faire selon le document',
    actionsHint: 'Gardés avec ce document. Ils pourront devenir des tâches partagées (prochaine version).',
    action: (n: number) => `À faire ${n}`,
    actionText: 'Ce qui est à faire',
    addAction: 'Ajouter un élément à faire',

    keep: 'Garder cet élément',
    sourceLine: (line: string) => `Ligne du document : « ${line} »`,
    unverified: 'À vérifier : introuvable tel quel dans le document',
    remove: 'Retirer',

    confirm: 'Confirmer et ajouter au dossier',
    confirming: 'Enregistrement…',
    discard: 'Rejeter tout le brouillon',
    discarded: 'Brouillon rejeté. Vous pouvez relancer la lecture ou noter vous-même le contenu.',
    confirmed: 'Le document a été ajouté au dossier.',
    errorMedName: (n: number) => `Médicament ${n} : entrez un nom, ou décochez « Garder ».`,
    errorEventDate: (n: number) => `Événement ${n} : entrez une date, ou décochez « Garder ».`,
    errorEventTitle: (n: number) => `Événement ${n} : entrez une description, ou décochez « Garder ».`,
    errorAction: (n: number) => `À faire ${n} : entrez un texte, ou décochez « Garder ».`,
    errorStale: 'Ce brouillon a déjà été traité par un autre membre. La page a été mise à jour.',

    confirmedTitle: 'Ce que contient le document',
    confirmedOn: (date: string) => `Vérifié le ${date}`,
    manualEntry: 'Contenu noté à la main.',
    nothingKept: 'Aucun élément n’a été gardé.',
    seeTimeline: 'Voir la chronologie',

    deleteDocument: 'Supprimer le document',
    confirmDelete:
        'Supprimer ce document ? Le fichier, son résumé, ses médicaments et ses événements seront effacés pour toute la famille.',
    deleteConfirm: 'Supprimer définitivement',
    deleted: 'Document supprimé.',

    timelineTab: 'Chronologie',
    timelineTitle: 'Chronologie',
    timelineIntro:
        'Hospitalisations, retours à domicile, rendez-vous, changements de services : l’histoire récente de votre proche, chaque élément relié à sa source.',
    noEvents: 'Aucun événement pour le moment.',
    fromDocument: 'Voir le document source',
    addedManually: 'Ajouté à la main',
    addManualEvent: 'Ajouter un événement',
    saveEvent: 'Ajouter à la chronologie',
    eventDateRequired: 'Entrez une date.',
    eventTitleRequired: 'Entrez une description courte.',
    eventSaved: 'Événement ajouté.',
    deleteEvent: 'Retirer',
    confirmDeleteEvent: (title: string) => `Retirer « ${title} » de la chronologie ?`,
    eventDeleted: 'Événement retiré.',

    medicationsTitle: 'Médicaments mentionnés dans les documents',
    medicationsIntro:
        'Recopiés tels qu’ils sont écrits dans les documents vérifiés. Cette liste n’est pas une liste de médicaments à jour : seul le pharmacien ou le médecin peut la confirmer.',
    noMedications: 'Aucun médicament noté pour le moment.',
    mentionedOn: (date: string) => `Document du ${date}`,
    deleteMedication: 'Retirer',
    medicationDeleted: 'Mention retirée.',

    aiConsentTitle: 'Lecture automatique des documents (facultatif)',
    aiConsentIntro:
        'Un consentement distinct, que la personne aidée ou son représentant peut donner ou retirer à tout moment. Sans lui, les documents restent dans Relais et la famille en note le contenu elle-même.',
    aiConsentActive: 'Lecture automatique autorisée',
    aiConsentNone: 'Lecture automatique non autorisée.',
    aiConsentRevoked: (date: string) => `Autorisation retirée le ${date}.`,
    aiConsentNeedsRecipient: 'Enregistrez d’abord le consentement de la personne aidée.',
    aiRecipientGive: 'J’autorise la lecture automatique de mes documents',
    aiRevoke: 'Retirer l’autorisation',
    aiConfirmRevoke: 'Retirer l’autorisation de lecture automatique ?',
    aiRevokeEffect: 'Les prochains documents ne seront plus lus automatiquement. Ce qui est déjà vérifié reste au dossier.',
    aiRecord: 'Enregistrer l’autorisation',
    aiRecorded: 'Autorisation enregistrée.',
    aiRevoked: 'Autorisation retirée.',
    formAiTitle: 'Lecture automatique des documents (facultatif)',
    formAiChoice: 'Cochez votre choix :',
    formAiYes: 'J’accepte',
    formAiNo: 'Je refuse'
};
