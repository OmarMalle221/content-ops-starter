// Accès aux données du dossier familial (étape 2). Mêmes principes que api.ts : réponses validées par Zod,
// erreurs journalisées sans leur message. Les permissions sont appliquées par la base (RLS) ; l'interface
// ne fait que masquer ce qui serait refusé.
import { z } from 'zod';
import { ApiError } from './api';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

export const MEMBER_ROLES = ['primary_caregiver', 'family_member', 'care_recipient', 'relais_worker'] as const;
export const ACCESS_LEVELS = ['owner', 'full', 'coordination', 'read_only'] as const;
export const LIVING_SETTINGS = ['home', 'rpa', 'intermediate_resource', 'chsld', 'hospital', 'other'] as const;
export const CONTACT_KINDS = ['clsc', 'social_worker', 'physician', 'pharmacy', 'notary', 'residence', 'home_care', 'other'] as const;
export const SERVICES = ['clsc_home_support', 'domestic_help', 'meals_on_wheels', 'day_center', 'respite', 'adapted_transport'] as const;
export const LEGAL_BASES = ['person_consents', 'homologated_protection_mandate', 'tutorship', 'power_of_attorney', 'other'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type LegalBasis = (typeof LEGAL_BASES)[number];

const CareFileSchema = z.object({ id: z.uuid(), title: z.string(), owner_id: z.uuid(), created_at: z.string() });
export type CareFile = z.infer<typeof CareFileSchema>;

const MembershipSchema = z.object({
    care_file_id: z.uuid(),
    user_id: z.uuid(),
    role: z.enum(MEMBER_ROLES),
    access_level: z.enum(ACCESS_LEVELS),
    joined_at: z.string()
});
export type Membership = z.infer<typeof MembershipSchema>;

const MemberNameSchema = z.object({ id: z.uuid(), display_name: z.string().nullable() });

const CareRecipientSchema = z.object({
    care_file_id: z.uuid(),
    first_name: z.string(),
    last_name: z.string().nullable(),
    birth_year: z.number().nullable(),
    living_setting: z.enum(LIVING_SETTINGS),
    living_setting_since: z.string().nullable(),
    residence_name: z.string().nullable(),
    chsld_waitlist: z.boolean(),
    chsld_waitlist_since: z.string().nullable()
});
export type CareRecipient = z.infer<typeof CareRecipientSchema>;
export type CareRecipientInput = Omit<CareRecipient, 'care_file_id'>;

const CareNeedsSchema = z.object({
    care_file_id: z.uuid(),
    autonomy_description: z.string().nullable(),
    services_in_place: z.array(z.string()),
    home_adaptation_needs: z.string().nullable()
});
export type CareNeeds = z.infer<typeof CareNeedsSchema>;
export type CareNeedsInput = Omit<CareNeeds, 'care_file_id'>;

const ContactSchema = z.object({
    id: z.uuid(),
    care_file_id: z.uuid(),
    kind: z.enum(CONTACT_KINDS),
    name: z.string(),
    organization: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    address: z.string().nullable(),
    notes: z.string().nullable()
});
export type Contact = z.infer<typeof ContactSchema>;
export type ContactInput = Omit<Contact, 'id' | 'care_file_id'>;

const InvitationSchema = z.object({
    id: z.uuid(),
    email: z.string(),
    role: z.enum(MEMBER_ROLES),
    access_level: z.enum(ACCESS_LEVELS),
    expires_at: z.string(),
    accepted_at: z.string().nullable(),
    revoked_at: z.string().nullable()
});
export type Invitation = z.infer<typeof InvitationSchema>;

const FileConsentSchema = z.object({
    id: z.uuid(),
    consent_type: z.string(),
    text_version: z.string(),
    granted_by: z.string(),
    legal_basis: z.string().nullable(),
    representative_name: z.string().nullable(),
    granted_at: z.string(),
    revoked_at: z.string().nullable(),
    revoked_by: z.string().nullable()
});
export type FileConsent = z.infer<typeof FileConsentSchema>;

const AccessLogEntrySchema = z.object({
    id: z.number(),
    occurred_at: z.string(),
    actor_id: z.string().nullable(),
    action: z.string()
});
export type AccessLogEntry = z.infer<typeof AccessLogEntrySchema>;

// ------------------------------------------------------------------------------------ dossiers
export async function listMyMemberships(userId: string): Promise<Membership[]> {
    const { data, error } = await supabase()
        .from('care_file_members')
        .select('care_file_id, user_id, role, access_level, joined_at')
        .eq('user_id', userId)
        .order('joined_at', { ascending: true });
    if (error) fail('list_memberships', error);
    return z.array(MembershipSchema).parse(data);
}

export async function listCareFiles(ids: string[]): Promise<CareFile[]> {
    if (ids.length === 0) return [];
    const { data, error } = await supabase().from('care_files').select('id, title, owner_id, created_at').in('id', ids);
    if (error) fail('list_care_files', error);
    return z.array(CareFileSchema).parse(data);
}

export async function getCareFile(id: string): Promise<CareFile | null> {
    const { data, error } = await supabase().from('care_files').select('id, title, owner_id, created_at').eq('id', id);
    if (error) fail('get_care_file', error);
    return z.array(CareFileSchema).parse(data)[0] ?? null;
}

export async function createCareFile(title: string): Promise<string> {
    const { data, error } = await supabase().rpc('create_care_file', { p_title: title });
    if (error) fail('create_care_file', error);
    return z.uuid().parse(data);
}

export async function renameCareFile(id: string, title: string): Promise<void> {
    const { error } = await supabase().from('care_files').update({ title: title.trim() }).eq('id', id);
    if (error) fail('rename_care_file', error);
}

export async function exportCareFile(id: string): Promise<unknown> {
    const { data, error } = await supabase().rpc('export_care_file', { p_care_file_id: id });
    if (error) fail('export_care_file', error);
    return data;
}

export async function deleteCareFile(id: string): Promise<void> {
    const { error } = await supabase().rpc('delete_care_file', { p_care_file_id: id });
    if (error) fail('delete_care_file', error);
}

export async function logFileOpened(id: string): Promise<void> {
    const { error } = await supabase().rpc('log_access', {
        p_care_file_id: id,
        p_action: 'file_opened',
        p_target_type: 'care_files',
        p_target_id: id
    });
    if (error) fail('log_access', error);
}

// ------------------------------------------------------------------------------------- membres
export async function listMembers(fileId: string): Promise<Array<Membership & { display_name: string | null }>> {
    const { data, error } = await supabase()
        .from('care_file_members')
        .select('care_file_id, user_id, role, access_level, joined_at')
        .eq('care_file_id', fileId)
        .order('joined_at', { ascending: true });
    if (error) fail('list_members', error);
    const members = z.array(MembershipSchema).parse(data);
    const names = await listUserNames(members.map((m) => m.user_id));
    return members.map((m) => ({ ...m, display_name: names.get(m.user_id) ?? null }));
}

/** Noms des personnes avec qui l'utilisateur partage un dossier (les autres restent invisibles). */
export async function listUserNames(ids: string[]): Promise<Map<string, string | null>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await supabase().from('users').select('id, display_name').in('id', ids);
    if (error) fail('list_user_names', error);
    return new Map(
        z
            .array(MemberNameSchema)
            .parse(data)
            .map((u) => [u.id, u.display_name])
    );
}

