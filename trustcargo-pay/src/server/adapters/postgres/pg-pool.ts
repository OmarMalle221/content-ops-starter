/**
 * Connection pools for the Postgres adapters (unit of work, simulated partner store): same TLS settings,
 * per-pool type parsers and error handling. Node-only (pg): imported from server code exclusively.
 */
import 'server-only';
import pg from 'pg';
import type { DatabaseConfig } from '@/server/config';
import { logger } from '@/server/logger';

const INT8 = 20;
const DATE = 1082;

/**
 * Per-pool type parsers (the global pg types are left untouched): int8 → bigint (exact money amounts),
 * date → raw 'YYYY-MM-DD' string (no timezone shift). timestamptz keeps pg's Date parser.
 */
const typeParsers: pg.CustomTypesConfig = {
    getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
        if (oid === INT8 && format !== 'binary') return (value: string) => BigInt(value);
        if (oid === DATE && format !== 'binary') return (value: string) => value;
        return pg.types.getTypeParser(oid, format);
    }) as pg.CustomTypesConfig['getTypeParser']
};

/** With an explicit CA, TLS settings in the URL (sslmode, sslrootcert...) would override ours: drop them. */
function connectionString(config: DatabaseConfig): string {
    if (!config.sslCa) return config.url;
    const url = new URL(config.url);
    for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat']) url.searchParams.delete(key);
    return url.toString();
}

export function createPgPool(config: DatabaseConfig, options: { max: number; applicationName: string }): pg.Pool {
    const pool = new pg.Pool({
        connectionString: connectionString(config),
        max: options.max,
        ssl: config.sslCa ? { ca: config.sslCa, rejectUnauthorized: true } : undefined,
        application_name: options.applicationName,
        types: typeParsers
    });
    // An idle client can fail (server restart, network): log it instead of crashing the process.
    // Only the SQLSTATE and message are logged, never connection details.
    pool.on('error', (error) =>
        logger.error('db.pool_error', {
            pool: options.applicationName,
            code: (error as { code?: string }).code,
            message: error.message
        })
    );
    return pool;
}
