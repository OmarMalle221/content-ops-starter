import { createApp, type App } from '@/server/app';
import { loadConfig } from '@/server/config';
import { personaActor, seedReferenceData } from '@/server/demo/seed';
import type { Actor } from '@/server/auth/actor';

export async function createTestApp(): Promise<App> {
    const app = createApp(
        loadConfig({
            TRUSTCARGO_MODE: 'demo',
            SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
            MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
            APP_URL: 'http://localhost:3000'
        } as unknown as NodeJS.ProcessEnv)
    );
    await seedReferenceData(app);
    return app;
}

export async function actors(app: App) {
    const keys = [
        'seller',
        'buyer',
        'buyer2',
        'inspector',
        'forwarder',
        'compliance',
        'reviewer',
        'disputes',
        'finance',
        'admin',
        'auditor'
    ] as const;
    const out = {} as Record<(typeof keys)[number], Actor>;
    for (const k of keys) out[k] = await personaActor(app, k);
    return out;
}

export function withoutMfa(actor: Actor): Actor {
    return { ...actor, mfaVerifiedAt: undefined };
}
