// Étape 6 : bilan de la semaine (privé), demandes d'intervenante, évaluation du pilote, mesures agrégées.
// La base décide des droits (bilan : son auteur seulement ; tableau : intervenantes avec MFA ; mesures :
// admin avec MFA, en agrégats).
import { z } from 'zod';
import type { CheckinAnswers } from '../shared/checkin/score';
import { ApiError } from './api';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

// -------------------------------------------------------------------------------- bilan de la semaine
const CheckinSchema = z.object({
    id: z.uuid(),
    week_start: z.string(),
    fatigue: z.number(),
    overwhelm: z.number(),
    isolation: z.number()
});
export type Checkin = z.infer<typeof CheckinSchema>;

export async function listMyCheckins(): Promise<Checkin[]> {
    const { data, error } = await supabase()
        .from('caregiver_checkins')
        .select('id, week_start, fatigue, overwhelm, isolation')
        .order('week_start', { ascending: false })
        .limit(12);
    if (error) fail('list_checkins', error);
    return z.array(CheckinSchema).parse(data);
}

/** Garde le bilan de la semaine (une réponse par semaine : la nouvelle remplace l'ancienne). */
export async function saveCheckin(weekStart: string, answers: CheckinAnswers, existingId: string | null): Promise<void> {
    const client = supabase();
    const { error } = existingId
        ? await client.from('caregiver_checkins').update(answers).eq('id', existingId)
        : await client.from('caregiver_checkins').insert({ week_start: weekStart, ...answers });
    if (error) fail('save_checkin', error);
}

// ------------------------------------------------------------------------------ demandes d'intervenante
export const SUPPORT_ORIGINS = ['button', 'distress_screen', 'checkin'] as const;
export type SupportOrigin = (typeof SUPPORT_ORIGINS)[number];
export const SUPPORT_STATUSES = ['new', 'assigned', 'closed'] as const;

const SupportRequestSchema = z.object({
    id: z.uuid(),
    requester_id: z.uuid(),
    care_file_id: z.uuid().nullable(),
    origin: z.enum(SUPPORT_ORIGINS),
    contact_name: z.string(),
    preferred_contact: z.enum(['phone', 'email']),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    preferred_times: z.string().nullable(),
    message: z.string().nullable(),
    status: z.enum(SUPPORT_STATUSES),
    assigned_worker_id: z.uuid().nullable(),
    assigned_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    created_at: z.string()
});
export type SupportRequest = z.infer<typeof SupportRequestSchema>;
const SUPPORT_COLUMNS =
    'id, requester_id, care_file_id, origin, contact_name, preferred_contact, phone, email, preferred_times, message, status, assigned_worker_id, assigned_at, closed_at, created_at';

export interface SupportRequestInput {
    origin: SupportOrigin;
    contact_name: string;
    preferred_contact: 'phone' | 'email';
    phone: string | null;
    preferred_times: string | null;
    message: string | null;
    care_file_id: string | null;
}

/** Crée la demande, puis avise les intervenantes (courriel sans contenu). L'avis peut échouer sans perte. */
export async function createSupportRequest(input: SupportRequestInput): Promise<string> {
    const client = supabase();
    const { data, error } = await client
        .from('support_requests')
        .insert({
            ...input,
            contact_name: input.contact_name.trim(),
            phone: input.preferred_contact === 'phone' ? input.phone?.trim() || null : null,
            preferred_times: input.preferred_times?.trim() || null,
            message: input.message?.trim() || null
        })
        .select('id')
        .single();
    if (error) fail('create_support_request', error);
    const id = z.object({ id: z.uuid() }).parse(data).id;
    const notified = await client.functions.invoke('notify-support', { body: { request_id: id } });
    if (notified.error) logEvent('api_error', { route: 'notify-support', errorName: 'FunctionError' });
    return id;
}

export async function listMySupportRequests(userId: string): Promise<SupportRequest[]> {
    const { data, error } = await supabase()
        .from('support_requests')
        .select(SUPPORT_COLUMNS)
        .eq('requester_id', userId)
        .order('created_at', { ascending: false });
    if (error) fail('list_my_support_requests', error);
    return z.array(SupportRequestSchema).parse(data);
}

