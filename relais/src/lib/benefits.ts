// Navigateur de droits (étape 4) : catalogue, évaluations, programmes du dossier, pièces à fournir,
// explications et lettres (fonctions serveur), administration des fiches et des ressources.
import { z } from 'zod';
import { explanationOutputSchema, type ExplanationOutput, type LetterKind } from '../shared/benefits/ai';
import { answersSchema, criteriaSchema, type Assessment, type BenefitAnswers } from '../shared/benefits/engine';
import { ApiError, ResourceCategorySchema } from './api';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

export const PROGRAM_STATUSES = ['to_explore', 'in_progress', 'obtained', 'refused'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

const ProgramSchema = z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    organization: z.string(),
    summary: z.string(),
    criteria: criteriaSchema,
    required_documents: z.array(z.string()),
    how_to_apply: z.string().nullable(),
    official_url: z.string().nullable(),
    source_label: z.string(),
    verification_status: z.enum(['to_verify', 'verified']),
    verified_on: z.string().nullable(),
    verified_by: z.string().nullable(),
    version: z.number(),
    sort_order: z.number(),
    is_active: z.boolean()
});
export type Program = z.infer<typeof ProgramSchema>;
const PROGRAM_COLUMNS =
    'id, slug, name, organization, summary, criteria, required_documents, how_to_apply, official_url, source_label, verification_status, verified_on, verified_by, version, sort_order, is_active';

const ChecklistItemSchema = z.object({
    id: z.uuid(),
    care_file_program_id: z.uuid(),
    label: z.string(),
    origin: z.enum(['program', 'custom']),
    is_done: z.boolean(),
    done_at: z.string().nullable(),
    position: z.number()
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

const FileProgramSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    program_id: z.uuid(),
    match_level: z.enum(['likely', 'possible', 'unlikely']),
    status: z.enum(PROGRAM_STATUSES),
    notes: z.string().nullable(),
    letter_draft: z.string().nullable(),
    identified_at: z.string(),
    requested_at: z.string().nullable(),
    decided_at: z.string().nullable()
});
export type FileProgram = z.infer<typeof FileProgramSchema> & { checklist: ChecklistItem[] };

// ------------------------------------------------------------------------------------------ catalogue
export async function listPrograms(): Promise<Program[]> {
    const { data, error } = await supabase().from('programs').select(PROGRAM_COLUMNS).order('sort_order', { ascending: true });
    if (error) fail('list_programs', error);
    return z.array(ProgramSchema).parse(data);
}

// ------------------------------------------------------------------------------------------- dossier
export async function getLatestAnswers(fileId: string): Promise<{ answers: BenefitAnswers; created_at: string } | null> {
    const { data, error } = await supabase()
        .from('benefit_assessments')
        .select('answers, created_at')
        .eq('care_file_id', fileId)
        .order('created_at', { ascending: false })
        .limit(1);
    if (error) fail('get_assessment', error);
    const row = z.array(z.object({ answers: z.unknown(), created_at: z.string() })).parse(data)[0];
    if (!row) return null;
    const answers = answersSchema.safeParse(row.answers);
    return answers.success ? { answers: answers.data, created_at: row.created_at } : null;
}

export async function listFilePrograms(fileId: string): Promise<FileProgram[]> {
    const client = supabase();
    const { data, error } = await client
        .from('care_file_programs')
        .select('id, care_file_id, program_id, match_level, status, notes, letter_draft, identified_at, requested_at, decided_at')
        .eq('care_file_id', fileId);
    if (error) fail('list_file_programs', error);
    const programs = z.array(FileProgramSchema).parse(data);
    const { data: items, error: itemsError } = await client
        .from('program_checklist_items')
        .select('id, care_file_program_id, label, origin, is_done, done_at, position')
        .eq('care_file_id', fileId)
        .order('position', { ascending: true });
    if (itemsError) fail('list_checklist', itemsError);
    const checklist = z.array(ChecklistItemSchema).parse(items);
    return programs.map((p) => ({ ...p, checklist: checklist.filter((i) => i.care_file_program_id === p.id) }));
}

export async function saveAssessment(
    fileId: string,
    answers: BenefitAnswers,
    results: Array<{ programId: string; assessment: Assessment }>
): Promise<void> {
    const { error } = await supabase().rpc('save_benefit_assessment', {
        p_care_file_id: fileId,
        p_answers: answersSchema.parse(answers),
        p_results: results.map((r) => ({ program_id: r.programId, match_level: r.assessment.level, match_reasons: r.assessment.reasons }))
    });
    if (error) fail('save_benefit_assessment', error);
}

