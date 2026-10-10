/**
 * PostgreSQL persistence adapter (Supabase schema `trustcargo`, see supabase/migrations).
 *
 * Unit of work = one SQL transaction on a pooled connection:
 *   BEGIN → SET LOCAL ROLE <DATABASE_ROLE> → global transaction-scoped advisory lock (bounded wait of its
 *   own) → per-statement lock / statement timeouts → fn(db) → COMMIT (ROLLBACK on any error; the
 *   connection is always released, and destroyed when it reported an error).
 *
 * The global advisory lock deliberately reproduces the in-memory adapter's serialisation of units of
 * work, across processes and instances: the services' check-then-act logic (idempotency keys, held
 * balances, state guards) stays correct without per-row locking. Throughput is therefore bounded by
 * one unit of work at a time per database — a documented MVP limitation (see docs/PRODUCTION_READINESS.md).
 *
 * - A nested `run` in the same async context joins the outer transaction (as in memory).
 * - The whole unit of work is retried (up to 3 times) on serialization failure / deadlock
 *   (SQLSTATE 40001 / 40P01) only. External I/O must therefore not happen inside a unit of work.
 * - A failed statement aborts the transaction: errors raised by the database cannot be caught and
 *   ignored inside a unit of work (no service does; the whole unit of work is rolled back).
 * - Waiting behind other units of work is bounded by `globalLockWaitMs` (30 s), not by the per-statement
 *   lock_timeout. A wait or statement that still times out (SQLSTATE 55P03 / 57014) surfaces as the
 *   retryable AppError UNAVAILABLE (HTTP 503), never as an internal error.
 *
 * Node-only (pg): imported from server code exclusively.
 */
import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import type { DatabaseConfig } from '@/server/config';
import { AppError } from '@/server/errors';
import { logger } from '@/server/logger';
import type { Db, UnitOfWork } from '@/server/ports/db';
import type { Query } from './codecs';
import { checkout } from './pg-checkout';
import { createPgPool } from './pg-pool';
import { createPgDb } from './tables';

const UNIT_OF_WORK_LOCK = 'trustcargo.unit_of_work';
const MAX_RETRIES = 3;
const RETRYABLE = new Set(['40001', '40P01']);
/** lock_timeout / statement_timeout expired: the database is busy, the caller may retry later. */
const BUSY = new Set(['55P03', '57014']);
const POOL_NAME = 'trustcargo-pay';

export interface UnitOfWorkTimeouts {
    /** Wait for the global unit-of-work lock, i.e. for the units of work queued ahead (all instances). */
    globalLockWaitMs: number;
    /** Any other lock wait, once the global lock is held. */
    lockTimeoutMs: number;
    statementTimeoutMs: number;
}

export const DEFAULT_TIMEOUTS: UnitOfWorkTimeouts = { globalLockWaitMs: 30_000, lockTimeoutMs: 10_000, statementTimeoutMs: 20_000 };

export class PostgresDatabase implements UnitOfWork {
    private readonly pool: pg.Pool;
    private readonly context = new AsyncLocalStorage<Db>();
    private readonly timeouts: UnitOfWorkTimeouts;

    /** `timeouts` overrides the defaults (tests use short ones). */
    constructor(
        private readonly config: DatabaseConfig,
        timeouts: Partial<UnitOfWorkTimeouts> = {}
    ) {
        this.pool = createPgPool(config, { max: config.poolMax, applicationName: POOL_NAME });
        this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    }

    async run<T>(fn: (db: Db) => Promise<T>): Promise<T> {
        const current = this.context.getStore();
        if (current) return fn(current);
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.attempt(fn);
            } catch (error) {
                const code = (error as { code?: string }).code;
                if (code && RETRYABLE.has(code) && attempt < MAX_RETRIES) {
                    logger.warn('db.unit_of_work_retry', { code, attempt: attempt + 1 });
                    continue;
                }
                if (code && BUSY.has(code)) {
                    logger.warn('db.unit_of_work_busy', { code });
                    throw new AppError('UNAVAILABLE', 'The service is temporarily busy. Please retry.', { retryable: true });
                }
                throw error;
            }
        }
    }

    private async attempt<T>(fn: (db: Db) => Promise<T>): Promise<T> {
        const { client, markBroken, release } = await checkout(this.pool, POOL_NAME);
        // Services issue reads in parallel (Promise.all) inside one unit of work: one transaction means
        // one connection, so statements are queued here instead of overlapping on the client.
        let queue: Promise<unknown> = Promise.resolve();
        const query: Query = (text, values) => {
            const next = queue.then(() => client.query(text, values));
            queue = next.catch(() => undefined);
            return next;
        };
        const { globalLockWaitMs, lockTimeoutMs, statementTimeoutMs } = this.timeouts;
        try {
            await query('begin', []);
            // While queued for the global lock, only its own bounded wait applies (the statement timeout is set
            // just above it so that lock_timeout decides). set_config(…, true) = SET LOCAL; the role name is a
            // parameter, never interpolated.
            await query(
                `select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
                        set_config('trustcargo.app_managed_updated_at', 'on', true)` +
                    (this.config.role ? ", set_config('role', $3, true)" : ''),
                [`${globalLockWaitMs}ms`, `${globalLockWaitMs + 5_000}ms`, ...(this.config.role ? [this.config.role] : [])]
            );
            await query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [UNIT_OF_WORK_LOCK]);
            // Lock held: the normal per-statement limits apply to the unit of work itself.
            await query("select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [
                `${lockTimeoutMs}ms`,
                `${statementTimeoutMs}ms`
            ]);
            const db = createPgDb(query, (name) => this.nextSequence(query, name));
            const result = await this.context.run(db, () => fn(db));
            await query('commit', []);
            return result;
        } catch (error) {
            try {
                await queue; // statements still in flight (e.g. siblings of a failed Promise.all)
                await client.query('rollback');
            } catch (rollbackError) {
                markBroken(rollbackError as Error); // the connection is unusable: destroy it
            }
            throw error;
        } finally {
            release();
        }
    }

    /** 'audit' follows the audit chain (under the unit-of-work lock); other names use gap-free counters. */
    private async nextSequence(query: Query, name: string): Promise<number> {
        const result =
            name === 'audit'
                ? await query('select coalesce(max(sequence), 0) + 1 as value from trustcargo.audit_events', [])
                : await query(
                      `insert into trustcargo_private.counters as c (name, value) values ($1, 1)
                       on conflict (name) do update set value = c.value + 1 returning value`,
                      [name]
                  );
        return Number(result.rows[0]!.value);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
