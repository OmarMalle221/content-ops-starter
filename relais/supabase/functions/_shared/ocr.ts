// Reconnaissance de texte (OCR) pour les photos et les PDF numérisés (question Q3).
// Recommandation : un service hébergé au Canada, appelé AVANT la pseudonymisation (on ne peut
// pseudonymiser qu'un texte). Tant qu'aucun service n'est configuré, ces documents ne sont pas lus
// automatiquement : l'aidant en note lui-même le contenu.

export interface OcrResult {
    text: string;
    /** Confiance moyenne, de 0 à 1. Sous le seuil, le brouillon est marqué « à vérifier ». */
    confidence: number;
}

export interface OcrClient {
    readonly provider: string;
    recognize(bytes: Uint8Array, mimeType: string): Promise<OcrResult>;
}

export const OCR_CONFIDENCE_THRESHOLD = 0.85;
