// Coordination (étape 5) : tâches, agenda des rendez-vous, questions à poser, carnet de bord.
// La base décide des droits (zones « coordination » et « santé ») ; ces fonctions ne font que lire et
// écrire, avec validation Zod des réponses.
import { z } from 'zod';
import { ApiError } from './api';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

// ------------------------------------------------------------------------------------------ tâches
const TaskSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    title: z.string(),
    details: z.string().nullable(),
    assignee_id: z.uuid().nullable(),
    due_on: z.string().nullable(),
    status: z.enum(['todo', 'done']),
    completed_at: z.string().nullable(),
    completed_by: z.uuid().nullable(),
    source_document_id: z.uuid().nullable(),
    care_file_program_id: z.uuid().nullable(),
    created_by: z.uuid().nullable(),
    created_at: z.string()
});
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = Pick<Task, 'title' | 'details' | 'assignee_id' | 'due_on'>;
export type TaskOrigin = Partial<Pick<Task, 'source_document_id' | 'care_file_program_id'>>;
const TASK_COLUMNS =
    'id, care_file_id, title, details, assignee_id, due_on, status, completed_at, completed_by, source_document_id, care_file_program_id, created_by, created_at';

export async function listTasks(fileId: string): Promise<Task[]> {
    const { data, error } = await supabase()
        .from('tasks')
        .select(TASK_COLUMNS)
        .eq('care_file_id', fileId)
        .order('due_on', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true });
    if (error) fail('list_tasks', error);
    return z.array(TaskSchema).parse(data);
}

export async function createTask(fileId: string, input: TaskInput, origin: TaskOrigin = {}): Promise<void> {
    const { error } = await supabase()
        .from('tasks')
        .insert({ care_file_id: fileId, ...input, title: input.title.trim(), ...origin });
    if (error) fail('create_task', error);
}

export async function updateTask(id: string, input: TaskInput): Promise<void> {
    const { error } = await supabase()
        .from('tasks')
        .update({ ...input, title: input.title.trim() })
        .eq('id', id);
    if (error) fail('update_task', error);
}

export async function setTaskDone(id: string, done: boolean): Promise<void> {
    const { error } = await supabase()
        .from('tasks')
        .update({ status: done ? 'done' : 'todo' })
        .eq('id', id);
    if (error) fail('update_task_status', error);
}

export async function deleteTask(id: string): Promise<void> {
    const { error } = await supabase().from('tasks').delete().eq('id', id);
    if (error) fail('delete_task', error);
}

// -------------------------------------------------------------------------------------- rendez-vous
const AppointmentSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    title: z.string(),
    starts_at: z.string(),
    ends_at: z.string().nullable(),
    location: z.string().nullable(),
    contact_id: z.uuid().nullable(),
    companion_id: z.uuid().nullable(),
    notes: z.string().nullable(),
    source_document_id: z.uuid().nullable(),
    created_by: z.uuid().nullable(),
    created_at: z.string()
});
export type Appointment = z.infer<typeof AppointmentSchema>;
export type AppointmentInput = Pick<Appointment, 'title' | 'starts_at' | 'ends_at' | 'location' | 'contact_id' | 'companion_id' | 'notes'>;
const APPOINTMENT_COLUMNS =
    'id, care_file_id, title, starts_at, ends_at, location, contact_id, companion_id, notes, source_document_id, created_by, created_at';

export async function listAppointments(fileId: string): Promise<Appointment[]> {
    const { data, error } = await supabase()
        .from('appointments')
        .select(APPOINTMENT_COLUMNS)
        .eq('care_file_id', fileId)
        .order('starts_at', { ascending: true });
    if (error) fail('list_appointments', error);
    return z.array(AppointmentSchema).parse(data);
}

export async function createAppointment(fileId: string, input: AppointmentInput): Promise<string> {
    const { data, error } = await supabase()
        .from('appointments')
        .insert({ care_file_id: fileId, ...input, title: input.title.trim() })
        .select('id')
        .single();
    if (error) fail('create_appointment', error);
    return z.object({ id: z.uuid() }).parse(data).id;
}

export async function updateAppointment(id: string, input: AppointmentInput): Promise<void> {
    const { error } = await supabase()
        .from('appointments')
        .update({ ...input, title: input.title.trim() })
        .eq('id', id);
    if (error) fail('update_appointment', error);
}

export async function deleteAppointment(id: string): Promise<void> {
    const { error } = await supabase().from('appointments').delete().eq('id', id);
    if (error) fail('delete_appointment', error);
}

// ---------------------------------------------------------------------------------- questions à poser
const QuestionSchema = z.object({
    id: z.uuid(),
    appointment_id: z.uuid(),
    question: z.string(),
    position: z.number(),
    created_by: z.uuid().nullable()
});
export type AppointmentQuestion = z.infer<typeof QuestionSchema>;

export async function listQuestions(appointmentId: string): Promise<AppointmentQuestion[]> {
    const { data, error } = await supabase()
        .from('appointment_questions')
        .select('id, appointment_id, question, position, created_by')
        .eq('appointment_id', appointmentId)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true });
    if (error) fail('list_questions', error);
    return z.array(QuestionSchema).parse(data);
}

export async function addQuestion(fileId: string, appointmentId: string, question: string, position: number): Promise<void> {
    const { error } = await supabase()
        .from('appointment_questions')
        .insert({ care_file_id: fileId, appointment_id: appointmentId, question: question.trim(), position });
    if (error) fail('add_question', error);
}

export async function deleteQuestion(id: string): Promise<void> {
    const { error } = await supabase().from('appointment_questions').delete().eq('id', id);
    if (error) fail('delete_question', error);
}

/** La page « Préparer un rendez-vous » contient des renseignements de santé : son impression est notée. */
export async function logPrepSheetPrinted(fileId: string, appointmentId: string): Promise<void> {
    const { error } = await supabase().rpc('log_access', {
        p_care_file_id: fileId,
        p_action: 'prep_sheet_printed',
        p_target_type: 'appointments',
        p_target_id: appointmentId
    });
    if (error) fail('log_access', error);
}

// ------------------------------------------------------------------------------------ carnet de bord
const JournalEntrySchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    author_id: z.uuid().nullable(),
    body: z.string(),
    created_at: z.string(),
    updated_at: z.string()
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export async function listJournal(fileId: string): Promise<JournalEntry[]> {
    const { data, error } = await supabase()
        .from('journal_entries')
        .select('id, care_file_id, author_id, body, created_at, updated_at')
        .eq('care_file_id', fileId)
        .order('created_at', { ascending: false });
    if (error) fail('list_journal', error);
    return z.array(JournalEntrySchema).parse(data);
}

export async function addJournalEntry(fileId: string, body: string): Promise<void> {
    const { error } = await supabase().from('journal_entries').insert({ care_file_id: fileId, body: body.trim() });
    if (error) fail('add_journal_entry', error);
}

export async function updateJournalEntry(id: string, body: string): Promise<void> {
    const { error } = await supabase().from('journal_entries').update({ body: body.trim() }).eq('id', id);
    if (error) fail('update_journal_entry', error);
}

export async function deleteJournalEntry(id: string): Promise<void> {
    const { error } = await supabase().from('journal_entries').delete().eq('id', id);
    if (error) fail('delete_journal_entry', error);
}
