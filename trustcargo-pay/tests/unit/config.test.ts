import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { pgConnectionOptions } from '@/server/adapters/postgres/pg-pool';
import { DEMO_SESSION_SECRET, DEMO_WEBHOOK_SECRET, loadConfig, type DatabaseConfig } from '@/server/config';
import { logger } from '@/server/logger';

const SESSION_SECRET = 'test-session-secret-0123456789-abcdefghij';
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
const REMOTE_URL = 'postgresql://postgres:s3cret-pw@db.abcdefghij.supabase.co:5432/postgres';
const CA = '-----BEGIN CERTIFICATE-----\nMIIDtest\n-----END CERTIFICATE-----';
const SUPABASE = {
    SUPABASE_URL: 'https://project-ref.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_unit_test_only_0123456789',
    SUPABASE_SECRET_KEY: 'sb_secret_unit_test_only_0123456789'
};

const load = (env: Record<string, string>) => loadConfig({ TRUSTCARGO_MODE: 'demo', ...env } as unknown as NodeJS.ProcessEnv);
const failure = (env: Record<string, string>) => {
    try {
        load(env);
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error('expected loadConfig to refuse this configuration');
};
/** A persistent deployment with every required secret, storage given explicitly. */
const persistent = (env: Record<string, string> = {}) => ({
    SESSION_SECRET,
    MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STORAGE_PROVIDER: 'memory',
    DATABASE_URL: 'postgresql://postgres@localhost:5432/postgres',
    ...env
});

/** KEY=value lines of .env.example, as Next.js loads them after `cp .env.example .env.local` (empty values included). */
function envExample(): Record<string, string> {
    const lines = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').split('\n');
    return Object.fromEntries(
        lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
    );
}

describe('configuration: demo fallbacks and required secrets', () => {
    it('starts the pure in-memory persona demo from an unedited copy of .env.example (empty values = unset)', () => {
        const env = envExample();
        expect(env).toMatchObject({ SESSION_SECRET: '', MOCK_PROVIDER_WEBHOOK_SECRET: '' });
        const config = loadConfig(env as unknown as NodeJS.ProcessEnv);
        expect(config).toMatchObject({
            mode: 'demo',
            sessionSecret: DEMO_SESSION_SECRET,
            webhookSecret: DEMO_WEBHOOK_SECRET,
            personaLogin: true,
            database: undefined,
            auth: { provider: 'demo' },
            storage: { provider: 'memory' }
        });
    });

    it('treats every empty variable as unset', () => {
        const blank = Object.fromEntries(
            ['TRUSTCARGO_MODE', 'PAYMENT_PROVIDER', 'APP_URL', 'DEMO_ALLOW_PERSONA_LOGIN', 'DATABASE_POOL_MAX', 'AUTH_PROVIDER']
                .concat(['STORAGE_PROVIDER', 'SUPABASE_STORAGE_BUCKET', 'CLIENT_IP_HEADER', 'DATABASE_URL', 'DATABASE_ROLE'])
                .map((k) => [k, ''])
        );
        expect(load(blank)).toMatchObject({ mode: 'demo', appUrl: 'http://localhost:3000', personaLogin: true, database: undefined });
    });

    it.each([
        ['DATABASE_URL', persistent({ SESSION_SECRET: '' })],
        ['AUTH_PROVIDER=supabase', { AUTH_PROVIDER: 'supabase', ...SUPABASE }],
        ['STORAGE_PROVIDER=supabase', { STORAGE_PROVIDER: 'supabase', ...SUPABASE }],
        ['the public demo constant', { AUTH_PROVIDER: 'supabase', ...SUPABASE, SESSION_SECRET: DEMO_SESSION_SECRET }]
    ])('requires a real SESSION_SECRET with %s', (_, env) => {
        expect(failure(env)).toMatch(/^SESSION_SECRET .* is required/);
    });

    it('requires a real MOCK_PROVIDER_WEBHOOK_SECRET with DATABASE_URL (forged partner events otherwise)', () => {
        expect(failure(persistent({ MOCK_PROVIDER_WEBHOOK_SECRET: '' }))).toMatch(/^MOCK_PROVIDER_WEBHOOK_SECRET .* is required/);
        expect(failure(persistent({ MOCK_PROVIDER_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET }))).toMatch(/MOCK_PROVIDER_WEBHOOK_SECRET/);
        expect(load({ AUTH_PROVIDER: 'supabase', ...SUPABASE, SESSION_SECRET }).webhookSecret).toBe(DEMO_WEBHOOK_SECRET);
    });

    it('enables persona login only for the persona demo, never next to Supabase accounts', () => {
        expect(load({}).personaLogin).toBe(true);
        expect(load({ DEMO_ALLOW_PERSONA_LOGIN: 'false' }).personaLogin).toBe(false);
        const supabase = load({ AUTH_PROVIDER: 'supabase', DEMO_ALLOW_PERSONA_LOGIN: 'true', ...SUPABASE, SESSION_SECRET });
        expect(supabase.personaLogin).toBe(false);
        expect(load(persistent({ AUTH_PROVIDER: 'supabase', ...SUPABASE })).personaLogin).toBe(false);
    });
});

describe('configuration: persistence', () => {
    it('defaults DATABASE_ROLE to service_role whenever DATABASE_URL is set', () => {
        expect(load(persistent()).database).toMatchObject({ role: 'service_role', poolMax: 5 });
        expect(load(persistent({ DATABASE_ROLE: 'service_role' })).database!.role).toBe('service_role');
        expect(failure(persistent({ DATABASE_ROLE: 'postgres' }))).toContain('DATABASE_ROLE');
    });

    it('requires STORAGE_PROVIDER explicitly with DATABASE_URL; explicit memory is demo-only and logged', () => {
        expect(failure(persistent({ STORAGE_PROVIDER: '' }))).toMatch(/^STORAGE_PROVIDER must be set explicitly/);
        const warn = vi.spyOn(logger, 'warn');
        expect(load(persistent()).storage.provider).toBe('memory');
        expect(warn).toHaveBeenCalledWith('config.ephemeral_document_storage', expect.anything());
        warn.mockClear();
        expect(load(persistent({ STORAGE_PROVIDER: 'supabase', ...SUPABASE })).storage.provider).toBe('supabase');
        expect(load({}).storage.provider).toBe('memory');
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('configuration: database TLS', () => {
    it('requires DATABASE_SSL_CA for any non-local host, in every mode, without echoing the URL', () => {
        for (const url of [
            REMOTE_URL,
            'postgres://postgres:s3cret-pw@10.0.0.5/postgres',
            'postgresql://postgres:s3cret-pw@localhost/postgres?host=db.example.net'
        ]) {
            const message = failure(persistent({ DATABASE_URL: url }));
            expect(message).toMatch(/^DATABASE_SSL_CA .* is required for a non-local DATABASE_URL/);
            expect(message).not.toContain('s3cret-pw');
        }
        expect(load(persistent({ DATABASE_URL: REMOTE_URL, DATABASE_SSL_CA: CA })).database!.sslCa).toBe(`${CA}\n`);
    });

    it('accepts loopback hosts and Unix sockets without a CA', () => {
        for (const url of [
            'postgresql://postgres@localhost:5432/postgres',
            'postgresql://postgres@127.0.0.1/postgres?sslmode=disable',
            'postgresql://postgres@[::1]:5432/postgres',
            'postgresql://postgres@localhost/postgres?host=/tmp/pgsock&port=54329',
            'postgresql://%2Fvar%2Frun%2Fpostgresql/postgres',
            'postgresql://postgres@/postgres?host=/var/run/postgresql',
            'postgresql:///postgres'
        ]) {
            expect(load(persistent({ DATABASE_URL: url })).database).toMatchObject({ url, sslCa: undefined });
        }
    });

    it('refuses URL settings that disable TLS or certificate checks for a remote host', () => {
        for (const query of ['sslmode=disable', 'sslmode=no-verify', 'ssl=0', 'ssl=false']) {
            const message = failure(persistent({ DATABASE_URL: `${REMOTE_URL}?${query}`, DATABASE_SSL_CA: CA }));
            expect(message).toBe(`DATABASE_URL must not disable TLS or certificate verification (${query}) for a non-local database`);
        }
    });

    it('accepts the CA on one line with literal \\n sequences, and refuses anything but a PEM certificate', () => {
        const oneLine = CA.replace(/\n/g, '\\n');
        expect(load(persistent({ DATABASE_URL: REMOTE_URL, DATABASE_SSL_CA: oneLine })).database!.sslCa).toBe(`${CA}\n`);
        expect(failure(persistent({ DATABASE_URL: REMOTE_URL, DATABASE_SSL_CA: '/etc/ssl/prod-ca-2021.crt' }))).toMatch(
            /^DATABASE_SSL_CA must contain the PEM certificate itself/
        );
    });

    /** What node-postgres itself resolves for the pool's options (it merges the parsed URL over the explicit ones). */
    const resolvedSsl = (config: DatabaseConfig) =>
        (new pg.Client(pgConnectionOptions(config)) as unknown as Resolved).connectionParameters.ssl;
    type Resolved = { connectionParameters: { ssl: unknown } };

    it('verifies the server against the CA whatever TLS settings the URL carries', () => {
        for (const query of ['', '?ssl=0', '?ssl=true', '?sslmode=disable', '?sslmode=no-verify', '?sslmode=require&uselibpqcompat=true']) {
            for (const extra of ['', 'sslnegotiation=direct', 'sslrootcert=/nonexistent/ca.crt']) {
                const url = `${REMOTE_URL}${query}${extra ? `${query ? '&' : '?'}${extra}` : ''}`;
                expect([url, resolvedSsl({ url, role: 'service_role', poolMax: 1, sslCa: CA })]).toEqual([
                    url,
                    { ca: CA, rejectUnauthorized: true }
                ]);
            }
        }
        const local = 'postgresql://postgres@localhost/postgres?host=/tmp/pgsock';
        expect(pgConnectionOptions({ url: local, role: 'service_role', poolMax: 1 })).toEqual({ connectionString: local, ssl: undefined });
    });
});

describe('configuration: client IP header', () => {
    it('normalises the platform header name and refuses X-Forwarded-For or an invalid name', () => {
        expect(load({ CLIENT_IP_HEADER: ' Fly-Client-IP ' }).clientIpHeader).toBe('fly-client-ip');
        expect(load({}).clientIpHeader).toBeUndefined();
        expect(failure({ CLIENT_IP_HEADER: 'X-Forwarded-For' })).toMatch(/^CLIENT_IP_HEADER must name a single-value platform header/);
        expect(failure({ CLIENT_IP_HEADER: 'x real ip' })).toBe('Invalid configuration: CLIENT_IP_HEADER');
    });
});
