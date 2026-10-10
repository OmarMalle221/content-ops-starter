import 'server-only';
import { createApp, type App } from './app';
import { SYSTEM } from './auth/actor';
import { loadConfig } from './config';
import { seedDemoPersonas, seedDemoScenarios, seedPlatformReferenceData } from './demo/seed';
import { AppError } from './errors';
import { logger } from './logger';
import { audit } from './services/context';

/**
 * Process-wide application instance.
 * - In-memory persistence: state lives in this process only (run the demo as one long-lived Node
 *   server); the database is seeded on first use.
 * - Postgres: the seed runs only on the first boot of an empty database, never in production mode
 *   (reference data is provisioned there).
 */
const globalForApp = globalThis as unknown as { __trustcargo?: Promise<App> };

/** Written by the first-boot seed in its own transaction: present ⇔ the seed completed. */
const SEED_MARKER = { action: 'system.seed_completed', entityType: 'system', entityId: 'first_boot_seed' };

/** The application must not serve this database with this configuration. */
export class BootRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BootRefusedError';
    }
}

const RECREATE_HINT =
    'Recreate the TrustCargo schemas (drop trustcargo, trustcargo_private and trustcargo_sim, then re-apply supabase/migrations: docs/DEPLOYMENT.md).';

/**
 * Boot checks and first-boot seed, in ONE long-running unit of work: on Postgres a single SQL transaction under the
 * global lock, so an interrupted seed rolls back entirely and a concurrent instance waits for it, then finds the
 * marker. The simulated partner's own records are written outside it by design (it stands for an external system):
 * an interrupted seed may leave some behind, simulation-only and harmless, like unreferenced demo document objects.
 *
 * - A database is either a persona demo (AUTH_PROVIDER=demo) or real accounts (AUTH_PROVIDER=supabase), never
 *   both: persona sessions would otherwise reach real accounts' data.
 * - Marker present: nothing to do. No marker and an empty database: seed (demo mode only) — platform reference
 *   data, plus the personas and scenarios for a persona demo — and write the marker last. No marker but data: an
 *   interrupted seed or foreign data, refused rather than served half-seeded.
 *
 * Returns whether it seeded.
 */
export async function seedIfEmpty(app: App): Promise<boolean> {
    const personaDemo = app.config.auth.provider === 'demo';
    return app.deps.uow.run(
        async (db) => {
            if (await db.users.findOne({ isDemo: !personaDemo })) {
                throw new BootRefusedError(
                    personaDemo
                        ? 'AUTH_PROVIDER=demo refuses this database: it holds real accounts (is_demo = false), which persona sessions would expose. Use AUTH_PROVIDER=supabase with it, or a separate database for the persona demo.'
                        : 'AUTH_PROVIDER=supabase refuses this database: it is a persona demo, and real accounts never share a database with demo personas. Use a separate database.'
                );
            }
            if (app.config.mode === 'production') return false;
            if (await db.auditEvents.findOne(SEED_MARKER)) return false;
            // What the seed writes (the security settings row is not a sign: the migration creates it on Postgres).
            const tables = [db.users, db.corridors, db.providerConnections];
            const empty = (await Promise.all(tables.map((t) => t.list({ limit: 1 })))).every((rows) => rows.length === 0);
            if (!empty) {
                throw new BootRefusedError(
                    `The database holds TrustCargo data but no completed first-boot seed (interrupted seed, or data from an older version). ${RECREATE_HINT}`
                );
            }
            await seedPlatformReferenceData(app);
            if (personaDemo) {
                await seedDemoPersonas(app);
                // The scenarios upload their demo documents from inside this unit of work, by design: those Storage
                // uploads (Supabase with STORAGE_PROVIDER=supabase) run under the global lock, the one exception to
                // "no external I/O in a unit of work" (docs/ARCHITECTURE.md), and a seed rolled back after them leaves
                // their objects behind.
                await seedDemoScenarios(app);
            }
            const marker = { type: SEED_MARKER.entityType, id: SEED_MARKER.entityId };
            await audit(app.deps, db, SYSTEM, SEED_MARKER.action, marker, { metadata: { personas: personaDemo } });
            return true;
        },
        { longRunning: true }
    );
}

async function init(): Promise<App> {
    const app = createApp(loadConfig());
    try {
        await seedIfEmpty(app);
    } catch (error) {
        // Only our own refusal messages are logged in full (they hold no data); otherwise the error name and SQLSTATE.
        logger.error('app.boot_failed', {
            error: error instanceof Error ? error.name : 'unknown',
            code: (error as { code?: string }).code,
            reason: error instanceof BootRefusedError ? error.message : undefined
        });
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