export async function updateFileProgram(id: string, patch: Partial<Pick<FileProgram, 'status' | 'notes' | 'letter_draft'>>): Promise<void> {
    const { error } = await supabase().from('care_file_programs').update(patch).eq('id', id);
    if (error) fail('update_file_program', error);
}

export async function setChecklistItemDone(id: string, isDone: boolean): Promise<void> {
    const { error } = await supabase().from('program_checklist_items').update({ is_done: isDone }).eq('id', id);
    if (error) fail('update_checklist_item', error);
}

export async function addChecklistItem(fileId: string, fileProgramId: string, label: string, position: number): Promise<void> {
    const { error } = await supabase()
        .from('program_checklist_items')
        .insert({ care_file_id: fileId, care_file_program_id: fileProgramId, label: label.trim(), position });
    if (error) fail('add_checklist_item', error);
}

export async function deleteChecklistItem(id: string): Promise<void> {
    const { error } = await supabase().from('program_checklist_items').delete().eq('id', id);
    if (error) fail('delete_checklist_item', error);
}

// ------------------------------------------------------------------------- explication et lettre (IA)
async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
    const { data, error } = await supabase().functions.invoke(name, { body });
    if (error) fail(name, { name: 'FunctionError' });
    return data as T;
}

/** Explication tirée de la seule fiche ; null = « je ne sais pas » (la fiche s'affiche telle quelle). */
export async function explainProgram(programId: string): Promise<ExplanationOutput | null> {
    const result = await invoke<{ status: string; explanation?: unknown }>('explain-program', { program_id: programId });
    if (result.status !== 'ok') return null;
    const parsed = explanationOutputSchema.safeParse(result.explanation);
    return parsed.success ? parsed.data : null;
}

/** Modèle de lettre à espaces réservés ; null = indisponible. */
export async function draftLetter(programId: string, kind: LetterKind): Promise<string | null> {
    const result = await invoke<{ status: string; template?: unknown }>('draft-letter', { program_id: programId, kind });
    return result.status === 'ok' && typeof result.template === 'string' ? result.template : null;
}

// --------------------------------------------------------------------------------------- administration
export type ProgramInput = Pick<
    Program,
    | 'slug'
    | 'name'
    | 'organization'
    | 'summary'
    | 'criteria'
    | 'required_documents'
    | 'how_to_apply'
    | 'official_url'
    | 'source_label'
    | 'sort_order'
    | 'is_active'
>;

export interface Verification {
    verified_by: string;
    verified_on: string;
}

const verificationFields = (verification: Verification | null) =>
    verification
        ? { verification_status: 'verified', verified_on: verification.verified_on, verified_by: verification.verified_by.trim() }
        : {};

export async function createProgram(input: ProgramInput, verification: Verification | null): Promise<void> {
    const { error } = await supabase()
        .from('programs')
        .insert({ ...input, ...verificationFields(verification) });
    if (error) fail('create_program', error);
}

export async function updateProgram(id: string, input: ProgramInput, verification: Verification | null): Promise<void> {
    const { error } = await supabase()
        .from('programs')
        .update({ ...input, ...verificationFields(verification) })
        .eq('id', id);
    if (error) fail('update_program', error);
}

const AdminResourceSchema = z.object({
    id: z.uuid(),
    slug: z.string(),
    category: ResourceCategorySchema,
    name: z.string(),
    organization: z.string().nullable(),
    phone: z.string().nullable(),
    sms: z.string().nullable(),
    url: z.string().nullable(),
    description: z.string().nullable(),
    hours: z.string().nullable(),
    source_url: z.string().nullable(),
    verification_status: z.enum(['to_verify', 'verified']),
    verified_on: z.string().nullable(),
    verified_by: z.string().nullable(),
    sort_order: z.number(),
    is_active: z.boolean()
});
export type AdminResource = z.infer<typeof AdminResourceSchema>;
export type ResourceInput = Pick<
    AdminResource,
    'name' | 'organization' | 'phone' | 'sms' | 'url' | 'description' | 'hours' | 'source_url' | 'is_active'
>;

export async function listResourcesForAdmin(): Promise<AdminResource[]> {
    const { data, error } = await supabase()
        .from('resources')
        .select(
            'id, slug, category, name, organization, phone, sms, url, description, hours, source_url, verification_status, verified_on, verified_by, sort_order, is_active'
        )
        .order('sort_order', { ascending: true });
    if (error) fail('list_resources_admin', error);
    return z.array(AdminResourceSchema).parse(data);
}

export async function updateResource(id: string, input: ResourceInput, verification: Verification | null): Promise<void> {
    const { error } = await supabase()
        .from('resources')
        .update({ ...input, ...verificationFields(verification) })
        .eq('id', id);
    if (error) fail('update_resource', error);
}
