/**
 * CONFIGURATION DU CLIENT — le seul fichier à modifier pour dupliquer ce site.
 *
 * Tout ce qui est propre à l'exportateur vit ici : nom, couleurs, logo,
 * coordonnées, langues, services, destinations et textes de présentation.
 * Les textes génériques de l'interface (boutons, formulaires, statuts) sont
 * dans `src/i18n/*.json`.
 *
 * Ce fichier est aussi importé par les fonctions Netlify : il ne doit contenir
 * que des données (aucun import Astro, aucune variable d'environnement).
 */

/** Valeur à remplacer. Elle s'affiche telle quelle sur le site tant qu'elle n'est pas remplie. */
export const TODO = '[À COMPLÉTER]';

/** Texte traduit : une entrée par code de langue. La langue par défaut est obligatoire. */
export type Localized = Record<string, string>;
export type LocalizedList = Record<string, string[]>;

export interface LocaleDef {
  /** Code utilisé dans l'URL (`/fr/`) et nom du fichier `src/i18n/<code>.json`. */
  code: string;
  /** Nom affiché dans le sélecteur de langue. */
  label: string;
  /** Valeur de l'attribut `lang` et des balises `hreflang`. */
  htmlLang: string;
  /** Valeur de `og:locale`. */
  ogLocale: string;
}

export type ServiceIcon = 'car' | 'container' | 'boxes' | 'key' | 'document';

export interface Service {
  id: string;
  icon: ServiceIcon;
  title: Localized;
  summary: Localized;
  /** Ce qui est inclus dans le service, une ligne par élément. */
  included: LocalizedList;
}

export interface Destination {
  /** Identifiant stable, enregistré avec les demandes de devis. */
  slug: string;
  city: string;
  country: Localized;
  /** Port de transbordement pour les villes sans port (ex. Bamako via Dakar). */
  via?: string;
  /** Délai de transit indicatif. `null` = affiché « à confirmer ». */
  transit: Localized | null;
}

export interface TrustPoint {
  icon: 'tracking' | 'globe' | 'chat' | 'shield' | 'clock';
  /** Chiffre mis en avant (ex. « 10+ »). Laisser vide pour un argument sans chiffre. */
  value?: string;
  title: Localized;
  text: Localized;
}

export interface OpeningHours {
  /** Jours au format schema.org : Mo, Tu, We, Th, Fr, Sa, Su. */
  days: string[];
  opens: string;
  closes: string;
}

