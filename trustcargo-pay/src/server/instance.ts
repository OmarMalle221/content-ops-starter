import 'server-only';
import { createApp, type App } from './app';
import { loadConfig } from './config';
import { seedDemoScenarios, seedReferenceData } from './demo/seed';

/**
 * Process-wide application instance. In demo mode the in-memory database is seeded on first use.
 * NOTE: state lives in this process only — run the demo as a single long-lived Node server.
 */
const globalForApp = globalThis as unknown as { __trustcargo?: Promise<App> };

async function init(): Promise<App> {
    const app = createApp(loadConfig());
    await seedReferenceData(app);
    if (app.config.mode === 'demo') await seedDemoScenarios(app);
    return app;
}

export function getApp(): Promise<App> {
    globalForApp.__trustcargo ??= init().catch((error) => {
        globalForApp.__trustcargo = undefined;
        throw error;
    });
    return globalForApp.__trustcargo;
}

/** Demo only: discards all state and re-seeds. */
export async function resetDemo(): Promise<void> {
    globalForApp.__trustcargo = undefined;
    await getApp();
}