export async function updateMemberAccess(fileId: string, userId: string, level: AccessLevel): Promise<void> {
    const { error } = await supabase()
        .from('care_file_members')
        .update({ access_level: level })
        .eq('care_file_id', fileId)
        .eq('user_id', userId);
    if (error) fail('update_member_access', error);
}

export async function removeMember(fileId: string, userId: string): Promise<void> {
    const { error } = await supabase().from('care_file_members').delete().eq('care_file_id', fileId).eq('user_id', userId);
    if (error) fail('remove_member', error);
}

// --------------------------------------------------------------------------------- invitations
export async function listInvitations(fileId: string): Promise<Invitation[]> {
    const { data, error } = await supabase()
        .from('care_file_invitations')
        .select('id, email, role, access_level, expires_at, accepted_at, revoked_at')
        .eq('care_file_id', fileId)
        .order('created_at', { ascending: false });
    if (error) fail('list_invitations', error);
    return z.array(InvitationSchema).parse(data);
}

/** Renvoie le jeton en clair : il n'existe qu'une fois, dans le lien que l'aidant partage. */
export async function createInvitation(fileId: string, email: string, role: MemberRole, level: AccessLevel): Promise<string> {
    const { data, error } = await supabase().rpc('create_invitation', {
        p_care_file_id: fileId,
        p_email: email,
        p_role: role,
        p_access_level: level
    });
    if (error) fail('create_invitation', error);
    return z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .parse(data);
}

export async function revokeInvitation(id: string): Promise<void> {
    const { error } = await supabase().from('care_file_invitations').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) fail('revoke_invitation', error);
}

export async function acceptInvitation(token: string): Promise<string> {
    const { data, error } = await supabase().rpc('accept_invitation', { p_token: token });
    if (error) fail('accept_invitation', error);
    return z.uuid().parse(data);
}

