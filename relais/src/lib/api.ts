// Accès aux données. Chaque réponse est validée par un schéma Zod avant d'atteindre l'interface ;
// les erreurs sont journalisées sans leur message (src/lib/log.ts).
import { z } from 'zod';
import emergencySnapshot from '../content/emergency-resources.json';
import type { ConsentRecord, UserConsentType } from './consents';
import { errorFields, logEvent } from './log';
import { supabase } from './supabase';

export class ApiError extends Error {
    override readonly name = 'ApiError';
    constructor(
        readonly operation: string,
        readonly code: string | undefined
    ) {
        super(`Échec de l'opération ${operation}`);
    }
}

function fail(operation: string, error: unknown): never {
    logEvent('api_error', { ...errorFields(error), route: operation });
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
    throw new ApiError(operation, code);
}

// -------------------------------------------------------------------------------------------- Profil
export const ProfileSchema = z.object({
    id: z.uuid(),
    display_name: z.string().nullable(),
    app_role: z.enum(['member', 'relais_worker', 'admin'])
});
export type Profile = z.infer<typeof ProfileSchema>;

export async function getProfile(userId: string): Promise<Profile> {
    const { data, error } = await supabase().from('users').select('id, display_name, app_role').eq('id', userId).single();
    if (error) fail('get_profile', error);
    return ProfileSchema.parse(data);
}

export async function updateDisplayName(userId: string, displayName: string): Promise<void> {
    const { error } = await supabase().from('users').update({ display_name: displayName.trim() }).eq('id', userId);
    if (error) fail('update_display_name', error);
}

// ------------------------------------------------------------------------------------ Consentements
const ConsentSchema = z.object({
    id: z.uuid(),
    consent_type: z.string(),
    text_version: z.string(),
    granted_at: z.string(),
    revoked_at: z.string().nullable()
});

export async function listMyConsents(): Promise<ConsentRecord[]> {
    const { data, error } = await supabase()
        .from('consents')
        .select('id, consent_type, text_version, granted_at, revoked_at')
        .is('care_file_id', null)
        .order('granted_at', { ascending: false });
    if (error) fail('list_consents', error);
    return z.array(ConsentSchema).parse(data);
}

export async function grantConsent(type: UserConsentType, version: string): Promise<void> {
    const { error } = await supabase().rpc('grant_consent', { p_type: type, p_version: version });
    if (error) fail('grant_consent', error);
    logEvent('consent_granted', { code: type });
}

export async function revokeConsent(consentId: string, type: UserConsentType): Promise<void> {
    const { error } = await supabase().rpc('revoke_consent', { p_consent_id: consentId });
    if (error) fail('revoke_consent', error);
    logEvent('consent_revoked', { code: type });
}

// ---------------------------------------------------------------------------------------- Ressources
export const ResourceCategorySchema = z.enum([
    'emergency',
    'crisis_line',
    'psychosocial_line',
    'health_line',
    'respite',
    'caregiver_support',
    'elder_abuse',
    'info'
]);
export const ResourceSchema = z.object({
    slug: z.string(),
    category: ResourceCategorySchema,
    name: z.string(),
    phone: z.string().nullable(),
    sms: z.string().nullable(),
    url: z.string().nullable(),
    description: z.string().nullable(),
    hours: z.string().nullable(),
    sort_order: z.number()
});
export type Resource = z.infer<typeof ResourceSchema>;

/** Catégories affichées sur la page « Aide immédiate » (l'écran d'urgence en choisit une partie). */
export const HELP_CATEGORIES = [
    'emergency',
    'crisis_line',
    'psychosocial_line',
    'health_line',
    'caregiver_support',
    'respite',
    'elder_abuse'
] as const;

/** Copie de secours tirée de la même source que la table `resources` (jamais d'un texte généré). */
export const EMERGENCY_SNAPSHOT: Resource[] = z.array(ResourceSchema).parse(emergencySnapshot);

export async function listHelpResources(): Promise<Resource[]> {
    const { data, error } = await supabase()
        .from('resources')
        .select('slug, category, name, phone, sms, url, description, hours, sort_order')
        .in('category', [...HELP_CATEGORIES])
        .order('sort_order', { ascending: true });
    if (error) fail('list_resources', error);
    const resources = z.array(ResourceSchema).parse(data);
    // Une table vide ou incomplète ne doit jamais retirer le 911 de l'écran.
    return resources.some((r) => r.category === 'emergency') ? resources : EMERGENCY_SNAPSHOT;
}

// ----------------------------------------------------------------------------------- Compte et droits
export async function exportMyData(): Promise<unknown> {
    const { data, error } = await supabase().rpc('export_my_data');
    if (error) fail('export_my_data', error);
    return data;
}

/** Supprime le compte côté serveur. L'appelant ferme ensuite la session locale (voir signOutLocally). */
export async function deleteMyAccount(): Promise<void> {
    const { error } = await supabase().rpc('delete_my_account');
    if (error) fail('delete_my_account', error);
    logEvent('account_deleted');
}

/** Ferme la session sur cet appareil. */
export async function signOutLocally(): Promise<void> {
    await supabase().auth.signOut({ scope: 'local' });
}
