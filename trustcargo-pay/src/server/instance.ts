import 'server-only';
import { createApp, type App } from './app';
import { loadConfig } from './config';
import { seedDemoScenarios, seedReferenceData } from './demo/seed';
import { AppError } from './errors';

/**
 * Process-wide application instance.
 * - In-memory persistence: state lives in this process only (run the demo as one long-lived Node
 *   server); the database is seeded on first use.
 * - Postgres: reference data and the fictitious demo scenarios are seeded only on the first boot of an
 *   empty database (no users), and never in production mode (reference data is provisioned there).
 */
const globalForApp = globalThis as unknown as { __trustcargo?: Promise<App> };

/** First boot only: seeds an empty database (no users), never in production. Returns whether it seeded. */
export async function seedIfEmpty(app: App): Promise<boolean> {
    if (app.config.mode === 'production') return false;
    const empty = (await app.deps.uow.run((db) => db.users.list({ limit: 1 }))).length === 0;
    if (!empty) return false;
    await seedReferenceData(app);
    if (app.config.mode === 'demo') await seedDemoScenarios(app);
    return true;
}

async function init(): Promise<App> {
    const app = createApp(loadConfig());
    try {
        await seedIfEmpty(app);
    } catch (error) {
        await app.persistence.close();
        throw error;
    }
    return app;
}

export function getApp(): Promise<App> {
    globalForApp.__trustcargo ??= init().catch((error) => {
        globalForApp.__trustcargo = undefined;
        throw error;
    });
    return globalForApp.__trustcargo;
}

/**
 * Demo only: discards all state and re-seeds. Refused with Postgres persistence: the audit chain,
 * ledger and provider events are append-only by design and cannot be wiped by the application.
 */
export async function resetDemo(): Promise<void> {
    const app = await getApp();
    if (app.persistence.kind === 'postgres') {
        throw new AppError(
            'PRECONDITION_FAILED',
            'Demo reset is not available with Postgres persistence: append-only records are immutable'
        );
    }
    globalForApp.__trustcargo = undefined;
    await app.persistence.close();
    await getApp();
}