/** Lien d'invitation : le jeton est dans le fragment (#), jamais envoyé aux serveurs ni aux journaux web. */
export function invitationLink(origin: string, token: string): string {
    return `${origin}/invitation#${token}`;
}

// ---------------------------------------------------------------------------------- consentement
export async function listFileConsents(fileId: string): Promise<FileConsent[]> {
    const { data, error } = await supabase()
        .from('consents')
        .select('id, consent_type, text_version, granted_by, legal_basis, representative_name, granted_at, revoked_at, revoked_by')
        .eq('care_file_id', fileId)
        .order('granted_at', { ascending: false });
    if (error) fail('list_file_consents', error);
    return z.array(FileConsentSchema).parse(data);
}

export async function recordFileConsent(input: {
    fileId: string;
    version: string;
    grantedBy: 'care_recipient_in_app' | 'care_recipient_signed_form' | 'legal_representative';
    legalBasis: LegalBasis;
    representativeName?: string;
}): Promise<void> {
    const { error } = await supabase().rpc('record_file_consent', {
        p_care_file_id: input.fileId,
        p_type: 'care_recipient_data',
        p_version: input.version,
        p_granted_by: input.grantedBy,
        p_legal_basis: input.legalBasis,
        p_representative_name: input.representativeName ?? null
    });
    if (error) fail('record_file_consent', error);
    logEvent('consent_granted', { code: 'care_recipient_data' });
}

export async function revokeFileConsent(consentId: string): Promise<void> {
    const { error } = await supabase().rpc('revoke_consent', { p_consent_id: consentId });
    if (error) fail('revoke_file_consent', error);
    logEvent('consent_revoked', { code: 'care_recipient_data' });
}

// ----------------------------------------------------------------------- profil, besoins, contacts
export async function getCareRecipient(fileId: string): Promise<CareRecipient | null> {
    const { data, error } = await supabase()
        .from('care_recipients')
        .select(
            'care_file_id, first_name, last_name, birth_year, living_setting, living_setting_since, residence_name, chsld_waitlist, chsld_waitlist_since'
        )
        .eq('care_file_id', fileId);
    if (error) fail('get_care_recipient', error);
    return z.array(CareRecipientSchema).parse(data)[0] ?? null;
}

export async function saveCareRecipient(fileId: string, input: CareRecipientInput, exists: boolean): Promise<void> {
    const client = supabase();
    const { error } = exists
        ? await client.from('care_recipients').update(input).eq('care_file_id', fileId)
        : await client.from('care_recipients').insert({ care_file_id: fileId, ...input });
    if (error) fail('save_care_recipient', error);
}

export async function getCareNeeds(fileId: string): Promise<CareNeeds | null> {
    const { data, error } = await supabase()
        .from('care_needs')
        .select('care_file_id, autonomy_description, services_in_place, home_adaptation_needs')
        .eq('care_file_id', fileId);
    if (error) fail('get_care_needs', error);
    return z.array(CareNeedsSchema).parse(data)[0] ?? null;
}

export async function saveCareNeeds(fileId: string, input: CareNeedsInput, exists: boolean): Promise<void> {
    const client = supabase();
    const { error } = exists
        ? await client.from('care_needs').update(input).eq('care_file_id', fileId)
        : await client.from('care_needs').insert({ care_file_id: fileId, ...input });
    if (error) fail('save_care_needs', error);
}

export async function listContacts(fileId: string): Promise<Contact[]> {
    const { data, error } = await supabase()
        .from('contacts')
        .select('id, care_file_id, kind, name, organization, phone, email, address, notes')
        .eq('care_file_id', fileId)
        .order('created_at', { ascending: true });
    if (error) fail('list_contacts', error);
    return z.array(ContactSchema).parse(data);
}

export async function createContact(fileId: string, input: ContactInput): Promise<void> {
    const { error } = await supabase()
        .from('contacts')
        .insert({ care_file_id: fileId, ...input });
    if (error) fail('create_contact', error);
}

export async function updateContact(id: string, input: ContactInput): Promise<void> {
    const { error } = await supabase().from('contacts').update(input).eq('id', id);
    if (error) fail('update_contact', error);
}

export async function deleteContact(id: string): Promise<void> {
    const { error } = await supabase().from('contacts').delete().eq('id', id);
    if (error) fail('delete_contact', error);
}

// -------------------------------------------------------------------------------------- journal
export async function listAccessLog(fileId: string): Promise<AccessLogEntry[]> {
    const { data, error } = await supabase()
        .from('access_log')
        .select('id, occurred_at, actor_id, action')
        .eq('care_file_id', fileId)
        .order('occurred_at', { ascending: false })
        .limit(200);
    if (error) fail('list_access_log', error);
    return z.array(AccessLogEntrySchema).parse(data);
}
