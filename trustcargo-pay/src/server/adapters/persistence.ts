/**
 * Persistence selection. The services only see the `UnitOfWork` port; this is the single place that
 * decides which adapter backs it.
 */
import type { ServerConfig } from '@/server/config';
import type { UnitOfWork } from '@/server/ports/db';
import { MemoryDatabase } from './memory/memory-db';

export interface Persistence {
    kind: 'memory' | 'postgres';
    uow: UnitOfWork;
    /** Releases pooled connections (no-op in memory). */
    close(): Promise<void>;
}

export function createPersistence(config: ServerConfig): Persistence {
    if (config.database) {
        throw new Error('The Postgres persistence adapter is not wired yet');
    }
    return { kind: 'memory', uow: new MemoryDatabase(), close: async () => undefined };
}
