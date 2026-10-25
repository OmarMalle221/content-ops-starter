import consentTexts from '../content/consent-texts.fr.json';

/** Consentements de portée utilisateur, dans l'ordre d'affichage. */
export const USER_CONSENT_TYPES = ['privacy_policy', 'health_information', 'email_reminders', 'pilot_evaluation'] as const;
export type UserConsentType = (typeof USER_CONSENT_TYPES)[number];

export interface ConsentTextSection {
    heading: string;
    text: string;
}

export interface ConsentText {
    type: UserConsentType;
    version: string;
    required: boolean;
    title: string;
    summary: string;
    sections: ConsentTextSection[];
}

export function consentText(type: UserConsentType): ConsentText {
    const text = consentTexts[type];
    return {
        type,
        version: text.version,
        required: text.required,
        title: text.title,
        summary: text.summary,
        sections: text.sections
    };
}

export const CONSENT_TEXTS: ConsentText[] = USER_CONSENT_TYPES.map(consentText);

export interface ConsentRecord {
    id: string;
    consent_type: string;
    text_version: string;
    granted_at: string;
    revoked_at: string | null;
}

/** Consentement actif (non retiré) d'un type donné, toutes versions confondues. */
export function activeConsent(records: ConsentRecord[], type: UserConsentType): ConsentRecord | undefined {
    return records.find((r) => r.consent_type === type && r.revoked_at === null);
}

/** Vrai si l'utilisateur a accepté la version en vigueur de la politique de confidentialité. */
export function hasCurrentPrivacyConsent(records: ConsentRecord[]): boolean {
    return activeConsent(records, 'privacy_policy')?.text_version === consentText('privacy_policy').version;
}
