// Branchement des fonctions Edge (Deno) : clients Supabase, Storage, fournisseur d'IA, courriel, CORS.
// Variables : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (fournies par Supabase),
// RELAIS_APP_ORIGINS (origines autorisées, séparées par des virgules), ANTHROPIC_API_KEY, ANTHROPIC_MODEL ;
// pour les fonctions planifiées (rappels, purge de Storage) : RELAIS_CRON_SECRET, RELAIS_APP_URL ; pour le
// courriel : RELAIS_EMAIL_FROM, AWS_SES_ACCESS_KEY_ID, AWS_SES_SECRET_ACCESS_KEY, AWS_SES_REGION
// (ca-central-1 par défaut).
// Région : les fonctions doivent s'exécuter au Canada (ca-central-1) — à vérifier avant le pilote.
import { createClient } from '@supabase/supabase-js';
import { SesEmailClient } from './email.ts';
import { DOCUMENTS_BUCKET, RpcError, type Handler, type ServerContext } from './handlers.ts';
import { AnthropicLlmClient } from './llm.ts';
import { serverLog } from './log.ts';
import { cronSecretMatches, type ScheduledHandler } from './scheduled.ts';

function env(name: string): string {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`missing environment variable ${name}`);
    return value;
}

function corsHeaders(request: Request): Record<string, string> {
    const allowed = (Deno.env.get('RELAIS_APP_ORIGINS') ?? '').split(',').map((o) => o.trim());
    const origin = request.headers.get('origin') ?? '';
    return {
        ...(allowed.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
        'cache-control': 'no-store'
    };
}

/** Client de courriel (Amazon SES) si ses secrets sont configurés. */
function emailClient(): SesEmailClient | null {
    const accessKeyId = Deno.env.get('AWS_SES_ACCESS_KEY_ID');
    const secretAccessKey = Deno.env.get('AWS_SES_SECRET_ACCESS_KEY');
    const from = Deno.env.get('RELAIS_EMAIL_FROM');
    return accessKeyId && secretAccessKey && from
        ? new SesEmailClient({ accessKeyId, secretAccessKey, from, region: Deno.env.get('AWS_SES_REGION') })
        : null;
}

export function serveHandler(handler: Handler, options: { llm?: boolean; email?: boolean } = {}): void {
    Deno.serve(async (request) => {
        const headers = corsHeaders(request);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
        if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });

        try {
            const url = env('SUPABASE_URL');
            const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
            if (!token) return Response.json({ error: 'unauthorized' }, { status: 401, headers });
            // Clé « Authorization » exacte : en minuscules, supabase-js garderait aussi sa propre clé
            // (« Bearer <clé anonyme>, Bearer <jeton> ») et Auth refuserait le jeton.
            const userClient = createClient(url, env('SUPABASE_ANON_KEY'), {
                global: { headers: { Authorization: `Bearer ${token}` } },
                auth: { persistSession: false, autoRefreshToken: false }
            });
            const service = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), {
                auth: { persistSession: false, autoRefreshToken: false }
            });
            const { data: userData, error: userError } = await userClient.auth.getUser(token);
            if (userError || !userData.user) return Response.json({ error: 'unauthorized' }, { status: 401, headers });

            const rpc = async <T>(client: typeof userClient, fn: string, args: Record<string, unknown>): Promise<T> => {
                const { data, error } = await client.rpc(fn, args);
                if (error) throw new RpcError(error.code ?? 'unknown');
                return data as T;
            };
            const bucket = service.storage.from(DOCUMENTS_BUCKET);
            const apiKey = Deno.env.get('ANTHROPIC_API_KEY');

            const ctx: ServerContext = {
                userId: userData.user.id,
                userRpc: (fn, args) => rpc(userClient, fn, args),
                serviceRpc: (fn, args) => rpc(service, fn, args),
                storage: {
                    download: async (path) => {
                        const { data, error } = await bucket.download(path);
                        if (error || !data) throw new Error('storage download failed');
                        return new Uint8Array(await data.arrayBuffer());
                    },
                    remove: async (paths) => {
                        const { error } = await bucket.remove(paths);
                        if (error) throw new Error('storage remove failed');
                    },
                    signedUrl: async (path, seconds) => {
                        const { data, error } = await bucket.createSignedUrl(path, seconds);
                        if (error || !data) throw new Error('signed url failed');
                        return data.signedUrl;
                    }
                },
                queuedPaths: async (prefix) => {
                    const { data, error } = await service
                        .from('storage_deletion_queue')
                        .select('object_path')
                        .eq('bucket_id', DOCUMENTS_BUCKET)
                        .like('object_path', `${prefix}%`);
                    if (error) throw new RpcError(error.code ?? 'unknown');
                    return (data ?? []).map((row) => row.object_path as string);
                },
                clearQueuedPaths: async (paths) => {
                    const { error } = await service
                        .from('storage_deletion_queue')
                        .delete()
                        .eq('bucket_id', DOCUMENTS_BUCKET)
                        .in('object_path', paths);
                    if (error) throw new RpcError(error.code ?? 'unknown');
                },
                recordAiCall: async (row) => {
                    const { error } = await service.from('ai_calls').insert(row);
                    if (error) throw new RpcError(error.code ?? 'unknown');
                },
                llm: options.llm && apiKey ? new AnthropicLlmClient({ apiKey, model: Deno.env.get('ANTHROPIC_MODEL') }) : null,
                ocr: null, // Q3 : aucun OCR configuré pour le pilote
                email: options.email ? emailClient() : null,
                appUrl: Deno.env.get('RELAIS_APP_URL')
            };

            const body = await request.json().catch(() => null);
            const response = await handler(ctx, body);
            return Response.json(response.body, { status: response.status, headers });
        } catch (error) {
            serverLog('function_error', { errorName: error instanceof Error ? error.name : 'unknown' });
            return Response.json({ error: 'internal' }, { status: 500, headers });
        }
    });
}

/** Fonction planifiée (pg_cron → pg_net) : pas d'utilisateur, un secret partagé dans un en-tête. */
export function serveScheduled(handler: ScheduledHandler): void {
    Deno.serve(async (request) => {
        const headers = { 'cache-control': 'no-store' };
        if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers });
        if (!cronSecretMatches(Deno.env.get('RELAIS_CRON_SECRET'), request.headers.get('x-relais-cron-secret'))) {
            return Response.json({ error: 'unauthorized' }, { status: 401, headers });
        }
        try {
            const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
                auth: { persistSession: false, autoRefreshToken: false }
            });
            const response = await handler({
                serviceRpc: async (fn, args) => {
                    const { data, error } = await service.rpc(fn, args);
                    if (error) throw new RpcError(error.code ?? 'unknown');
                    return data;
                },
                removeFiles: async (paths) => {
                    const { error } = await service.storage.from(DOCUMENTS_BUCKET).remove(paths);
                    if (error) throw new Error('storage remove failed');
                },
                email: emailClient(),
                appUrl: env('RELAIS_APP_URL'),
                now: () => new Date()
            });
            return Response.json(response.body, { status: response.status, headers });
        } catch (error) {
            serverLog('function_error', { errorName: error instanceof Error ? error.name : 'unknown' });
            return Response.json({ error: 'internal' }, { status: 500, headers });
        }
    });
}
