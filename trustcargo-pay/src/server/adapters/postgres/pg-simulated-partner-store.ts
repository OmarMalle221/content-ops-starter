/**
 * Postgres store of the SIMULATED payment partner — SIMULATION ONLY (schema `trustcargo_sim`, migration
 * 20261010000001_simulated_partner.sql). The fake partner's own records, never TrustCargo's books.
 *
 * The fake partner stands for an external system, so its writes never join a TrustCargo unit of work:
 * - it has its own small connection pool (no AsyncLocalStorage, no shared client);
 * - every operation is one short SQL transaction (BEGIN → SET LOCAL role / timeouts → statements →
 *   COMMIT), committed before the simulator emits any webhook. A unit of work that rolls back leaves the
 *   partner's records in place, as a real partner's would be.
 * - it takes no advisory lock: idempotency relies on the unique idempotency keys (INSERT … ON CONFLICT DO
 *   NOTHING, then read the stored row), which is safe across instances.
 *
 * Node-only (pg): imported from server code exclusively.
 */
import 'server-only';
import type pg from 'pg';
import type { CurrencyCode } from '@/domain/money';
import type { DatabaseConfig } from '@/server/config';
import { ProviderError, type FundingStatus, type ProviderPayoutStatus, type StatementLine } from '@/server/ports/payment-provider';
import type { SimulatedInstruction, SimulatedPartnerStore, SimulatedTransfer, TransferKind } from '../mock/simulated-partner-store';
import { checkout } from './pg-checkout';
import { createPgPool } from './pg-pool';

const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '10s';
/** The simulator issues one short call at a time per request: a couple of connections are enough. */
const POOL_MAX = 2;
const POOL_NAME = 'trustcargo-pay-simulated-partner';

type Client = Pick<pg.PoolClient, 'query'>;
type Row = Record<string, unknown>;

const INSTRUCTION_COLUMNS = 'reference, idempotency_key, amount_minor, currency, status';
const TRANSFER_COLUMNS = 'reference, kind, idempotency_key, amount_minor, currency, status';

const toInstruction = (row: Row): SimulatedInstruction => ({
    reference: row.reference as string,
    idempotencyKey: row.idempotency_key as string,
    amount: { amountMinor: row.amount_minor as bigint, currency: row.currency as CurrencyCode },
    status: row.status as FundingStatus
});

const toTransfer = (row: Row): SimulatedTransfer => ({
    reference: row.reference as string,
    kind: row.kind as TransferKind,
    idempotencyKey: row.idempotency_key as string,
    amount: { amountMinor: row.amount_minor as bigint, currency: row.currency as CurrencyCode },
    status: row.status as ProviderPayoutStatus
});

const toStatementLine = (row: Row): StatementLine => ({
    externalReference: row.external_reference as string,
    kind: row.kind as StatementLine['kind'],
    amountMinor: (row.amount_minor as bigint).toString(),
    currency: row.currency as string,
    occurredAt: (row.occurred_at as Date).toISOString()
});

export class PostgresSimulatedPartnerStore implements SimulatedPartnerStore {
    private readonly pool: pg.Pool;

    constructor(private readonly config: DatabaseConfig) {
        this.pool = createPgPool(config, { max: Math.min(POOL_MAX, config.poolMax), applicationName: POOL_NAME });
    }

    /** One short transaction on a dedicated connection; the client is always released (destroyed if broken). */
    private async transaction<T>(fn: (client: Client) => Promise<T>): Promise<T> {
        const { client, markBroken, release } = await checkout(this.pool, POOL_NAME);
        try {
            await client.query('begin');
            // set_config(…, true) = SET LOCAL; the role name is a parameter, never interpolated.
            await client.query(
                `select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)` +
                    (this.config.role ? ", set_config('role', $3, true)" : ''),
                this.config.role ? [LOCK_TIMEOUT, STATEMENT_TIMEOUT, this.config.role] : [LOCK_TIMEOUT, STATEMENT_TIMEOUT]
            );
            const result = await fn(client);
            await client.query('commit');
            return result;
        } catch (error) {
            try {
                await client.query('rollback');
            } catch (rollbackError) {
                markBroken(rollbackError as Error); // the connection is unusable: destroy it
            }
            throw error;
        } finally {
            release();
        }
    }

    private async appendLine(client: Client, line: StatementLine): Promise<void> {
        await client.query(
            `insert into trustcargo_sim.statement_lines (external_reference, kind, amount_minor, currency, occurred_at)
             values ($1, $2, $3, $4, $5)`,
            [line.externalReference, line.kind, BigInt(line.amountMinor).toString(), line.currency, line.occurredAt]
        );
    }

