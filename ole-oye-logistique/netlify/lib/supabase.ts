import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Levée quand les variables d'environnement Supabase ne sont pas définies. */
export class NotConfiguredError extends Error {
  constructor(variable: string) {
    super(`Variable d'environnement manquante : ${variable}`);
    this.name = 'NotConfiguredError';
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new NotConfiguredError(name);
  return value;
}

const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/**
 * Client avec la clé de service : contourne RLS. À n'utiliser que dans les
 * fonctions serveur, jamais dans du code envoyé au navigateur.
 */
export function serviceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), OPTIONS);
}

/**
 * Client réservé aux appels d'authentification. Toujours une nouvelle
 * instance : `verifyOtp` mémorise la session de l'utilisateur dans le client,
 * qui ne doit donc jamais servir ensuite à lire la base.
 */
export function authClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), OPTIONS);
}

/** Identifiant du client (tenant) dans l'ERP : toutes les lectures et écritures sont filtrées dessus. */
export function tenantId(): string {
  return requireEnv('SITE_TENANT_ID');
}
