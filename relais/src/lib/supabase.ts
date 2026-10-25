import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readEnv } from './env';

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
    if (!client) {
        const env = readEnv();
        client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                // Connexion par code à 6 chiffres : aucun jeton dans l'URL.
                detectSessionInUrl: false,
                storageKey: 'relais-auth'
            }
        });
    }
    return client;
}
