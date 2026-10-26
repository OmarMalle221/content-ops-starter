// Textes de l'étape 2 : dossier familial, membres, invitations, consentement de la personne aidée.

export const ROLE_LABELS: Record<string, string> = {
    primary_caregiver: 'Personne aidante principale',
    family_member: 'Membre de la famille',
    care_recipient: 'Personne aidée',
    relais_worker: 'Intervenante Relais'
};

export const ACCESS_LABELS: Record<string, string> = {
    owner: 'Gère le dossier',
    full: 'Accès complet',
    coordination: 'Coordination seulement',
    read_only: 'Lecture seule'
};

export const ACCESS_DESCRIPTIONS: Record<string, string> = {
    full: 'Voit et modifie tout le dossier, sauf la gestion des membres.',
    coordination: 'Voit le profil et les contacts, et aidera aux tâches et aux rendez-vous. Ne voit ni les documents ni la santé.',
    read_only: 'Voit tout le dossier, sans rien modifier.'
};

export const LIVING_SETTING_LABELS: Record<string, string> = {
    home: 'À domicile',
    rpa: 'En résidence privée pour aînés (RPA)',
    intermediate_resource: 'En ressource intermédiaire (RI)',
    chsld: 'En CHSLD',
    hospital: 'À l’hôpital',
    other: 'Autre'
};

export const CONTACT_KIND_LABELS: Record<string, string> = {
    clsc: 'CLSC',
    social_worker: 'Travailleuse sociale ou travailleur social',
    physician: 'Médecin',
    pharmacy: 'Pharmacie',
    notary: 'Notaire',
    residence: 'Résidence',
    home_care: 'Soutien à domicile',
    other: 'Autre'
};

export const SERVICE_LABELS: Record<string, string> = {
    clsc_home_support: 'Soutien à domicile du CLSC',
    domestic_help: 'Aide domestique (entreprise d’économie sociale)',
    meals_on_wheels: 'Popote roulante',
    day_center: 'Centre de jour',
    respite: 'Répit',
    adapted_transport: 'Transport adapté'
};

export const LEGAL_BASIS_LABELS: Record<string, string> = {
    person_consents: 'La personne consent elle-même',
    homologated_protection_mandate: 'Mandat de protection homologué',
    tutorship: 'Tutelle',
    power_of_attorney: 'Procuration (à faire valider)',
    other: 'Autre représentant légal'
};

export const GRANTOR_LABELS: Record<string, string> = {
    care_recipient_in_app: 'Accord donné par la personne aidée dans Relais',
    care_recipient_signed_form: 'Formulaire signé par la personne aidée',
    legal_representative: 'Accord du représentant légal'
};

export const ACTION_LABELS: Record<string, string> = {
    file_opened: 'a ouvert le dossier',
    member_invited: 'a invité une personne',
    member_joined: 'a rejoint le dossier',
    member_removed: 'a retiré un membre',
    member_access_changed: 'a changé un niveau d’accès',
    consent_granted: 'a enregistré un consentement',
    consent_revoked: 'a retiré un consentement',
    export_requested: 'a téléchargé le dossier',
    document_uploaded: 'a ajouté un document',
    document_viewed: 'a consulté un document',
    document_deleted: 'a supprimé un document',
    upload_expired: 'a effacé un document dont l’envoi était resté incomplet plus de 24 heures',
    extraction_viewed: 'a consulté un résumé de document',
    extraction_confirmed: 'a confirmé un résumé de document',
    prep_sheet_printed: 'a imprimé une fiche de rendez-vous'
};

