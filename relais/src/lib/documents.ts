// Documents, extractions, chronologie et médicaments tels qu'écrits (étape 3).
// Lectures par l'API (RLS) ; écritures par fonctions SQL ou fonctions serveur. Les fichiers ne se lisent
// jamais directement : get-document-url vérifie l'accès, journalise et renvoie une URL de 60 s.
import { z } from 'zod';
import {
    confirmationSchema,
    DOCUMENT_TYPES,
    draftSchema,
    GUARD_FLAGS,
    REVIEW_REASONS,
    TIMELINE_EVENT_TYPES,
    type ConfirmationInput,
    type ExtractionDraft
} from '../shared/extraction/schema';
import { ApiError } from './api';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

export const DOCUMENT_STATUSES = ['pending_upload', 'uploaded', 'processing', 'draft_ready', 'confirmed', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const EXTRACTION_ERRORS = [
    'ai_consent_missing',
    'no_text_layer',
    'photo_without_ocr',
    'too_long',
    'unreadable_pdf',
    'refusal',
    'invalid_output',
    'ai_unavailable'
] as const;
export type ExtractionError = (typeof EXTRACTION_ERRORS)[number];

export const ACCEPTED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const DocumentSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    mime_type: z.enum(ACCEPTED_MIME_TYPES),
    size_bytes: z.number(),
    page_count: z.number().nullable(),
    status: z.enum(DOCUMENT_STATUSES),
    extraction_error: z.enum(EXTRACTION_ERRORS).nullable(),
    title: z.string().nullable(),
    doc_type: z.enum(DOCUMENT_TYPES).nullable(),
    doc_date: z.string().nullable(),
    author: z.string().nullable(),
    needs_review: z.boolean(),
    uploaded_by: z.uuid().nullable(),
    uploaded_at: z.string()
});
export type CareDocument = z.infer<typeof DocumentSchema>;
const DOCUMENT_COLUMNS =
    'id, care_file_id, mime_type, size_bytes, page_count, status, extraction_error, title, doc_type, doc_date, author, needs_review, uploaded_by, uploaded_at';

const ConfirmedDataSchema = confirmationSchema;
export type ConfirmedData = z.infer<typeof ConfirmedDataSchema>;

const ExtractionRowSchema = z.object({
    id: z.uuid(),
    document_id: z.uuid(),
    status: z.enum(['draft', 'confirmed']),
    method: z.enum(['ai', 'manual']),
    draft: z.unknown(),
    review_reasons: z.array(z.enum(REVIEW_REASONS)),
    guard_flags: z.array(z.enum(GUARD_FLAGS)),
    confirmed_data: z.unknown().nullable(),
    confirmed_at: z.string().nullable(),
    created_at: z.string()
});

export interface Extraction {
    id: string;
    documentId: string;
    status: 'draft' | 'confirmed';
    method: 'ai' | 'manual';
    /** Brouillon de la lecture automatique (null pour une saisie à la main). */
    draft: ExtractionDraft | null;
    confirmed: ConfirmedData | null;
    confirmedAt: string | null;
}

const MedicationSchema = z.object({
    id: z.uuid(),
    source_document_id: z.uuid(),
    name_as_written: z.string(),
    dosage_as_written: z.string().nullable(),
    frequency_as_written: z.string().nullable(),
    document_date: z.string().nullable(),
    created_at: z.string()
});
export type MedicationMention = z.infer<typeof MedicationSchema>;

const TimelineEventSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    event_type: z.enum(TIMELINE_EVENT_TYPES),
    occurred_on: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    source_type: z.enum(['document', 'manual']),
    source_document_id: z.uuid().nullable(),
    created_by: z.uuid().nullable(),
    created_at: z.string()
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type TimelineEventInput = Pick<TimelineEvent, 'event_type' | 'occurred_on' | 'title' | 'description'>;

// ------------------------------------------------------------------------------------------ lectures
export async function listDocuments(fileId: string): Promise<CareDocument[]> {
    const { data, error } = await supabase()
        .from('documents')
        .select(DOCUMENT_COLUMNS)
        .eq('care_file_id', fileId)
        .order('uploaded_at', { ascending: false });
    if (error) fail('list_documents', error);
    return z.array(DocumentSchema).parse(data);
}

export async function getDocument(documentId: string): Promise<CareDocument | null> {
    const { data, error } = await supabase().from('documents').select(DOCUMENT_COLUMNS).eq('id', documentId).maybeSingle();
    if (error) fail('get_document', error);
    return data ? DocumentSchema.parse(data) : null;
}

/** Brouillon en cours ou extraction confirmée d'un document. */
export async function getCurrentExtraction(documentId: string): Promise<Extraction | null> {
    const { data, error } = await supabase()
        .from('document_extractions')
        .select('id, document_id, status, method, draft, review_reasons, guard_flags, confirmed_data, confirmed_at, created_at')
        .eq('document_id', documentId)
        .maybeSingle();
    if (error) fail('get_extraction', error);
    if (!data) return null;
    const row = ExtractionRowSchema.parse(data);
    const draft = row.method === 'ai' ? draftSchema.safeParse(row.draft) : null;
    const confirmed = row.confirmed_data ? ConfirmedDataSchema.safeParse(row.confirmed_data) : null;
    return {
        id: row.id,
        documentId: row.document_id,
        status: row.status,
        method: row.method,
        draft: draft?.success ? draft.data : null,
        confirmed: confirmed?.success ? confirmed.data : null,
        confirmedAt: row.confirmed_at
    };
}

