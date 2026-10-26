// Fonction planifiée purge-storage : lots, reprise après panne, journal sans chemin.
import { afterEach, describe, expect, it } from 'vitest';
import { setServerLogSink } from '../../supabase/functions/_shared/log';
import type { ScheduledContext } from '../../supabase/functions/_shared/scheduled';
import { handlePurgeStorage, PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from '../../supabase/functions/_shared/storage-purge';

const FILE = 'f0000000-0000-4000-8000-000000000001';

/** File d'effacement simulée : storage_purge_claim rend des lots, storage_purge_done retire les lignes. */
function context(options: { queued: number; failOnBatch?: number; prepared?: unknown }) {
    let queue = Array.from({ length: options.queued }, (_, i) => ({ id: i + 1, object_path: `${FILE}/doc-${i + 1}` }));
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const removed: string[][] = [];
    const ctx: ScheduledContext = {
        serviceRpc: async <T>(fn: string, args: Record<string, unknown>) => {
            calls.push({ fn, args });
            if (fn === 'storage_purge_prepare') return (options.prepared ?? { expired_uploads: 1, orphans: 2 }) as T;
            if (fn === 'storage_purge_claim') return queue.slice(0, args.p_limit as number) as T;
            if (fn === 'storage_purge_done') {
                const ids = args.p_ids as number[];
                queue = queue.filter((row) => !ids.includes(row.id));
                return ids.length as T;
            }
            throw new Error(`unexpected ${fn}`);
        },
        removeFiles: async (paths) => {
            if (removed.length + 1 === options.failOnBatch) throw Object.assign(new Error(`down ${paths[0]}`), { name: 'StorageError' });
            removed.push(paths);
        },
        email: null,
        appUrl: 'https://relais.example',
        now: () => new Date('2026-11-02T12:00:00Z')
    };
    return { ctx, calls, removed, remaining: () => queue.length };
}

afterEach(() => setServerLogSink(null));

describe('purge-storage', () => {
    it('efface par lots, puis retire les inscriptions', async () => {
        const { ctx, calls, removed, remaining } = context({ queued: PURGE_BATCH_SIZE + 5 });
        const response = await handlePurgeStorage(ctx);
        expect(response).toEqual({
            status: 200,
            body: { expired_uploads: 1, orphans: 2, removed: PURGE_BATCH_SIZE + 5, failed: 0 }
        });
        expect(removed.map((batch) => batch.length)).toEqual([PURGE_BATCH_SIZE, 5]);
        expect(calls[0]!.fn).toBe('storage_purge_prepare');
        expect(calls.filter((c) => c.fn === 'storage_purge_done')).toHaveLength(2);
        expect(remaining()).toBe(0);
    });

    it('file vide : préparation seulement, rien à effacer', async () => {
        const { ctx, calls, removed } = context({ queued: 0, prepared: { expired_uploads: 0, orphans: 0 } });
        expect((await handlePurgeStorage(ctx)).body).toEqual({ expired_uploads: 0, orphans: 0, removed: 0, failed: 0 });
        expect(calls.map((c) => c.fn)).toEqual(['storage_purge_prepare', 'storage_purge_claim']);
        expect(removed).toEqual([]);
    });

    it('panne de Storage : le lot reste inscrit, la suite attend ; journal sans chemin', async () => {
        const logs: Array<Record<string, string | number>> = [];
        setServerLogSink((entry) => logs.push(entry));
        const { ctx, calls, remaining } = context({ queued: PURGE_BATCH_SIZE * 2, failOnBatch: 2 });
        const response = await handlePurgeStorage(ctx);
        expect(response.body).toMatchObject({ removed: PURGE_BATCH_SIZE, failed: PURGE_BATCH_SIZE });
        expect(calls.filter((c) => c.fn === 'storage_purge_done')).toHaveLength(1);
        expect(remaining()).toBe(PURGE_BATCH_SIZE);
        expect(logs.map((l) => [l.event, l.count])).toEqual([
            ['storage_purge_failed', PURGE_BATCH_SIZE],
            ['storage_purged', PURGE_BATCH_SIZE]
        ]);
        expect(JSON.stringify(logs)).not.toContain(FILE);
    });

    it('au plus 10 lots par exécution', async () => {
        const { ctx, removed, remaining } = context({ queued: PURGE_BATCH_SIZE * (PURGE_MAX_BATCHES + 2) });
        expect((await handlePurgeStorage(ctx)).body).toMatchObject({ removed: PURGE_BATCH_SIZE * PURGE_MAX_BATCHES });
        expect(removed).toHaveLength(PURGE_MAX_BATCHES);
        expect(remaining()).toBe(PURGE_BATCH_SIZE * 2);
    });

    it('réponse inattendue de la base : refusée', async () => {
        const { ctx, removed } = context({ queued: 3, prepared: { expired_uploads: -1, orphans: 0 } });
        await expect(handlePurgeStorage(ctx)).rejects.toThrow();
        expect(removed).toEqual([]);
    });
});
