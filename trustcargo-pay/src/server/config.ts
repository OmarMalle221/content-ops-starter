import { z } from 'zod';

const optionalString = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
    TRUSTCARGO_MODE: z.enum(['demo', 'production']).default('demo'),
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    SESSION_SECRET: z.string().min(32).optional(),
    MOCK_PROVIDER_WEBHOOK_SECRET: z.string().min(16).optional(),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DEMO_ALLOW_PERSONA_LOGIN: z.enum(['true', 'false']).default('true'),

    // Persistence. Without DATABASE_URL the in-memory adapter is used (per process, lost on restart).
    DATABASE_URL: optionalString.pipe(
        z
            .string()
            .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
            .optional()
    ),
    /** Role assumed with SET LOCAL ROLE in every unit of work (least privilege: no DDL, RLS bypass only). */
    DATABASE_ROLE: optionalString.pipe(z.enum(['service_role']).optional()),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    /** PEM CA certificate used to verify the database server (Supabase: Database settings > SSL). */
    DATABASE_SSL_CA: optionalString,

    // Supabase Auth / Storage. Server-side only: no key is ever sent to the browser.
    AUTH_PROVIDER: z.enum(['demo', 'supabase']).default('demo'),
    STORAGE_PROVIDER: z.enum(['memory', 'supabase']).default('memory'),
    SUPABASE_URL: optionalString.pipe(z.string().url().optional()),
    /** Publishable key (sb_publishable_…) or legacy anon key. Used for Auth flows only. */
    SUPABASE_PUBLISHABLE_KEY: optionalString.pipe(z.string().min(20).optional()),
    /** Secret key (sb_secret_…) or legacy service_role key. Used for Storage only. */
    SUPABASE_SECRET_KEY: optionalString.pipe(z.string().min(20).optional()),
    SUPABASE_STORAGE_BUCKET: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
        .default('trustcargo-documents')
});

export interface DatabaseConfig {
    url: string;
    role?: 'service_role';
    poolMax: number;
    sslCa?: string;
}

export interface SupabaseConfig {
    url: string;
    publishableKey?: string;
    secretKey?: string;
}

export interface ServerConfig {
    mode: 'demo' | 'production';
    paymentProvider: 'mock';
    sessionSecret: string;
    webhookSecret: string;
    appUrl: string;
    personaLogin: boolean;
    /** Undefined → in-memory persistence. */
    database?: DatabaseConfig;
    auth: { provider: 'demo' | 'supabase' };
    storage: { provider: 'memory' | 'supabase'; bucket: string };
    /** Present when SUPABASE_URL is set. */
    supabase?: SupabaseConfig;
}

let cached: ServerConfig | undefined;

/**
 * Validates environment configuration at startup. Production mode refuses to start with the mock
 * payment provider, without explicit secrets or without durable persistence, authentication and storage:
 * no simulated component may be mistaken for a real one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
    if (cached && env === process.env) return cached;
    const parsed = schema.safeParse(env);
    if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
    const e = parsed.data;
    if (e.TRUSTCARGO_MODE === 'production') {
        if (e.PAYMENT_PROVIDER === 'mock') {
            throw new Error('Production mode requires a licensed payment partner adapter. The mock provider is simulation-only.');
        }
        if (!e.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production');
        if (!e.DATABASE_URL) throw new Error('DATABASE_URL is required in production (the in-memory database is demo-only)');
        if (e.AUTH_PROVIDER !== 'supabase') throw new Error('AUTH_PROVIDER=supabase is required in production');
        if (e.STORAGE_PROVIDER !== 'supabase') throw new Error('STORAGE_PROVIDER=supabase is required in production');
    }
    if (e.AUTH_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY)) {
        throw new Error('AUTH_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
    }
    if (e.STORAGE_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SECRET_KEY)) {
        throw new Error('STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY');
    }
    const config: ServerConfig = {
        mode: e.TRUSTCARGO_MODE,
        paymentProvider: e.PAYMENT_PROVIDER,
        // Demo fallbacks are clearly non-secret and only acceptable because no real money or data exists.
        sessionSecret: e.SESSION_SECRET ?? 'demo-only-insecure-session-secret-change-me-0000',
        webhookSecret: e.MOCK_PROVIDER_WEBHOOK_SECRET ?? 'demo-only-mock-webhook-secret',
        appUrl: e.APP_URL.replace(/\/$/, ''),
        personaLogin: e.TRUSTCARGO_MODE === 'demo' && e.DEMO_ALLOW_PERSONA_LOGIN === 'true',
        database: e.DATABASE_URL
            ? { url: e.DATABASE_URL, role: e.DATABASE_ROLE, poolMax: e.DATABASE_POOL_MAX, sslCa: e.DATABASE_SSL_CA }
            : undefined,
        auth: { provider: e.AUTH_PROVIDER },
        storage: { provider: e.STORAGE_PROVIDER, bucket: e.SUPABASE_STORAGE_BUCKET },
        supabase: e.SUPABASE_URL
            ? { url: e.SUPABASE_URL.replace(/\/$/, ''), publishableKey: e.SUPABASE_PUBLISHABLE_KEY, secretKey: e.SUPABASE_SECRET_KEY }
            : undefined
    };
    if (env === process.env) cached = config;
    return config;
}
