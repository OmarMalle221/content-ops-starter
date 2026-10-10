import { parse as parseConnectionString, type ConnectionOptions } from 'pg-connection-string';
import { z } from 'zod';
import { logger } from './logger';

/** An empty variable (e.g. copied from .env.example) behaves exactly like an unset one. */
const unsetIfBlank = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema);
const optionalString = unsetIfBlank(z.string().optional());

/** Public, non-secret fallbacks. Acceptable only for the pure in-memory persona demo (no database, no Supabase). */
export const DEMO_SESSION_SECRET = 'demo-only-insecure-session-secret-change-me-0000';
export const DEMO_WEBHOOK_SECRET = 'demo-only-mock-webhook-secret';

const schema = z.object({
    TRUSTCARGO_MODE: unsetIfBlank(z.enum(['demo', 'production']).default('demo')),
    PAYMENT_PROVIDER: unsetIfBlank(z.enum(['mock']).default('mock')),
    SESSION_SECRET: unsetIfBlank(z.string().min(32).optional()),
    MOCK_PROVIDER_WEBHOOK_SECRET: unsetIfBlank(z.string().min(16).optional()),
    APP_URL: unsetIfBlank(z.string().url().default('http://localhost:3000')),
    /** Persona sign-in. Only honoured with TRUSTCARGO_MODE=demo and AUTH_PROVIDER=demo. */
    DEMO_ALLOW_PERSONA_LOGIN: unsetIfBlank(z.enum(['true', 'false']).default('true')),
    /**
     * Header carrying the client IP, set by the hosting platform's edge (fly-client-ip, cf-connecting-ip,
     * x-nf-client-connection-ip, x-real-ip…). Unset: right-most X-Forwarded-For entry (src/server/http/client-ip.ts).
     */
    CLIENT_IP_HEADER: unsetIfBlank(
        z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9-]{1,64}$/)
            .optional()
    ),

    // Persistence. Without DATABASE_URL the in-memory adapter is used (per process, lost on restart).
    DATABASE_URL: optionalString.pipe(
        z
            .string()
            .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
            .optional()
    ),
    /** Role assumed with SET LOCAL ROLE in every unit of work (least privilege: no DDL, RLS bypass only). Default service_role. */
    DATABASE_ROLE: optionalString.pipe(z.enum(['service_role']).optional()),
    DATABASE_POOL_MAX: unsetIfBlank(z.coerce.number().int().min(1).max(50).default(5)),
    /** PEM CA certificate used to verify the database server (Supabase: Database settings > SSL). Required for a remote host. */
    DATABASE_SSL_CA: optionalString,

    // Supabase Auth / Storage. Server-side only: no key is ever sent to the browser.
    AUTH_PROVIDER: unsetIfBlank(z.enum(['demo', 'supabase']).default('demo')),
    /**
     * Sign-in e-mails this process may ask Supabase Auth to send per hour, whatever the client: size it below the
     * (possibly shared) project's e-mail quota, minus what the other apps of that project need.
     */
    MAGIC_LINK_HOURLY_CAP: unsetIfBlank(z.coerce.number().int().min(1).max(100_000).default(20)),
    /** `memory` by default without DATABASE_URL; must be given explicitly with DATABASE_URL. */
    STORAGE_PROVIDER: unsetIfBlank(z.enum(['memory', 'supabase']).optional()),
    SUPABASE_URL: optionalString.pipe(z.string().url().optional()),
    /** Publishable key (sb_publishable_…) or legacy anon key. Used for Auth flows only. */
    SUPABASE_PUBLISHABLE_KEY: optionalString.pipe(z.string().min(20).optional()),
    /** Secret key (sb_secret_…) or legacy service_role key. Used for Storage only. */
    SUPABASE_SECRET_KEY: optionalString.pipe(z.string().min(20).optional()),
    SUPABASE_STORAGE_BUCKET: unsetIfBlank(
        z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
            .default('trustcargo-documents')
    )
});

