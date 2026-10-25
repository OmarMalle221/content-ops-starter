// Documents FICTIFS pour les tests : noms, NAM, adresses et téléphones inventés.

/** Dictionnaire du dossier fictif (comme le renvoie start_document_extraction). */
export const FICTIONAL_DICTIONARY = {
    persons: ['Roger', 'Gagnon', 'Louise', 'Marc', 'Dre Isabelle Fortin'],
    addresses: ['1200, rue Sherbrooke Est, Montréal']
};

/** Valeurs qui ne doivent JAMAIS être envoyées au fournisseur d'IA. */
export const FICTIONAL_IDENTIFIERS = [
    'Roger',
    'Gagnon',
    'Isabelle',
    'Fortin',
    'Lucie',
    'Bergeron',
    'Marc',
    'GAGR 4503 1512',
    '1200, rue Sherbrooke',
    'H2L 1M9',
    '514 555-0142',
    '450-555-0199',
    'r.gagnon@example.com',
    '12 mars 1944',
    '7788123',
    '046 454 286'
];

/** Résumé de départ de l'hôpital, 3 pages. */
export const DISCHARGE_SUMMARY_PAGES: string[][] = [
    [
        'Hôpital Notre-Dame — Service de gériatrie',
        'RÉSUMÉ DE DÉPART',
        'Patient : GAGNON, Roger',
        'NAM : GAGR 4503 1512    No dossier : 7788123',
        'Né le 12 mars 1944',
        'Adresse : 1200, rue Sherbrooke Est, Montréal (Québec) H2L 1M9',
        'Téléphone : 514 555-0142',
        'Courriel : r.gagnon@example.com',
        'Date d’admission : 26 septembre 2026',
        'Date de départ : 3 octobre 2026',
        'Médecin traitant : Dre Isabelle Fortin, gériatre'
    ],
    [
        'Motif de l’hospitalisation : chute à domicile.',
        'Retour à la résidence le 3 octobre 2026.',
        'Médicaments au départ :',
        '- Metformine 500 mg 2 fois par jour',
        '- Ramipril 5 mg 1 fois par jour',
        '- Atorvastatine 20 mg au coucher',
        'Infirmière de liaison : Mme Lucie Bergeron, 450-555-0199',
        'Le fils, M. Marc Gagnon, a été avisé.'
    ],
    [
        'Suivi :',
        'Rendez-vous en gériatrie le 12 novembre 2026 à 10 h 30, clinique externe.',
        'À faire : prise de sang au CLSC dans deux semaines.',
        'NAS au dossier administratif : 046 454 286',
        'Signature : Dre Isabelle Fortin'
    ]
];

export const PRESCRIPTION_PAGES: string[][] = [
    [
        'Clinique médicale du Plateau',
        'ORDONNANCE',
        'Patient : Roger Gagnon',
        'Date : 10 octobre 2026',
        '- Metformine 500 mg BID',
        'Dre Isabelle Fortin'
    ]
];
