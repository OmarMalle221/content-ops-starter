// Textes de l'étape 4 : navigateur de droits et administration des fiches.
import type { QuestionFact } from '../shared/benefits/engine';

export const PROGRAM_STATUS_LABELS: Record<string, string> = {
    to_explore: 'À explorer',
    in_progress: 'Demande en cours',
    obtained: 'Obtenu',
    refused: 'Refusé'
};

export const QUESTIONS: Record<QuestionFact, { label: string; hint?: string }> = {
    pays_home_support_services: {
        label: 'Votre proche paie-t-il des services qui l’aident à rester chez lui ?',
        hint: 'Par exemple : ménage, repas, aide pour se laver, surveillance, ou un loyer de résidence qui comprend ces services.'
    },
    domestic_help: {
        label: 'Reçoit-il, ou aimerait-il recevoir, de l’aide domestique ?',
        hint: 'Ménage, entretien des vêtements, préparation de repas, courses.'
    },
    severe_prolonged_impairment: {
        label: 'A-t-il une incapacité grave qui dure (ou durera) au moins 12 mois et le limite beaucoup au quotidien ?',
        hint: 'Par exemple pour marcher, s’habiller, se nourrir ou se souvenir. Un professionnel de la santé devra l’attester.'
    },
    impairment_dependency: {
        label: 'Dépend-il de vous à cause d’une déficience physique ou mentale ?'
    },
    caregiver_cohabits: {
        label: 'Habitez-vous avec lui ?'
    },
    needs_home_adaptation: {
        label: 'Son logement aurait-il besoin d’être adapté ?',
        hint: 'Barres d’appui, bain ou douche difficile d’accès, escaliers, entrée.'
    }
};