    async createInstruction(instruction: SimulatedInstruction): Promise<SimulatedInstruction> {
        return this.transaction(async (client) => {
            // Waits for a concurrent insert of the same key; DO NOTHING then reads the row that won.
            const inserted = await client.query(
                `insert into trustcargo_sim.instructions (reference, idempotency_key, amount_minor, currency, status)
                 values ($1, $2, $3, $4, $5)
                 on conflict (idempotency_key) do nothing
                 returning ${INSTRUCTION_COLUMNS}`,
                [
                    instruction.reference,
                    instruction.idempotencyKey,
                    instruction.amount.amountMinor.toString(),
                    instruction.amount.currency,
                    instruction.status
                ]
            );
            const row =
                inserted.rows[0] ??
                (
                    await client.query(`select ${INSTRUCTION_COLUMNS} from trustcargo_sim.instructions where idempotency_key = $1`, [
                        instruction.idempotencyKey
                    ])
                ).rows[0];
            return toInstruction(row);
        });
    }

    async getInstruction(reference: string): Promise<SimulatedInstruction | undefined> {
        return this.transaction(async (client) => {
            const result = await client.query(`select ${INSTRUCTION_COLUMNS} from trustcargo_sim.instructions where reference = $1`, [
                reference
            ]);
            return result.rows[0] ? toInstruction(result.rows[0]) : undefined;
        });
    }

    async setInstructionStatus(reference: string, status: FundingStatus, statementLine?: StatementLine): Promise<void> {
        await this.transaction(async (client) => {
            const result = await client.query(
                'update trustcargo_sim.instructions set status = $2, updated_at = now() where reference = $1',
                [reference, status]
            );
            if (result.rowCount !== 1) throw new ProviderError('Unknown instruction', false);
            if (statementLine) await this.appendLine(client, statementLine);
        });
    }

    async createTransfer(transfer: SimulatedTransfer): Promise<SimulatedTransfer> {
        return this.transaction(async (client) => {
            const inserted = await client.query(
                `insert into trustcargo_sim.transfers (reference, kind, idempotency_key, amount_minor, currency, status)
                 values ($1, $2, $3, $4, $5, $6)
                 on conflict (idempotency_key) do nothing
                 returning ${TRANSFER_COLUMNS}`,
                [
                    transfer.reference,
                    transfer.kind,
                    transfer.idempotencyKey,
                    transfer.amount.amountMinor.toString(),
                    transfer.amount.currency,
                    transfer.status
                ]
            );
            const row =
                inserted.rows[0] ??
                (
                    await client.query(`select ${TRANSFER_COLUMNS} from trustcargo_sim.transfers where idempotency_key = $1`, [
                        transfer.idempotencyKey
                    ])
                ).rows[0];
            return toTransfer(row);
        });
    }

    async getTransfer(reference: string): Promise<SimulatedTransfer | undefined> {
        return this.transaction(async (client) => {
            const result = await client.query(`select ${TRANSFER_COLUMNS} from trustcargo_sim.transfers where reference = $1`, [reference]);
            return result.rows[0] ? toTransfer(result.rows[0]) : undefined;
        });
    }

    async setTransferStatus(reference: string, status: ProviderPayoutStatus, statementLine?: StatementLine): Promise<void> {
        await this.transaction(async (client) => {
            const result = await client.query('update trustcargo_sim.transfers set status = $2, updated_at = now() where reference = $1', [
                reference,
                status
            ]);
            if (result.rowCount !== 1) throw new ProviderError('Unknown transfer', false);
            if (statementLine) await this.appendLine(client, statementLine);
        });
    }

    async listTransfers(): Promise<SimulatedTransfer[]> {
        return this.transaction(async (client) =>
            (await client.query(`select ${TRANSFER_COLUMNS} from trustcargo_sim.transfers order by id`)).rows.map(toTransfer)
        );
    }

    async appendStatementLine(line: StatementLine): Promise<void> {
        await this.transaction((client) => this.appendLine(client, line));
    }

    async statement(range: { from: string; to: string }): Promise<StatementLine[]> {
        return this.transaction(async (client) =>
            (
                await client.query(
                    `select external_reference, kind, amount_minor, currency, occurred_at from trustcargo_sim.statement_lines
                     where occurred_at >= $1::timestamptz and occurred_at <= $2::timestamptz order by id`,
                    [range.from, range.to]
                )
            ).rows.map(toStatementLine)
        );
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
