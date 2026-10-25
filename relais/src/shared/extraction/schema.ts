// Schémas de l'extraction de documents (version 1), partagés par la fonction serveur et l'application.
//
// 1. modelOutputSchema : ce que le modèle doit produire (sortie structurée). Aucun champ d'avis ni
//    d'interprétation : seulement ce qui est écrit. Pas de contrainte de longueur ici (la sortie
//    structurée les ignore) ; les garde-fous les appliquent ensuite.
// 2. draftSchema : le brouillon enregistré, après garde-fous et ré-identification locale.
// 3. confirmationSchema : ce que l'aidant a gardé ou corrigé, envoyé à confirm_document.
import { z } from 'zod';

export const EXTRACTION_SCHEMA_VERSION = '1';

export const DOCUMENT_TYPES = [
    'discharge_summary',
    'prescription',
    'appointment_notice',
    'test_result',
    'clinic_letter',
    'assessment',
    'administrative',
    'other'
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const TIMELINE_EVENT_TYPES = [
    'hospitalization',
    'discharge',
    'appointment',
    'test',
    'living_setting_change',
    'service_change',
    'other'
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const LEGIBILITY = ['clear', 'partial', 'handwritten', 'blurry'] as const;
export type Legibility = (typeof LEGIBILITY)[number];

/** Raisons d'une marque « à vérifier » : des codes, jamais du texte généré. */
export const MODEL_REVIEW_REASONS = ['handwriting', 'blurry', 'partial_text', 'ambiguous_date', 'unclear_medication', 'other'] as const;
export const REVIEW_REASONS = [...MODEL_REVIEW_REASONS, 'not_in_source', 'summary_removed'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Garde-fous déclenchés sur la sortie du modèle. */
export const GUARD_FLAGS = ['advice_language', 'invented_number', 'not_in_source', 'unknown_token', 'truncated'] as const;
export type GuardFlag = (typeof GUARD_FLAGS)[number];

const isoDate = z.string().describe('Date au format AAAA-MM-JJ, seulement si elle est écrite dans le document');
const sourceLine = z.string().describe('La ligne du document d’où vient l’élément, recopiée telle quelle');

export const modelOutputSchema = z.object({
    document_type: z.enum(DOCUMENT_TYPES),
    document_date: isoDate.nullable(),
    author: z.string().nullable().describe('Fonction et établissement de l’auteur, tels qu’écrits'),
    title: z.string().describe('Titre neutre et court, par exemple « Résumé de départ de l’hôpital »'),
    plain_summary: z
        .string()
        .describe('Résumé en français simple de ce qui est écrit, 600 caractères au plus, sans conseil ni interprétation'),
    medications_as_written: z.array(
        z.object({
            name: z.string(),
            dosage: z.string().nullable(),
            frequency: z.string().nullable(),
            source_line: sourceLine
        })
    ),
    appointments: z.array(
        z.object({
            date: isoDate.nullable(),
            time: z.string().nullable(),
            place: z.string().nullable(),
            purpose: z.string(),
            source_line: sourceLine
        })
    ),
    action_items: z.array(z.object({ text: z.string(), source_line: sourceLine })),
    timeline_events: z.array(
        z.object({
            date: isoDate.nullable(),
            event_type: z.enum(TIMELINE_EVENT_TYPES),
            title: z.string(),
            source_line: sourceLine
        })
    ),
    legibility: z.enum(LEGIBILITY),
    needs_review: z.boolean(),
    review_reasons: z.array(z.enum(MODEL_REVIEW_REASONS))
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

// ------------------------------------------------------------------------------------------ brouillon
export const LIMITS = {
    title: 160,
    author: 160,
    summary: 600,
    field: 160,
    item: 240,
    sourceLine: 300,
    description: 2000,
    items: 50
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const draftDate = z.string().regex(ISO_DATE).nullable();
const flag = { unverified: z.boolean() };

export const draftSchema = z.object({
    schema_version: z.literal(EXTRACTION_SCHEMA_VERSION),
    document_type: z.enum(DOCUMENT_TYPES),
    document_date: draftDate,
    author: z.string().max(LIMITS.author).nullable(),
    title: z.string().max(LIMITS.title),
    plain_summary: z
        .string()
        .max(LIMITS.summary + 1)
        .nullable(),
    medications: z
        .array(
            z.object({
                name: z.string().min(1).max(LIMITS.field),
                dosage: z.string().max(LIMITS.field).nullable(),
                frequency: z.string().max(LIMITS.field).nullable(),
                source_line: z.string().max(LIMITS.sourceLine),
                ...flag
            })
        )
        .max(LIMITS.items),
    appointments: z
        .array(
            z.object({
                date: draftDate,
                time: z.string().max(40).nullable(),
                place: z.string().max(LIMITS.item).nullable(),
                purpose: z.string().max(LIMITS.item),
                source_line: z.string().max(LIMITS.sourceLine),
                ...flag
            })
        )
        .max(LIMITS.items),
    action_items: z
        .array(z.object({ text: z.string().min(1).max(LIMITS.item), source_line: z.string().max(LIMITS.sourceLine), ...flag }))
        .max(LIMITS.items),
    timeline_events: z
        .array(
            z.object({
                date: draftDate,
                event_type: z.enum(TIMELINE_EVENT_TYPES),
                title: z.string().min(1).max(LIMITS.title),
                source_line: z.string().max(LIMITS.sourceLine),
                ...flag
            })
        )
        .max(LIMITS.items),
    legibility: z.enum(LEGIBILITY),
    needs_review: z.boolean(),
    review_reasons: z.array(z.enum(REVIEW_REASONS)),
    guard_flags: z.array(z.enum(GUARD_FLAGS))
});
export type ExtractionDraft = z.infer<typeof draftSchema>;

// -------------------------------------------------------------------------------------- confirmation
const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .nullable()
        .transform((v) => (v === '' ? null : v));
const requiredDate = z.string().regex(ISO_DATE);

export const confirmationSchema = z.object({
    document: z.object({
        title: optionalText(LIMITS.title),
        doc_type: z.enum(DOCUMENT_TYPES),
        doc_date: requiredDate.nullable(),
        author: optionalText(LIMITS.author),
        needs_review: z.boolean()
    }),
    summary: optionalText(1200),
    medications: z
        .array(
            z.object({
                name: trimmed(LIMITS.field).min(1),
                dosage: optionalText(LIMITS.field),
                frequency: optionalText(LIMITS.field)
            })
        )
        .max(LIMITS.items),
    timeline_events: z
        .array(
            z.object({
                event_type: z.enum(TIMELINE_EVENT_TYPES),
                occurred_on: requiredDate,
                title: trimmed(LIMITS.title).min(1),
                description: optionalText(LIMITS.description)
            })
        )
        .max(LIMITS.items),
    action_items: z.array(z.object({ text: trimmed(LIMITS.item).min(1) })).max(LIMITS.items)
});
export type Confirmation = z.infer<typeof confirmationSchema>;
export type ConfirmationInput = z.input<typeof confirmationSchema>;
