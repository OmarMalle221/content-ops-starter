// Tous les textes de l'interface, en français simple. Relecture par une travailleuse sociale prévue
// (VALIDATIONS.md, B7). Les textes de consentement sont dans src/content/consent-texts.fr.json.

export const fr = {
    app: {
        name: 'Relais',
        skipLink: 'Aller au contenu',
        loading: 'Chargement…',
        genericError: 'Un problème est survenu. Vérifiez votre connexion et réessayez.',
        retry: 'Réessayer'
    },
    nav: {
        label: 'Navigation principale',
        home: 'Accueil',
        consents: 'Mes consentements',
        account: 'Mon compte',
        help: 'Aide immédiate',
        signIn: 'Se connecter'
    },
    footer: {
        notMedical: 'Relais ne donne aucun conseil médical. Pour une question de santé, appelez Info-Santé 811.',
        notEmergency: 'Relais n’est pas un service d’urgence. Si quelqu’un est en danger, appelez le 911.',
        privacy: 'Confidentialité'
    },
    landing: {
        title: 'Relais',
        lead: 'Coordonnez les soins de votre parent avec votre famille, et repérez les aides auxquelles il a droit.',
        listTitle: 'Avec Relais, vous pourrez :',
        list: [
            'rassembler le dossier de votre proche au même endroit ;',
            'comprendre les documents reçus, en langage simple ;',
            'repérer les programmes et les aides à demander ;',
            'partager les tâches et les rendez-vous avec votre famille.'
        ],
        pilot: 'Version pilote : les fonctions arrivent au fil des semaines.',
        notTitle: 'Ce que Relais n’est pas',
        notText:
            'Relais ne remplace pas un professionnel de la santé et ne donne aucun conseil médical. Ce n’est pas un service d’urgence : si quelqu’un est en danger, appelez le 911.',
        start: 'Commencer',
        continue: 'Continuer vers mon accueil',
        privacyLink: 'Comment Relais protège vos renseignements'
    },
    signIn: {
        title: 'Se connecter',
        emailLabel: 'Votre adresse courriel',
        emailHint: 'Nous vous enverrons un code à 6 chiffres. Aucun mot de passe à retenir.',
        accountNotice: 'Si vous n’avez pas encore de compte, il sera créé avec cette adresse.',
        privacyLink: 'Voir comment Relais protège vos renseignements',
        sendCode: 'Recevoir un code',
        sending: 'Envoi…',
        codeSentTo: (email: string) => `Nous avons envoyé un code à ${email}. Il est valide 10 minutes.`,
        codeLabel: 'Code à 6 chiffres',
        verify: 'Me connecter',
        verifying: 'Vérification…',
        changeEmail: 'Changer d’adresse',
        resend: 'Renvoyer le code',
        resendIn: (seconds: number) => `Vous pourrez demander un nouveau code dans ${seconds} s.`,
        invalidEmail: 'Entrez une adresse courriel complète, par exemple prenom@exemple.ca.',
        codeFormat: 'Le code compte 6 chiffres.',
        sendFailed: 'Le code n’a pas pu être envoyé. Vérifiez votre connexion et réessayez.',
        invalidCode: 'Ce code ne fonctionne pas. Vérifiez les 6 chiffres ou demandez un nouveau code.'
    },
    welcome: {
        title: 'Bienvenue dans Relais',
        intro: 'Avant de commencer, voici comment Relais utilise vos renseignements. Vous choisissez ce que vous acceptez, et vous pourrez changer d’avis à tout moment dans « Mes consentements ».',
        keyPoints: [
            'Vos renseignements restent au Canada et sont chiffrés.',
            'Seules les personnes que vous invitez voient le dossier de votre proche.',
            'Relais ne donne aucun conseil médical et n’est pas un service d’urgence.'
        ],
        renewal: 'La politique de confidentialité a changé. Lisez la nouvelle version et acceptez-la pour continuer.',
        consentsLegend: 'Vos consentements',
        submit: 'Enregistrer mes choix',
        saving: 'Enregistrement…',
        privacyRequired: 'Pour utiliser Relais, vous devez accepter la politique de confidentialité.',
        nameTitle: 'Comment voulez-vous qu’on vous appelle ?',
        nameLabel: 'Votre prénom',
        nameHint: 'C’est ce que verront les membres de votre famille.',
        nameSubmit: 'Continuer',
        nameError: 'Entrez un prénom (80 caractères au plus).'
    },
    consents: {
        required: 'Obligatoire',
        optional: 'Facultatif',
        readFull: 'Lire le texte complet',
        accept: 'J’accepte',
        acceptNamed: (title: string) => `J’accepte : ${title}`,
        title: 'Mes consentements',
        intro: 'Vous pouvez accorder ou retirer chaque consentement à tout moment. Le changement prend effet tout de suite.',
        grantedOn: (date: string) => `Accordé le ${date}`,
        revokedOn: (date: string) => `Retiré le ${date}`,
        notGranted: 'Non accordé',
        versionOf: (date: string) => `version du ${date}`,
        newVersion: 'Une nouvelle version de ce texte est disponible.',
        readAndAccept: 'Lire et accepter la nouvelle version',
        grant: 'Accorder ce consentement',
        revoke: 'Retirer ce consentement',
        confirmRevoke: (title: string) => `Retirer le consentement « ${title} » ?`,
        confirm: 'Confirmer le retrait',
        cancel: 'Annuler',
        privacyNotRevocable: 'Obligatoire pour utiliser Relais. Pour le retirer, supprimez votre compte dans « Mon compte ».',
        revokeEffect: {
            health_information:
                'Vous ne pourrez plus ajouter de renseignements de santé. Ceux déjà enregistrés restent visibles pour vous jusqu’à ce que vous les supprimiez.',
            email_reminders: 'Vous ne recevrez plus de rappels par courriel.',
            pilot_evaluation: 'Vos réponses ne seront plus utilisées pour évaluer le pilote.'
        } as Record<string, string>,
        granted: 'Consentement accordé.',
        revoked: 'Consentement retiré.'
    },
    home: {
        greeting: (name: string) => `Bonjour ${name}`,
        fileTitle: 'Le dossier de votre proche',
        fileSoon: 'Prochaine étape du pilote : créer le dossier de votre parent, inviter votre famille et ajouter ses contacts clés.',
        healthReminder:
            'Pour ajouter plus tard des renseignements de santé, il faudra accepter le consentement « Renseignements de santé ».',
        healthLink: 'Voir mes consentements',
        shortcuts: 'Raccourcis'
    },
    account: {
        title: 'Mon compte',
        nameTitle: 'Votre nom',
        nameSave: 'Enregistrer',
        nameSaved: 'Nom enregistré.',
        dataTitle: 'Vos renseignements',
        dataText: 'Téléchargez une copie de tous vos renseignements, dans un fichier structuré que d’autres logiciels peuvent lire (JSON).',
        dataDownload: 'Télécharger mes renseignements',
        dataPreparing: 'Préparation…',
        dataDone: 'Le fichier a été téléchargé.',
        signOutTitle: 'Se déconnecter',
        signOutText: 'Fermez votre session sur cet appareil, surtout s’il est partagé.',
        signOut: 'Me déconnecter',
        deleteTitle: 'Supprimer mon compte',
        deleteText:
            'La suppression efface votre compte et vos consentements. Elle est définitive. Le journal des accès garde seulement la trace de la suppression.',
        deleteConfirm: 'Je comprends que la suppression est définitive.',
        delete: 'Supprimer mon compte',
        deleting: 'Suppression…',
        deleted: 'Votre compte a été supprimé.'
    },
    mfa: {
        title: 'Vérification en deux étapes',
        intro: 'Votre rôle donne accès à des renseignements sensibles. La vérification en deux étapes est obligatoire.',
        enrollSteps: [
            'Ouvrez une application d’authentification sur votre téléphone.',
            'Balayez le code QR ci-dessous, ou entrez la clé à la main.',
            'Entrez le code à 6 chiffres affiché par l’application.'
        ],
        qrAlt: 'Code QR à balayer avec votre application d’authentification',
        secret: 'Clé à entrer à la main :',
        codeLabel: 'Code de l’application (6 chiffres)',
        verify: 'Vérifier',
        verifying: 'Vérification…',
        invalidCode: 'Ce code ne fonctionne pas. Attendez le code suivant dans l’application et réessayez.'
    },
    help: {
        title: 'Aide immédiate',
        lead: 'Relais n’est pas un service d’urgence. Si quelqu’un est en danger, appelez le 911 maintenant.',
        healthTitle: 'Une question de santé ?',
        healthText: 'Relais ne donne aucun conseil médical. Une infirmière ou un infirmier peut vous répondre en tout temps.',
        call: (phone: string) => `Appeler le ${phone}`,
        text: (phone: string) => `Texto au ${phone}`,
        hours: 'Heures :'
    },
    distress: {
        headingDanger: 'Si quelqu’un est en danger, appelez le 911 maintenant.',
        headingSuicide: 'Vous n’avez pas à traverser ça sans aide.',
        headingCrisis: 'Ce que vous vivez est lourd. Vous pouvez en parler maintenant.',
        body: 'Des personnes sont disponibles en tout temps, gratuitement et en toute confidentialité.',
        notEmergency: 'Relais n’est pas un service d’urgence. Votre texte n’a pas été effacé.',
        close: 'Revenir à ma saisie'
    },
    privacy: {
        title: 'Confidentialité'
    },
    notFound: {
        title: 'Page introuvable',
        text: 'Cette page n’existe pas ou a été déplacée.',
        back: 'Retour à l’accueil'
    }
};
