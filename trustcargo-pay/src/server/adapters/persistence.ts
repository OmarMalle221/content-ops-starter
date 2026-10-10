/**
 * Persistence selection. The services only see the `UnitOfWork` port; this is the single place that
 * decides which adapter backs it: Postgres when DATABASE_URL is set, otherwise the in-memory adapter.
 *
 * The same choice applies to the records of the SIMULATED payment partner (MockPaymentProvider): in
 * memory, or in schema `trustcargo_sim` of the same database through a separate small pool. Those are the
 * fake partner's records, never TrustCargo's books, and they are never written inside a unit of work.
 */
import type { ServerConfig } from '@/server/config';
import type { UnitOfWork } from '@/server/ports/db';
import { MemoryDatabase } from './memory/memory-db';
import { MemorySimulatedPartnerStore, type SimulatedPartnerStore } from './mock/simulated-partner-store';
import { PostgresDatabase } from './postgres/pg-database';
import { PostgresSimulatedPartnerStore } from './postgres/pg-simulated-partner-store';

export interface Persistence {
    kind: 'memory' | 'postgres';
    uow: UnitOfWork;
    /** SIMULATION ONLY: state of the fake payment partner (survives restarts with Postgres). */
    simulatedPartner: SimulatedPartnerStore;
    /** Releases pooled connections, the simulated partner's included (no-op in memory). */
    close(): Promise<void>;
}

export function createPersistence(config: ServerConfig): Persistence {
    if (config.database) {
        const db = new PostgresDatabase(config.database);
        const simulatedPartner = new PostgresSimulatedPartnerStore(config.database);
        return {
            kind: 'postgres',
            uow: db,
            simulatedPartner,
            close: async () => {
                const results = await Promise.allSettled([db.close(), simulatedPartner.close()]);
                const failed = results.find((r) => r.status === 'rejected');
                if (failed) throw failed.reason;
            }
        };
    }
    return { kind: 'memory', uow: new MemoryDatabase(), simulatedPartner: new MemorySimulatedPartnerStore(), close: async () => undefined };
}