export interface DatabaseConfig {
    url: string;
    role: 'service_role';
    poolMax: number;
    /** PEM. When set, the server certificate is verified against it and TLS settings in the URL are ignored. */
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
    /** Persona demo only (TRUSTCARGO_MODE=demo and AUTH_PROVIDER=demo): personas never sit next to real accounts. */
    personaLogin: boolean;
    /** Lower-cased header name; undefined → right-most X-Forwarded-For entry. */
    clientIpHeader?: string;
    /** Undefined → in-memory persistence. */
    database?: DatabaseConfig;
    /** magicLinkHourlyCap: sign-in e-mails per process and per hour (MAGIC_LINK_HOURLY_CAP). */
    auth: { provider: 'demo' | 'supabase'; magicLinkHourlyCap: number };
    storage: { provider: 'memory' | 'supabase'; bucket: string };
    /** Present when SUPABASE_URL is set. */
    supabase?: SupabaseConfig;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
/** URL settings that turn TLS off or skip the certificate check: refused for a remote database. */
const TLS_DOWNGRADES: Record<string, string[]> = { sslmode: ['disable', 'no-verify'], ssl: ['0', 'false'] };
/** URL parameters pg turns into TLS settings; it merges them OVER the explicit `ssl` option (e.g. `ssl=0` → no TLS). */
export const URL_TLS_PARAMS = ['ssl', 'sslmode', 'sslnegotiation', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat'];

/**
 * DATABASE_URL exactly as node-postgres reads it: pg-connection-string's own parse() (pg calls the same function), so
 * the host checked by loadConfig is the host pg connects to. The query string is read with URLSearchParams alone
 * (never a WHATWG URL holding the credentials):
 * - a repeated parameter is refused: pg keeps the LAST value, which a check reading the first one would miss
 *   (`?host=localhost&host=db.example.net`);
 * - `withoutTls` drops the URL's TLS parameters before parsing (pg-connection-string reads sslcert/sslkey/sslrootcert
 *   files while parsing; with DATABASE_SSL_CA they are ignored anyway).
 * Errors never echo the URL: it may contain a password.
 */
export function parseDatabaseUrl(
    url: string,
    options: { withoutTls?: boolean } = {}
): { connection: ConnectionOptions; params: URLSearchParams } {
    const q = url.indexOf('?');
    const params = new URLSearchParams(q === -1 ? '' : url.slice(q + 1).split('#')[0]);
    const keys = [...params.keys()];
    const repeated = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
    if (repeated.length) {
        const names = repeated.filter((k) => /^[a-z_]{1,32}$/i.test(k)).join(', ');
        throw new Error(`Invalid configuration: DATABASE_URL repeats a connection parameter${names ? ` (${names})` : ''}`);
    }
    let source = url;
    if (options.withoutTls && q !== -1) {
        const kept = new URLSearchParams([...params].filter(([k]) => !URL_TLS_PARAMS.includes(k)));
        source = `${url.slice(0, q)}${kept.size ? `?${kept}` : ''}`;
    }
    try {
        return { connection: parseConnectionString(source), params };
    } catch {
        throw new Error('Invalid configuration: DATABASE_URL is not a valid connection string');
    }
}

/** Hosts node-postgres connects to: the parsed host (the `host` query parameter wins), then PGHOST, then localhost. */
function databaseTarget(url: string, env: NodeJS.ProcessEnv): { hosts: string[]; params: URLSearchParams } {
    const { connection, params } = parseDatabaseUrl(url, { withoutTls: true });
    const host = connection.host || env.PGHOST || 'localhost';
    return { hosts: host.split(',').map((h) => h.trim()), params };
}

/** Loopback addresses and Unix socket paths never leave the machine; every other host does. */
function isLoopback(host: string): boolean {
    return host.startsWith('/') || LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** The CA may be given on one line with literal `\n` sequences, as some hosting env editors require. */
function normalizePem(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const pem = value.replace(/\\n/g, '\n').trim();
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error('DATABASE_SSL_CA must contain the PEM certificate itself (-----BEGIN CERTIFICATE-----…), not a file path');
    }
    return `${pem}\n`;
}

/**
 * TLS: a remote host (anything but loopback or a Unix socket) requires DATABASE_SSL_CA in every mode, and the server
 * certificate is then verified against it (src/server/adapters/postgres/pg-pool.ts). node-postgres never tries TLS by
 * itself, and Supabase accepts clear-text connections unless SSL enforcement is turned on.
 */
function databaseConfig(e: z.infer<typeof schema>, url: string, env: NodeJS.ProcessEnv): DatabaseConfig {
    const sslCa = normalizePem(e.DATABASE_SSL_CA);
    const { hosts, params } = databaseTarget(url, env);
    if (sslCa && hosts.some((h) => h.startsWith('/'))) {
        throw new Error('DATABASE_SSL_CA cannot be used with a Unix socket host: TLS never applies to a local socket (unset it)');
    }
    if (!hosts.every(isLoopback)) {
        if (!sslCa) {
            throw new Error(
                'DATABASE_SSL_CA (PEM CA certificate of the database server) is required for a non-local DATABASE_URL: ' +
                    'without it the connection is neither encrypted nor authenticated (docs/DEPLOYMENT.md)'
            );
        }
        for (const [key, refused] of Object.entries(TLS_DOWNGRADES)) {
            const value = params.get(key)?.toLowerCase();
            if (value !== undefined && refused.includes(value)) {
                throw new Error(`DATABASE_URL must not disable TLS or certificate verification (${key}=${value}) for a non-local database`);
            }
        }
    }
    // Every unit of work runs as service_role unless told otherwise (and service_role is the only accepted value).
    return { url, role: e.DATABASE_ROLE ?? 'service_role', poolMax: e.DATABASE_POOL_MAX, sslCa };
}

let cached: ServerConfig | undefined;

/**
 * Validates environment configuration at startup. Production mode refuses to start with the mock
 * payment provider, without explicit secrets or without durable persistence, authentication and storage:
 * no simulated component may be mistaken for a real one. The public demo secrets are only accepted by the
 * pure in-memory persona demo: with real accounts or persisted data, sessions and partner events would be forgeable.
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
    const realBackends = Boolean(e.DATABASE_URL) || e.AUTH_PROVIDER === 'supabase' || e.STORAGE_PROVIDER === 'supabase';
    if (realBackends && (!e.SESSION_SECRET || e.SESSION_SECRET === DEMO_SESSION_SECRET)) {
        throw new Error(
            'SESSION_SECRET (>= 32 random characters, e.g. `openssl rand -base64 48`) is required with DATABASE_URL, ' +
                'AUTH_PROVIDER=supabase or STORAGE_PROVIDER=supabase: the public demo fallback would let anyone forge sessions'
        );
    }
    if (realBackends && (!e.MOCK_PROVIDER_WEBHOOK_SECRET || e.MOCK_PROVIDER_WEBHOOK_SECRET === DEMO_WEBHOOK_SECRET)) {
        throw new Error(
            'MOCK_PROVIDER_WEBHOOK_SECRET (>= 16 random characters) is required with DATABASE_URL, AUTH_PROVIDER=supabase ' +
                'or STORAGE_PROVIDER=supabase: the public demo fallback would let anyone forge signed partner events'
        );
    }
    if (e.AUTH_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY)) {
        throw new Error('AUTH_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');
    }
    if (e.STORAGE_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SECRET_KEY)) {
        throw new Error('STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY');
    }
    // Document rows in Postgres with their bytes in process memory are lost on restart: never chosen by default.
    const storageProvider = e.STORAGE_PROVIDER ?? (e.DATABASE_URL ? undefined : 'memory');
    if (!storageProvider) {
        throw new Error(
            'STORAGE_PROVIDER must be set explicitly with DATABASE_URL: supabase, or memory (demo only: document files are ' +
                'lost on restart and not shared between instances)'
        );
    }
    if (e.CLIENT_IP_HEADER === 'x-forwarded-for') {
        throw new Error('CLIENT_IP_HEADER must name a single-value platform header; leave it unset to use X-Forwarded-For');
    }
    const database = e.DATABASE_URL ? databaseConfig(e, e.DATABASE_URL, env) : undefined;
    if (database && storageProvider === 'memory') {
        logger.warn('config.ephemeral_document_storage', {
            detail: 'STORAGE_PROVIDER=memory with DATABASE_URL: document files are lost on restart and not shared between instances'
        });
    }
    const config: ServerConfig = {
        mode: e.TRUSTCARGO_MODE,
        paymentProvider: e.PAYMENT_PROVIDER,
        // Reached only by the pure in-memory persona demo (checked above): no real account, nothing persisted.
        sessionSecret: e.SESSION_SECRET ?? DEMO_SESSION_SECRET,
        webhookSecret: e.MOCK_PROVIDER_WEBHOOK_SECRET ?? DEMO_WEBHOOK_SECRET,
        appUrl: e.APP_URL.replace(/\/$/, ''),
        // A database is either a persona demo or real accounts, never both: there is no opt-in to mix them.
        personaLogin: e.TRUSTCARGO_MODE === 'demo' && e.AUTH_PROVIDER === 'demo' && e.DEMO_ALLOW_PERSONA_LOGIN === 'true',
        clientIpHeader: e.CLIENT_IP_HEADER,
        database,
        auth: { provider: e.AUTH_PROVIDER, magicLinkHourlyCap: e.MAGIC_LINK_HOURLY_CAP },
        storage: { provider: storageProvider, bucket: e.SUPABASE_STORAGE_BUCKET },
        supabase: e.SUPABASE_URL
            ? { url: e.SUPABASE_URL.replace(/\/$/, ''), publishableKey: e.SUPABASE_PUBLISHABLE_KEY, secretKey: e.SUPABASE_SECRET_KEY }
            : undefined
    };
    if (env === process.env) cached = config;
    return config;
}
