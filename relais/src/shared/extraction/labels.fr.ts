// Libellés des codes d'extraction, partagés par l'application et la fonction serveur (titres de repli).
import type { DocumentType, GuardFlag, Legibility, ReviewReason, TimelineEventType } from './schema.ts';

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
    discharge_summary: 'Résumé de départ de l’hôpital',
    prescription: 'Ordonnance',
    appointment_notice: 'Avis de rendez-vous',
    test_result: 'Résultat d’examen',
    clinic_letter: 'Lettre d’une clinique',
    assessment: 'Évaluation',
    administrative: 'Document administratif',
    other: 'Document'
};

export const TIMELINE_EVENT_LABELS: Record<TimelineEventType, string> = {
    hospitalization: 'Hospitalisation',
    discharge: 'Retour de l’hôpital',
    appointment: 'Rendez-vous',
    test: 'Examen',
    living_setting_change: 'Changement de milieu de vie',
    service_change: 'Changement de services',
    other: 'Autre'
};

export const LEGIBILITY_LABELS: Record<Legibility, string> = {
    clear: 'Texte lisible',
    partial: 'Texte lisible en partie',
    handwritten: 'Écriture à la main',
    blurry: 'Image floue'
};

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
    handwriting: 'Une partie est écrite à la main.',
    blurry: 'Une partie est floue ou difficile à lire.',
    partial_text: 'Le texte n’a pu être lu qu’en partie.',
    ambiguous_date: 'Une date est incertaine.',
    unclear_medication: 'Un médicament est difficile à lire.',
    not_in_source: 'Certains éléments n’ont pas été retrouvés tels quels dans le document.',
    summary_removed: 'Le résumé automatique a été retiré : il ne s’en tenait pas à ce qui est écrit.',
    other: 'Relisez le document au complet.'
};

export const GUARD_FLAG_LABELS: Record<GuardFlag, string> = {
    advice_language: 'Une formulation ressemblait à un conseil ou à une interprétation : elle a été retirée ou marquée.',
    invented_number: 'Un chiffre ne figurait pas dans le document : il a été retiré ou marqué.',
    not_in_source: 'Certains éléments ne figurent pas tels quels dans le document.',
    unknown_token: 'Un renseignement masqué n’a pas pu être rétabli.',
    truncated: 'Un texte trop long a été raccourci.'
};