export const benefits = {
    tab: 'Droits',
    title: 'Aides et programmes',
    intro: 'Quelques questions pour repérer les aides auxquelles votre proche, ou vous, pourriez avoir droit. Relais ne décide de rien : l’admissibilité se confirme toujours auprès de l’organisme.',
    howItWorks:
        'Les programmes sont choisis par des règles écrites à partir des sources officielles, sans intelligence artificielle. Aucun montant n’est affiché : il dépend de chaque situation.',
    notFilled: 'Le questionnaire n’a pas encore été rempli.',
    readOnly: 'Vous pouvez consulter les résultats sans les modifier.',

    questionnaireTitle: 'Questionnaire',
    age: 'Âge de votre proche',
    ageHint: 'Calculé à partir de l’année de naissance du profil, si elle est indiquée.',
    ageError: 'Entrez un âge entre 18 et 120 ans, ou laissez vide.',
    livingSetting: 'Où vit-il ?',
    yes: 'Oui',
    no: 'Non',
    unknown: 'Je ne sais pas',
    submit: 'Voir les aides possibles',
    saving: 'Recherche…',
    redo: 'Refaire le questionnaire',
    cancel: 'Annuler',
    answeredOn: (date: string) => `Réponses du ${date}`,

    likelyTitle: 'Vous pourriez y avoir droit',
    possibleTitle: 'À vérifier : il manque une information',
    unlikelyTitle: 'Peu probable selon vos réponses',
    unlikelyCount: (n: number) => (n === 1 ? 'Voir 1 programme peu probable' : `Voir les ${n} programmes peu probables`),
    none: 'Aucun programme dans cette catégorie.',

    met: 'Rempli',
    notMet: 'Non rempli',
    unknownCriterion: 'À préciser',
    source: (label: string) => `Source : ${label}`,
    officialLink: 'Site officiel',
    officialLinkMissing: 'Lien officiel à confirmer',
    verifiedOn: (date: string) => `Fiche vérifiée le ${date}`,
    toVerify: 'Fiche À VÉRIFIER : l’équipe Relais ne l’a pas encore vérifiée à la source.',
    confirmEligibility: (organization: string) => `Admissibilité à confirmer auprès de : ${organization}.`,
    details: 'Voir la fiche et les démarches',

    programNotFound: 'Cette fiche n’existe pas ou n’est plus active.',
    backToList: 'Toutes les aides',
    criteriaTitle: 'Conditions indiquées par la fiche',
    documentsTitle: 'Pièces à fournir',
    noDocuments: 'La fiche n’indique aucune pièce.',
    addDocument: 'Ajouter une pièce à la liste',
    addDocumentLabel: 'Pièce à ajouter',
    add: 'Ajouter',
    removeDocument: (label: string) => `Retirer « ${label} »`,
    howToApplyTitle: 'Comment faire la demande',
    statusTitle: 'Où en êtes-vous ?',
    statusSaved: 'Statut enregistré.',
    notesLabel: 'Notes pour la famille (facultatif)',
    saveNotes: 'Enregistrer les notes',
    notesSaved: 'Notes enregistrées.',
    notInFile: 'Ce programme ne fait pas partie de vos démarches, selon vos réponses au questionnaire.',

    explainTitle: 'En termes simples',
    explain: 'Expliquer simplement',
    explaining: 'Préparation de l’explication…',
    explainedFromFiche:
        'Explication préparée par l’intelligence artificielle à partir de cette fiche seulement. Vérifiez auprès de l’organisme.',
    whoItMayHelp: 'Pour qui',
    steps: 'Les étapes',
    notInFiche: 'Ce que la fiche ne dit pas',
    dontKnow:
        'Je ne sais pas : Relais n’a pas pu préparer une explication fiable. Voici ce que dit la fiche ; l’organisme peut répondre à vos questions.',

    letterTitle: 'Préparer une lettre',
    letterIntro:
        'Relais prépare un modèle à partir de la fiche, sans y mettre de renseignement personnel. Les noms sont ajoutés sur votre téléphone ; les espaces entre crochets sont à compléter.',
    letterKind: 'Type de lettre',
    letterKinds: {
        information_request: 'Demande d’information',
        application_follow_up: 'Suivi d’une demande envoyée'
    } as Record<string, string>,
    prepareLetter: 'Préparer la lettre',
    preparingLetter: 'Préparation…',
    letterLabel: 'Votre lettre (modifiable)',
    letterUnavailable: 'La lettre n’a pas pu être préparée. Réessayez plus tard.',
    saveLetter: 'Enregistrer la lettre dans le dossier',
    letterSaved: 'Lettre enregistrée.',
    copyLetter: 'Copier la lettre',
    copied: 'Lettre copiée.',

    adminTitle: 'Administration',
    adminIntro: 'Fiches des programmes et ressources d’aide. Chaque modification doit être vérifiée à la source officielle.',
    adminPrograms: 'Fiches des programmes',
    adminResources: 'Ressources d’aide',
    adminOnly: 'Cette section est réservée à l’administration de Relais.',
    newProgram: 'Nouvelle fiche',
    editProgram: 'Modifier la fiche',
    inactive: 'Inactive',
    fields: {
        slug: 'Identifiant (lettres, chiffres et tirets)',
        name: 'Nom du programme',
        organization: 'Organisme',
        summary: 'Description factuelle',
        summaryHint: 'Tirée de la source officielle. Aucun montant, taux ni pourcentage.',
        howToApply: 'Comment faire la demande',
        documents: 'Pièces à fournir (une par ligne)',
        officialUrl: 'Lien officiel (https://…)',
        sourceLabel: 'Source (nom de la page officielle)',
        criteria: 'Critères (JSON)',
        criteriaHint:
            'Faits possibles : recipient_age, living_setting, pays_home_support_services, domestic_help, severe_prolonged_impairment, impairment_dependency, caregiver_cohabits, needs_home_adaptation, is_caregiver.',
        sortOrder: 'Ordre d’affichage',
        active: 'Fiche active (visible par les familles)',
        phone: 'Téléphone (facultatif)',
        sms: 'Texto (facultatif)',
        url: 'Site (facultatif)',
        description: 'Description (facultatif)',
        hours: 'Heures (facultatif)',
        sourceUrl: 'Source officielle (https://…)'
    },
    verifyTitle: 'Vérification',
    verifyCheck: 'J’ai vérifié aujourd’hui cette fiche à la source officielle.',
    verifyBy: 'Vos initiales',
    verifyRequired: 'Entrez vos initiales pour confirmer la vérification.',
    criteriaInvalid: 'Les critères ne sont pas valides (JSON ou faits inconnus).',
    amountRefused: 'Refusé : la fiche contient un montant, un taux ou un pourcentage, ou une fiche vérifiée n’a pas de lien officiel.',
    saveProgram: 'Enregistrer la fiche',
    programSaved: 'Fiche enregistrée.',
    resourceSaved: 'Ressource enregistrée.',
    saveResource: 'Enregistrer',
    status: (verified: boolean, date: string | null, by: string | null) =>
        verified && date ? `Vérifiée le ${date}${by ? ` par ${by}` : ''}` : 'À vérifier',
    version: (n: number) => `Version ${n}`
};