export const files = {
    myFiles: 'Vos dossiers',
    emptyFiles:
        'Vous n’avez pas encore de dossier. Créez celui de votre parent, ou ouvrez le lien d’invitation reçu d’un membre de votre famille.',
    createFile: 'Créer le dossier d’un proche',
    pendingInvitation: 'Vous avez reçu une invitation à rejoindre un dossier.',
    seeInvitation: 'Voir l’invitation',
    yourRole: (role: string) => `Votre rôle : ${role}`,

    newTitle: 'Créer le dossier d’un proche',
    newIntro: 'Commençons par un nom simple, celui que vous utilisez en famille. Vous pourrez le changer plus tard.',
    titleLabel: 'Nom du dossier',
    titleHint: 'Par exemple : « Maman », « Papa », « Tante Lise ».',
    titleError: 'Entrez un nom (80 caractères au plus).',
    create: 'Créer le dossier',
    creating: 'Création…',

    notFound: 'Ce dossier n’existe pas, ou vous n’y avez plus accès.',
    nav: 'Sections du dossier',
    tabs: {
        overview: 'Aperçu',
        profile: 'Profil',
        contacts: 'Contacts',
        consent: 'Consentement',
        members: 'Membres',
        log: 'Journal des accès',
        settings: 'Paramètres'
    },
    consentMissingOwner: 'Avant d’ajouter des renseignements, enregistrez le consentement de votre proche.',
    consentMissingMember: 'Le consentement de la personne aidée n’est pas enregistré : rien ne peut être ajouté au dossier pour le moment.',
    recordConsent: 'Enregistrer le consentement',

    overviewTitle: 'Aperçu du dossier',
    profileMissing: 'Le profil n’est pas encore rempli.',
    completeProfile: 'Remplir le profil',
    age: (years: number) => `${years} ans environ`,
    since: (date: string) => `depuis le ${date}`,
    chsldWaitlist: 'En attente d’une place en CHSLD',
    chsldWaitlistSince: (date: string) => `En attente d’une place en CHSLD depuis le ${date}`,
    contactsCount: (n: number) => (n === 0 ? 'Aucun contact' : n === 1 ? '1 contact' : `${n} contacts`),
    membersCount: (n: number) => (n === 1 ? '1 membre' : `${n} membres`),

    consentTitle: 'Consentement de la personne aidée',
    consentIntro:
        'Relais a besoin de l’accord de la personne aidée, ou de son représentant légal, pour garder ses renseignements. Sans cet accord, rien ne peut être ajouté au dossier.',
    consentActive: 'Consentement en vigueur',
    consentNone: 'Aucun consentement enregistré.',
    consentRevoked: (date: string) => `Consentement retiré le ${date}. Plus rien ne peut être ajouté au dossier.`,
    consentRecordedOn: (date: string) => `Enregistré le ${date}`,
    representative: (name: string) => `Représentant : ${name}`,
    whoConsents: 'Qui donne son accord ?',
    optionSelf: 'Mon proche donne son accord lui-même et a signé le formulaire',
    optionSelfHint: 'Imprimez le formulaire, lisez-le avec votre proche, et gardez la copie signée.',
    printForm: 'Imprimer le formulaire à signer',
    attestSelf: 'J’atteste que mon proche a lu (ou s’est fait lire) le formulaire et l’a signé.',
    optionRepresentative: 'Son représentant légal donne son accord',
    legalBasisLabel: 'Fondement',
    representativeLabel: 'Nom du représentant légal',
    representativeHint: 'Par exemple : la personne mandataire nommée dans le mandat de protection homologué, ou le tuteur.',
    attestRepresentative: 'J’atteste que cette personne est son représentant légal et qu’elle a donné son accord.',
    noRepresentative:
        'Votre proche ne peut plus consentir et n’a pas de représentant légal ? Pendant le pilote, Relais ne peut pas accueillir son dossier. Le CLSC ou un notaire peut vous renseigner sur le mandat de protection.',
    save: 'Enregistrer',
    saving: 'Enregistrement…',
    attestRequired: 'Cochez l’attestation pour continuer.',
    representativeRequired: 'Entrez le nom du représentant légal.',
    chooseOption: 'Choisissez qui donne son accord.',
    recorded: 'Consentement enregistré.',
    withdrawnByRecipient:
        'Votre proche a retiré son accord lui-même dans Relais. Seul votre proche, ou son représentant légal, peut le redonner.',
    revoke: 'Retirer le consentement',
    confirmRevoke: 'Retirer le consentement de la personne aidée ?',
    revokeEffect: 'Plus rien ne pourra être ajouté au dossier. Il restera consultable, téléchargeable et supprimable.',
    confirm: 'Confirmer le retrait',
    cancel: 'Annuler',
    revoked: 'Consentement retiré.',
    recipientGive: 'Je donne mon accord',
    recipientIntro: 'Ce dossier vous concerne. Vous pouvez donner ou retirer votre accord à tout moment.',

    formTitle: 'Formulaire de consentement',
    formFor: (title: string) => `Dossier : ${title}`,
    formPersonName: 'Nom de la personne aidée',
    formSignature: 'Signature',
    formDate: 'Date',
    formRepresentative: 'S’il y a lieu, nom et qualité du représentant légal',
    formPrint: 'Imprimer',
    formVersion: (version: string) => `Texte du ${version}`,

    profileTitle: 'Profil',
    readOnly: 'Vous pouvez consulter cette section sans la modifier.',
    firstName: 'Prénom',
    lastName: 'Nom de famille (facultatif)',
    birthYear: 'Année de naissance (facultatif)',
    birthYearHint: 'Seulement l’année : Relais n’a pas besoin de la date complète.',
    birthYearError: 'Entrez une année à 4 chiffres, par exemple 1944.',
    livingSetting: 'Milieu de vie',
    livingSettingSince: 'Depuis (facultatif)',
    residenceName: 'Nom de la résidence (facultatif)',
    chsldWaitlistLabel: 'En attente d’une place en CHSLD',
    chsldWaitlistSinceLabel: 'Inscrit sur la liste depuis (facultatif)',
    saveProfile: 'Enregistrer le profil',
    profileSaved: 'Profil enregistré.',
    firstNameError: 'Entrez un prénom (60 caractères au plus).',
    needsTitle: 'Autonomie et services',
    needsHealthNote: 'Ces renseignements sont considérés comme des renseignements de santé.',
    needsNoHealthConsent: 'Pour ajouter ou modifier ces renseignements, acceptez d’abord le consentement « Renseignements de santé ».',
    autonomy: 'Autonomie, décrite par vous',
    autonomyHint: 'Par exemple : se lave seule avec de l’aide pour le bain ; ne conduit plus.',
    services: 'Services déjà en place',
    adaptation: 'Besoins d’adaptation du logement (facultatif)',
    adaptationHint: 'Par exemple : barres d’appui, bain difficile d’accès, escaliers.',
    saveNeeds: 'Enregistrer',
    needsSaved: 'Renseignements enregistrés.',
    nothingYet: 'Rien d’indiqué pour le moment.',

    contactsTitle: 'Contacts clés',
    contactsIntro: 'CLSC, travailleuse sociale, médecin, pharmacie, notaire : les coordonnées utiles à toute la famille.',
    noContacts: 'Aucun contact pour le moment.',
    addContact: 'Ajouter un contact',
    editContact: 'Modifier',
    deleteContact: 'Supprimer',
    confirmDeleteContact: (name: string) => `Supprimer le contact « ${name} » ?`,
    contactKind: 'Type',
    contactName: 'Nom',
    contactOrganization: 'Organisme (facultatif)',
    contactPhone: 'Téléphone (facultatif)',
    contactEmail: 'Courriel (facultatif)',
    contactAddress: 'Adresse (facultatif)',
    contactNotes: 'Notes (facultatif)',
    contactNameError: 'Entrez un nom.',
    saveContact: 'Enregistrer le contact',
    contactSaved: 'Contact enregistré.',
    contactDeleted: 'Contact supprimé.',
    call: (name: string) => `Appeler ${name}`,

    membersTitle: 'Membres',
    membersIntro: 'Les personnes qui ont accès à ce dossier, et ce qu’elles peuvent voir.',
    you: 'vous',
    unnamed: 'Membre sans nom',
    changeLevel: (name: string) => `Niveau d’accès de ${name}`,
    removeMember: 'Retirer du dossier',
    confirmRemove: (name: string) => `Retirer ${name} du dossier ?`,
    removed: 'Membre retiré.',
    levelChanged: 'Niveau d’accès modifié.',
    leave: 'Quitter ce dossier',
    confirmLeave: 'Quitter ce dossier ? Vous n’y aurez plus accès, sauf nouvelle invitation.',
    inviteTitle: 'Inviter une personne',
    inviteEmail: 'Son adresse courriel',
    inviteEmailHint: 'Le lien d’invitation ne fonctionnera que pour cette adresse.',
    inviteWho: 'Qui invitez-vous ?',
    inviteFamily: 'Un membre de la famille',
    inviteRecipient: 'Mon proche lui-même (lecture seule)',
    inviteWorker: 'Une intervenante Relais',
    inviteLevel: 'Ce que cette personne pourra faire',
    createInvitation: 'Créer le lien d’invitation',
    invitationReady: (email: string) => `Lien prêt. Envoyez-le à ${email} par texto ou par courriel. Il fonctionne pendant 7 jours.`,
    invitationLink: 'Lien d’invitation',
    share: 'Partager le lien',
    copy: 'Copier le lien',
    copied: 'Lien copié.',
    pending: 'Invitations en attente',
    noPending: 'Aucune invitation en attente.',
    expiresOn: (date: string) => `expire le ${date}`,
    revokeInvitation: 'Annuler l’invitation',
    invitationRevoked: 'Invitation annulée.',
    alreadyMember: 'Cette personne fait déjà partie du dossier.',
    emailError: 'Entrez une adresse courriel complète.',

    ownerOnly: 'Cette section est réservée à la personne aidante principale du dossier.',
    logTitle: 'Journal des accès',
    logIntro: 'Qui a ouvert le dossier, qui l’a modifié, et quand. Le journal ne contient aucun renseignement du dossier.',
    logEmpty: 'Aucune entrée pour le moment.',
    formerMember: 'Personne qui n’a plus accès',
    relais: 'Relais',

    settingsTitle: 'Paramètres du dossier',
    renameTitle: 'Nom du dossier',
    rename: 'Renommer',
    renamed: 'Dossier renommé.',
    exportTitle: 'Télécharger le dossier',
    exportText: 'Une copie complète du dossier, dans un fichier structuré que d’autres logiciels peuvent lire (JSON).',
    exportButton: 'Télécharger le dossier',
    exportDone: 'Le fichier a été téléchargé.',
    deleteTitle: 'Supprimer le dossier',
    deleteText:
        'La suppression efface tout le dossier pour tous ses membres : profil, contacts, consentements et invitations. Elle est définitive. Le journal garde seulement la trace de la suppression.',
    deleteConfirm: 'Je comprends que la suppression est définitive.',
    deleteButton: 'Supprimer le dossier',
    deleted: (title: string) => `Le dossier « ${title} » a été supprimé.`,

    invitationTitle: 'Invitation',
    invitationMissing: 'Ce lien d’invitation est incomplet. Demandez à la personne qui vous a invité de vous le renvoyer.',
    invitationSignIn:
        'Vous avez été invité à rejoindre le dossier d’un proche dans Relais. Connectez-vous avec l’adresse courriel qui a reçu l’invitation.',
    signInToAccept: 'Me connecter pour accepter',
    invitationAccept: 'Rejoindre le dossier',
    invitationIntro:
        'Vous avez été invité à rejoindre le dossier d’un proche. En acceptant, vous verrez ce que la personne aidante principale vous a permis de voir.',
    invitationWrongEmail: 'Cette invitation a été envoyée à une autre adresse courriel. Connectez-vous avec l’adresse qui l’a reçue.',
    invitationInvalid: 'Cette invitation n’est plus valide (déjà utilisée, annulée ou expirée). Demandez un nouveau lien.',
    invitationAlreadyMember: 'Vous faites déjà partie de ce dossier.',
    invitationWorkerOnly: 'Cette invitation est réservée à une intervenante Relais.',
    accountOwnsFiles:
        'Vous êtes la personne aidante principale d’au moins un dossier. Supprimez d’abord ce dossier (Paramètres du dossier) avant de supprimer votre compte.'
};