export const siteConfig = {
  // ── Identité ────────────────────────────────────────────────────────────
  name: 'Ole Oye Logistique',
  shortName: 'Ole Oye',
  /** Raison sociale affichée dans les mentions légales. */
  legalName: 'Ole Oye Logistique',
  /** Adresse publique du site, sans barre oblique finale. Sert au SEO et au sitemap. */
  url: 'https://www.oleoyelogistique.example',
  /** Préfixe des numéros de dossier proposés dans l'administration. */
  referencePrefix: 'OOL',

  // ── Langues ─────────────────────────────────────────────────────────────
  // Ajouter une langue : créer `src/i18n/<code>.json` puis ajouter une ligne ici.
  defaultLocale: 'fr',
  locales: [
    { code: 'fr', label: 'Français', htmlLang: 'fr-CA', ogLocale: 'fr_CA' },
    { code: 'en', label: 'English', htmlLang: 'en-CA', ogLocale: 'en_CA' },
  ] as LocaleDef[],

  // ── Marque ──────────────────────────────────────────────────────────────
  brand: {
    /** Fichier dans `/public`. Remplacer par le vrai logo du client. */
    logo: '/logo.svg',
    /** `true` si le fichier du logo contient déjà le nom : le nom n'est plus répété à côté. */
    logoIncludesName: false,
    /** Image d'aperçu (WhatsApp, Facebook), 1200 × 630 px, dans `/public`. */
    ogImage: '/og-image.png',
    colors: {
      /** Couleur principale : en-tête, titres, pied de page. */
      primary: '#0B2A4A',
      /** Variante foncée : dégradés et survol. */
      primaryDark: '#071C33',
      /** Teinte très claire de la couleur principale : fonds de cartes. */
      primarySoft: '#E8EEF5',
      /** Couleur d'accent : boutons d'appel à l'action. */
      accent: '#F2A413',
      /** Accent au survol. */
      accentDark: '#D98E04',
      /** Accent lisible sur fond blanc (contraste AA) : liens et petits textes. */
      accentText: '#8A5300',
      /** Fond des sections alternées. */
      surface: '#F6F3EC',
    },
  },

  // ── Coordonnées ─────────────────────────────────────────────────────────
  contact: {
    /** Format international, sans espace. */
    phone: '+15145852850',
    phoneDisplay: '+1 514 585-2850',
    /** Numéro WhatsApp : chiffres seulement, avec l'indicatif du pays. */
    whatsapp: '15145852850',
    email: TODO,
    address: {
      street: TODO,
      city: 'Montréal',
      region: 'QC',
      postalCode: TODO,
      country: 'CA',
    },
    /** Lien Google Maps vers l'entrepôt. Vide = recherche générée à partir de l'adresse. */
    mapsUrl: '',
    hours: {
      /** Texte affiché, une ligne par plage horaire. */
      display: { fr: [TODO], en: [TODO] } as LocalizedList,
      /** Plages horaires pour Google (données structurées). Vide = non publié. */
      spec: [] as OpeningHours[],
    },
  },

  // ── Activité ────────────────────────────────────────────────────────────
  origin: {
    city: 'Montréal',
    port: 'Port de Montréal',
  },
  /** Zone desservie, utilisée dans les titres. */
  region: { fr: "l'Afrique", en: 'Africa' } as Localized,
  /** `true` : le formulaire propose « Autre destination » en plus de la liste. */
  acceptsOtherDestinations: true,

  tagline: {
    fr: "Export de véhicules et de conteneurs de Montréal vers toute l'Afrique.",
    en: 'Vehicle and container shipping from Montréal to all of Africa.',
  } as Localized,

  /** Les trois arguments de confiance de la page d'accueil. */
  trust: [
    {
      icon: 'tracking',
      title: { fr: 'Suivi en ligne', en: 'Online tracking' },
      text: {
        fr: 'Suivez votre conteneur étape par étape, de notre entrepôt jusqu’au port d’arrivée.',
        en: 'Follow your container step by step, from our warehouse to the arrival port.',
      },
    },
    {
      icon: 'globe',
      title: { fr: "Toute l'Afrique", en: 'All of Africa' },
      text: {
        fr: 'Nous expédions vers tous les pays du continent, par les grands ports ou en transit terrestre.',
        en: 'We ship to every country on the continent, through major ports or onward by land.',
      },
    },
    {
      icon: 'chat',
      title: { fr: 'Une équipe joignable', en: 'A team you can reach' },
      text: {
        fr: 'Une question, une photo à envoyer, un devis à préciser : écrivez-nous sur WhatsApp.',
        en: 'A question, a photo to send, a quote to adjust: message us on WhatsApp.',
      },
    },
  ] as TrustPoint[],

  services: [
    {
      id: 'vehicules',
      icon: 'car',
      title: { fr: 'Export de véhicules', en: 'Vehicle export' },
      summary: {
        fr: 'Voitures, camionnettes et utilitaires, roulants ou non, expédiés en conteneur.',
        en: 'Cars, vans and utility vehicles, running or not, shipped by container.',
      },
      included: {
        fr: [
          'Réception du véhicule à notre entrepôt de Montréal',
          'Chargement et arrimage en conteneur',
          "Préparation des documents d'exportation",
          "Suivi en ligne jusqu'au port d'arrivée",
        ],
        en: [
          'Vehicle drop-off at our Montréal warehouse',
          'Loading and securing inside the container',
          'Preparation of export documents',
          'Online tracking to the arrival port',
        ],
      },
    },
    {
      id: 'conteneur-complet',
      icon: 'container',
      title: { fr: "Conteneur complet 20' et 40'", en: "Full container 20' and 40'" },
      summary: {
        fr: 'Un conteneur réservé à vos véhicules et à vos marchandises.',
        en: 'A container reserved for your vehicles and goods.',
      },
      included: {
        fr: [
          "Conteneur de 20 ou 40 pieds selon le volume",
          'Chargement à notre entrepôt',
          'Transport du conteneur jusqu’au port de départ',
          "Documents d'expédition et suivi en ligne",
        ],
        en: [
          '20 or 40 foot container depending on volume',
          'Loading at our warehouse',
          'Transport of the container to the departure port',
          'Shipping documents and online tracking',
        ],
      },
    },
    {
      id: 'groupage',
      icon: 'boxes',
      title: { fr: 'Groupage', en: 'Shared container' },
      summary: {
        fr: 'Vous payez seulement la place occupée : idéal pour les colis, les barils et les petits volumes.',
        en: 'You only pay for the space you use: ideal for parcels, barrels and small volumes.',
      },
      included: {
        fr: [
          'Dépôt de vos colis à notre entrepôt',
          'Regroupement dans un conteneur partagé',
          'Étiquetage et inventaire de vos colis',
          'Suivi en ligne du conteneur',
        ],
        en: [
          'Drop-off of your parcels at our warehouse',
          'Consolidation in a shared container',
          'Labelling and inventory of your parcels',
          'Online tracking of the container',
        ],
      },
    },
    {
      id: 'achat-vehicule',
      icon: 'key',
      title: { fr: 'Achat de véhicule pour vous', en: 'Vehicle purchase on your behalf' },
      summary: {
        fr: 'Vous êtes à distance ? Nous trouvons et achetons le véhicule au Canada, puis nous l’expédions.',
        en: 'Not in Canada? We find and buy the vehicle here, then ship it to you.',
      },
      included: {
        fr: [
          'Recherche du véhicule selon vos critères et votre budget',
          'Photos et vérification avant achat',
          "Achat et transport jusqu'à notre entrepôt",
          'Expédition vers la destination de votre choix',
        ],
        en: [
          'Vehicle search based on your criteria and budget',
          'Photos and inspection before purchase',
          'Purchase and transport to our warehouse',
          'Shipping to the destination of your choice',
        ],
      },
    },
    {
      id: 'dedouanement',
      icon: 'document',
      title: { fr: "Dédouanement à l'arrivée", en: 'Customs clearance on arrival' },
      summary: {
        fr: 'Un accompagnement pour sortir votre véhicule ou vos marchandises du port de destination.',
        en: 'Support to get your vehicle or goods released at the destination port.',
      },
      included: {
        fr: [
          'Mise en relation avec un transitaire sur place',
          'Liste des documents à fournir',
          'Estimation des frais avant le départ',
          "Assistance jusqu'à la sortie du port",
        ],
        en: [
          'Introduction to a local customs broker',
          'List of the documents to provide',
          'Cost estimate before departure',
          'Assistance until release from the port',
        ],
      },
    },
  ] as Service[],

  /**
   * Destinations mises en avant. `transit: null` affiche « à confirmer » :
   * remplacer par ex. `{ fr: '25 à 35 jours', en: '25 to 35 days' }`.
   */
  destinations: [
    { slug: 'dakar', city: 'Dakar', country: { fr: 'Sénégal', en: 'Senegal' }, transit: null },
    { slug: 'abidjan', city: 'Abidjan', country: { fr: "Côte d'Ivoire", en: "Côte d'Ivoire" }, transit: null },
    { slug: 'conakry', city: 'Conakry', country: { fr: 'Guinée', en: 'Guinea' }, transit: null },
    { slug: 'bamako', city: 'Bamako', country: { fr: 'Mali', en: 'Mali' }, via: 'Dakar', transit: null },
    { slug: 'lome', city: 'Lomé', country: { fr: 'Togo', en: 'Togo' }, transit: null },
    { slug: 'cotonou', city: 'Cotonou', country: { fr: 'Bénin', en: 'Benin' }, transit: null },
    { slug: 'lagos', city: 'Lagos', country: { fr: 'Nigéria', en: 'Nigeria' }, transit: null },
    { slug: 'tema', city: 'Tema', country: { fr: 'Ghana', en: 'Ghana' }, transit: null },
    { slug: 'douala', city: 'Douala', country: { fr: 'Cameroun', en: 'Cameroon' }, transit: null },
    { slug: 'pointe-noire', city: 'Pointe-Noire', country: { fr: 'Congo', en: 'Congo' }, transit: null },
    { slug: 'matadi', city: 'Matadi', country: { fr: 'RD Congo', en: 'DR Congo' }, transit: null },
    { slug: 'mombasa', city: 'Mombasa', country: { fr: 'Kenya', en: 'Kenya' }, transit: null },
    { slug: 'casablanca', city: 'Casablanca', country: { fr: 'Maroc', en: 'Morocco' }, transit: null },
  ] as Destination[],

  // ── Vie privée (Loi 25 du Québec) ───────────────────────────────────────
  privacy: {
    /** Personne responsable de la protection des renseignements personnels. */
    officerName: TODO,
    /** Courriel pour les demandes d'accès, de rectification ou de retrait. */
    officerEmail: TODO,
    /** Date de la politique. Enregistrée avec chaque consentement : la changer à chaque révision. */
    policyVersion: '2026-11-24',
    /** Durée de conservation des demandes de devis, en mois. */
    retentionMonths: 24,
  },
};

export type SiteConfig = typeof siteConfig;

/** `true` si la valeur n'a pas encore été remplie par le client. */
export function isTodo(value: string | undefined | null): boolean {
  return !value || value.includes(TODO);
}

/** Renvoie le texte dans la langue demandée, sinon dans la langue par défaut. */
export function pick<T>(value: Record<string, T>, lang: string): T {
  return value[lang] ?? value[siteConfig.defaultLocale] ?? Object.values(value)[0];
}

export const localeCodes: string[] = siteConfig.locales.map((l) => l.code);

export function destinationBySlug(slug: string): Destination | undefined {
  return siteConfig.destinations.find((d) => d.slug === slug);
}
