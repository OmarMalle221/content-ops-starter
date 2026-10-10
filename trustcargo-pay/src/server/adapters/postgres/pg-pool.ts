/**
 * Connection pools for the Postgres adapters (unit of work, simulated partner store): same TLS settings,
 * per-pool type parsers and error handling. Node-only (pg): imported from server code exclusively.
 */
import 'server-only';
import pg from 'pg';
import { parseDatabaseUrl, URL_TLS_PARAMS, type DatabaseConfig } from '@/server/config';
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

/**
 * With DATABASE_SSL_CA, TLS is always on and the server certificate is verified against that CA: the URL is parsed by
 * the same function as in loadConfig (pg-connection-string, TLS parameters dropped so they cannot downgrade it) and
 * handed to pg as explicit options, so pg connects to exactly the host loadConfig checked and never re-reads the URL.
 * loadConfig requires the CA for any non-local host; without it (loopback only) pg reads the URL itself, with the
 * same parser. Errors never echo the URL (it may contain a password).
 */
export function pgConnectionOptions(config: DatabaseConfig): pg.PoolConfig {
    if (!config.sslCa) return { connectionString: config.url, ssl: undefined };
    const { connection } = parseDatabaseUrl(config.url, { withoutTls: true });
    const options: Record<string, unknown> = { ...connection };
    for (const key of URL_TLS_PARAMS) delete options[key];
    return { ...(options as pg.PoolConfig), ssl: { ca: config.sslCa, rejectUnauthorized: true } };
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
