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

/** URL parameters pg turns into TLS settings; it merges them OVER the explicit `ssl` option (e.g. `ssl=0` → no TLS). */
const URL_TLS_PARAMS = ['ssl', 'sslmode', 'sslnegotiation', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat'];

/**
 * With DATABASE_SSL_CA, TLS is always on and the server certificate is verified against that CA: the URL's TLS
 * parameters are dropped so they cannot downgrade it. loadConfig requires the CA for any non-local host; without it
 * (loopback or Unix socket only) the URL is used as is.
 */
export function pgConnectionOptions(config: DatabaseConfig): Pick<pg.PoolConfig, 'connectionString' | 'ssl'> {
    if (!config.sslCa) return { connectionString: config.url, ssl: undefined };
    const url = new URL(config.url);
    for (const key of URL_TLS_PARAMS) url.searchParams.delete(key);
    return { connectionString: url.toString(), ssl: { ca: config.sslCa, rejectUnauthorized: true } };
}

export function createPgPool(config: DatabaseConfig, options: { max: number; applicationName: string }): pg.Pool {
    const pool = new pg.Pool({
        ...pgConnectionOptions(config),
        max: options.max,
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
