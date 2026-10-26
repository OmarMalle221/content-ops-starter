// Purge planifiée de Storage (fonction purge-storage, appelée toutes les heures par pg_cron). La base
// décide quoi effacer (storage_purge_prepare : file d'effacement, dépôts abandonnés, fichiers orphelins) ;
// la fonction efface les fichiers par lots, puis retire leurs inscriptions. Un lot en échec reste inscrit et
// sera repris à l'exécution suivante. Le journal ne garde que des compteurs, jamais un chemin.
import { z } from 'zod';
import { serverLog } from './log.ts';
import type { ScheduledHandler } from './scheduled.ts';

export const PURGE_BATCH_SIZE = 100;
export const PURGE_MAX_BATCHES = 10;

const prepared = z.object({ expired_uploads: z.number().int().min(0), orphans: z.number().int().min(0) });
const claimed = z.array(z.object({ id: z.number().int(), object_path: z.string().min(1) }));

export const handlePurgeStorage: ScheduledHandler = async (ctx) => {
    const found = prepared.parse(await ctx.serviceRpc<unknown>('storage_purge_prepare', {}));
    let removed = 0;
    let failed = 0;
    for (let batch = 0; batch < PURGE_MAX_BATCHES; batch += 1) {
        const rows = claimed.parse(await ctx.serviceRpc<unknown>('storage_purge_claim', { p_limit: PURGE_BATCH_SIZE }));
        if (rows.length === 0) break;
        try {
            await ctx.removeFiles(rows.map((row) => row.object_path));
        } catch (error) {
            failed += rows.length;
            serverLog('storage_purge_failed', { count: rows.length, errorName: error instanceof Error ? error.name : 'unknown' });
            break; // Storage indisponible : la suite attend l'exécution suivante
        }
        await ctx.serviceRpc('storage_purge_done', { p_ids: rows.map((row) => row.id) });
        removed += rows.length;
        if (rows.length < PURGE_BATCH_SIZE) break;
    }
    serverLog('storage_purged', { count: removed });
    return {
        status: 200,
        body: { expired_uploads: found.expired_uploads, orphans: found.orphans, removed, failed }
    };
};
