/**
 * Pool checkout shared by the Postgres adapters (unit of work, simulated partner store).
 *
 * pg-pool removes its idle 'error' listener while a client is checked out. A backend lost during the
 * checkout (failover, pooler restart, pg_terminate_backend, network reset) makes the client emit 'error':
 * with no listener, Node turns it into an uncaught exception, although the statement in flight is rejected
 * anyway. The listener below only records the error, so the client is destroyed instead of reused.
 * Node-only (pg): imported from server code exclusively.
 */
import 'server-only';
import type pg from 'pg';
import { logger } from '@/server/logger';

export interface Checkout {
    client: pg.PoolClient;
    /** Marks the connection unusable (e.g. a failed ROLLBACK): release() destroys it. */
    markBroken(error: Error): void;
    /** Detaches the error listener and returns the client to the pool (destroyed when broken). Call once. */
    release(): void;
}

export async function checkout(pool: pg.Pool, poolName: string): Promise<Checkout> {
    const client = await pool.connect();
    let broken: Error | undefined;
    // Only the SQLSTATE and message are logged, never connection details.
    const onError = (error: Error) => {
        broken ??= error;
        logger.error('db.client_error', { pool: poolName, code: (error as { code?: string }).code, message: error.message });
    };
    client.on('error', onError);
    return {
        client,
        markBroken: (error) => {
            broken ??= error;
        },
        release: () => {
            client.removeListener('error', onError);
            client.release(broken);
        }
    };
}