export async function cancelSupportRequest(id: string): Promise<void> {
    const { error } = await supabase().rpc('cancel_support_request', { p_request_id: id });
    if (error) fail('cancel_support_request', error);
}

// ------------------------------------------------------------------------- tableau des intervenantes
export async function listSupportRequests(): Promise<SupportRequest[]> {
    const { data, error } = await supabase().from('support_requests').select(SUPPORT_COLUMNS).order('created_at', { ascending: false });
    if (error) fail('list_support_requests', error);
    return z.array(SupportRequestSchema).parse(data);
}

/** Prendre en charge (pour soi-même), fermer ou rouvrir une demande. */
export async function setSupportStatus(id: string, status: 'assigned' | 'closed'): Promise<void> {
    const { error } = await supabase().from('support_requests').update({ status }).eq('id', id);
    if (error) fail('update_support_request', error);
}

const SupportNoteSchema = z.object({ id: z.uuid(), author_id: z.uuid().nullable(), body: z.string(), created_at: z.string() });
export type SupportNote = z.infer<typeof SupportNoteSchema>;

export async function listSupportNotes(requestId: string): Promise<SupportNote[]> {
    const { data, error } = await supabase()
        .from('support_request_notes')
        .select('id, author_id, body, created_at')
        .eq('support_request_id', requestId)
        .order('created_at', { ascending: true });
    if (error) fail('list_support_notes', error);
    return z.array(SupportNoteSchema).parse(data);
}

export async function addSupportNote(requestId: string, body: string): Promise<void> {
    const { error } = await supabase().from('support_request_notes').insert({ support_request_id: requestId, body: body.trim() });
    if (error) fail('add_support_note', error);
}

// ---------------------------------------------------------------------------------- évaluation du pilote
const FeedbackSchema = z.object({
    id: z.uuid(),
    week_start: z.string(),
    hours_saved: z.coerce.number().nullable(),
    satisfaction: z.number().nullable()
});
export type PilotFeedback = z.infer<typeof FeedbackSchema>;

export async function listMyFeedback(): Promise<PilotFeedback[]> {
    const { data, error } = await supabase()
        .from('pilot_feedback')
        .select('id, week_start, hours_saved, satisfaction')
        .order('week_start', { ascending: false })
        .limit(12);
    if (error) fail('list_feedback', error);
    return z.array(FeedbackSchema).parse(data);
}

export async function saveFeedback(
    weekStart: string,
    answers: { hours_saved: number | null; satisfaction: number | null },
    existingId: string | null
): Promise<void> {
    const client = supabase();
    const { error } = existingId
        ? await client.from('pilot_feedback').update(answers).eq('id', existingId)
        : await client.from('pilot_feedback').insert({ week_start: weekStart, ...answers });
    if (error) fail('save_feedback', error);
}

const average = z.coerce.number().nullable().optional();
const PilotMetricsSchema = z.object({
    generated_at: z.string(),
    minimum_respondents: z.number(),
    participation: z.object({ care_files: z.number(), members: z.number(), pilot_consents: z.number() }),
    feedback: z.object({
        respondents: z.number(),
        responses: z.number().optional(),
        suppressed: z.boolean(),
        hours_saved_avg: average,
        satisfaction_avg: average,
        satisfaction: z.record(z.string(), z.number()).optional()
    }),
    feedback_by_week: z.array(
        z.object({
            week_start: z.string(),
            respondents: z.number(),
            suppressed: z.boolean(),
            hours_saved_avg: average,
            satisfaction_avg: average
        })
    ),
    programs: z.object({
        files: z.number(),
        identified: z.number(),
        requested: z.number(),
        obtained: z.number(),
        refused: z.number(),
        median_days_to_request: average
    }),
    support: z.object({
        total: z.number(),
        new: z.number(),
        assigned: z.number(),
        closed: z.number(),
        from_button: z.number(),
        from_distress_screen: z.number(),
        from_checkin: z.number(),
        median_hours_to_assignment: average
    })
});
export type PilotMetrics = z.infer<typeof PilotMetricsSchema>;

export async function getPilotMetrics(): Promise<PilotMetrics> {
    const { data, error } = await supabase().rpc('pilot_metrics');
    if (error) fail('pilot_metrics', error);
    return PilotMetricsSchema.parse(data);
}
