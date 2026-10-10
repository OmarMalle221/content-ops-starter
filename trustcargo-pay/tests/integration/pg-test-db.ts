/**
 * Per-test PostgreSQL databases for the integration suite (scripts/test-integration-pg.sh).
 *
 * TEST_PG_ADMIN_URL    superuser connection to the server (maintenance database)
 * TEST_PG_TEMPLATE_DB  database holding the Supabase shim + migrations, cloned for every test app
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { onTestFinished } from 'vitest';

export const usePostgres = Boolean(process.env.TEST_PG_ADMIN_URL);

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function adminUrl(): string {
    const url = process.env.TEST_PG_ADMIN_URL;
    if (!url) throw new Error('TEST_PG_ADMIN_URL is not set');
    return url;
}

/** URL of database `name` on the admin server (same credentials and options). */
export function databaseUrl(name: string, options?: Record<string, string>): string {
    const url = new URL(adminUrl());
    url.pathname = `/${name}`;
    for (const [k, v] of Object.entries(options ?? {})) url.searchParams.set(k, v);
    return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl() });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

export interface TestDatabase {
    name: string;
    url: string;
    drop(): Promise<void>;
}

/** Creates an empty, migrated database (clone of the template). Identifiers are generated, never input. */
export async function createTestDatabase(): Promise<TestDatabase> {
    const template = process.env.TEST_PG_TEMPLATE_DB ?? 'trustcargo_template';
    if (!IDENTIFIER.test(template)) throw new Error('TEST_PG_TEMPLATE_DB must be a plain identifier');
    const name = `trustcargo_t_${randomBytes(6).toString('hex')}`;
    await admin((c) => c.query(`create database ${name} template ${template}`));
    return {
        name,
        url: databaseUrl(name),
        drop: () => admin((c) => c.query(`drop database if exists ${name} with (force)`)).then(() => undefined)
    };
}

/**
 * Records uncaught exceptions and unhandled rejections raised while the current test runs (the listeners are
 * removed when it finishes). A lost database connection must never surface as one.
 */
export function captureProcessErrors(): unknown[] {
    const seen: unknown[] = [];
    const record = (error: unknown) => void seen.push(error);
    process.on('uncaughtException', record);
    process.on('unhandledRejection', record);
    onTestFinished(() => {
        process.off('uncaughtException', record);
        process.off('unhandledRejection', record);
    });
    return seen;
}

/** Polls `probe` until it returns a value (or fails after `timeoutMs`). */
export async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}