export async function listMedications(fileId: string): Promise<MedicationMention[]> {
    const { data, error } = await supabase()
        .from('medication_mentions')
        .select('id, source_document_id, name_as_written, dosage_as_written, frequency_as_written, document_date, created_at')
        .eq('care_file_id', fileId)
        .order('document_date', { ascending: false, nullsFirst: false });
    if (error) fail('list_medications', error);
    return z.array(MedicationSchema).parse(data);
}

export async function listTimeline(fileId: string): Promise<TimelineEvent[]> {
    const { data, error } = await supabase()
        .from('timeline_events')
        .select('id, care_file_id, event_type, occurred_on, title, description, source_type, source_document_id, created_by, created_at')
        .eq('care_file_id', fileId)
        .order('occurred_on', { ascending: false });
    if (error) fail('list_timeline', error);
    return z.array(TimelineEventSchema).parse(data);
}

// ------------------------------------------------------------------------------------- téléversement
/** Enregistre le document, dépose le fichier à son chemin imposé, puis confirme la réception. */
export async function uploadDocument(fileId: string, body: Blob, mimeType: (typeof ACCEPTED_MIME_TYPES)[number]): Promise<string> {
    const client = supabase();
    const { data: id, error } = await client.rpc('register_document', {
        p_care_file_id: fileId,
        p_mime_type: mimeType,
        p_size_bytes: body.size
    });
    if (error) fail('register_document', error);
    const documentId = z.uuid().parse(id);
    const { error: uploadError } = await client.storage
        .from('documents')
        .upload(`${fileId}/${documentId}`, await body.arrayBuffer(), { contentType: mimeType, upsert: false });
    if (uploadError) fail('upload_document', uploadError);
    const { error: completeError } = await client.rpc('complete_document_upload', { p_document_id: documentId });
    if (completeError) fail('complete_document_upload', completeError);
    return documentId;
}

// --------------------------------------------------------------------------------- fonctions serveur
async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase().functions.invoke(name, { body });
    if (error) {
        let code: string | undefined;
        const response = (error as { context?: unknown }).context;
        if (response instanceof Response) {
            code = await response
                .json()
                .then((json: { error?: unknown }) => (typeof json.error === 'string' ? json.error : undefined))
                .catch(() => undefined);
        }
        fail(name, { name: 'FunctionError', code });
    }
    return data as T;
}

export type ExtractionOutcome = { status: 'draft_ready' } | { status: 'failed'; code: ExtractionError };

/** Lecture automatique ; l'erreur « ai_consent_missing » arrive comme ApiError. */
export async function extractDocument(documentId: string): Promise<ExtractionOutcome> {
    const result = await invoke<{ status: string; code?: string }>('extract-document', { document_id: documentId });
    if (result.status === 'draft_ready') return { status: 'draft_ready' };
    const code = z.enum(EXTRACTION_ERRORS).safeParse(result.code);
    return { status: 'failed', code: code.success ? code.data : 'ai_unavailable' };
}

/** URL signée, valide 60 secondes ; la consultation est journalisée. */
export async function documentUrl(documentId: string): Promise<string> {
    const result = await invoke<{ url: string }>('get-document-url', { document_id: documentId });
    return z.url().parse(result.url);
}

export async function deleteDocument(documentId: string): Promise<void> {
    await invoke('delete-document', { document_id: documentId });
}

// ------------------------------------------------------------------------------------- confirmation
export async function confirmDocument(documentId: string, extractionId: string | null, confirmation: ConfirmationInput): Promise<void> {
    const payload = confirmationSchema.parse(confirmation);
    const { error } = await supabase().rpc('confirm_document', {
        p_document_id: documentId,
        p_extraction_id: extractionId,
        p_confirmed: payload
    });
    if (error) fail('confirm_document', error);
}

export async function discardExtraction(extractionId: string): Promise<void> {
    const { error } = await supabase().rpc('discard_extraction', { p_extraction_id: extractionId });
    if (error) fail('discard_extraction', error);
}

export async function logExtractionViewed(fileId: string, documentId: string): Promise<void> {
    const { error } = await supabase().rpc('log_access', {
        p_care_file_id: fileId,
        p_action: 'extraction_viewed',
        p_target_type: 'documents',
        p_target_id: documentId
    });
    if (error) fail('log_access', error);
}

// ------------------------------------------------------------------------------------- chronologie
export async function createTimelineEvent(fileId: string, input: TimelineEventInput): Promise<void> {
    const { error } = await supabase()
        .from('timeline_events')
        .insert({ care_file_id: fileId, ...input, title: input.title.trim(), description: input.description?.trim() || null });
    if (error) fail('create_timeline_event', error);
}

export async function deleteTimelineEvent(eventId: string): Promise<void> {
    const { error } = await supabase().from('timeline_events').delete().eq('id', eventId);
    if (error) fail('delete_timeline_event', error);
}

export async function deleteMedication(id: string): Promise<void> {
    const { error } = await supabase().from('medication_mentions').delete().eq('id', id);
    if (error) fail('delete_medication', error);
}
