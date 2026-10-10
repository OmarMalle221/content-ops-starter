import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@/server/app';
import { createApp } from '@/server/app';
import { loadConfig } from '@/server/config';
import { personaActor, seedReferenceData } from '@/server/demo/seed';

// next/headers, next/navigation and the process-wide instance are replaced by in-memory fakes: the session cookie is
// really signed and read back by src/server/auth/session.ts.
const state = vi.hoisted(() => ({ jar: new Map<string, string>(), app: undefined as unknown as App }));
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
        set: (name: string, value: string) => void state.jar.set(name, value),
        delete: (name: string) => void state.jar.delete(name)
    }),
    headers: async () => new Headers()
}));
vi.mock('next/navigation', () => ({
    redirect: (to: string) => {
        throw new Error(`redirect:${to}`);
    }
}));
vi.mock('@/server/instance', () => ({ getApp: async () => state.app }));

const { getActor, markMfaVerified, requireStaff, startSession } = await import('@/server/auth/session');

async function signIn(key: string) {
    const persona = await personaActor(state.app, key);
    await startSession(persona.userId);
    return persona;
}

describe('session actor: platform roles are only effective with a recent MFA', () => {
    beforeEach(async () => {
        state.jar.clear();
        state.app = createApp(
            loadConfig({
                TRUSTCARGO_MODE: 'demo',
                SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
                MOCK_PROVIDER_WEBHOOK_SECRET: 'test-webhook-secret-0123456789'
            } as unknown as NodeJS.ProcessEnv)
        );
        await seedReferenceData(state.app);
    });

    it('withholds the roles of a staff session until its MFA challenge, then for adminMfaMaxAgeMinutes only', async () => {
        await signIn('compliance');
        const before = await getActor();
        expect(before).toMatchObject({ platformRoles: [], pendingPlatformRoles: ['compliance_analyst'], mfaVerifiedAt: undefined });
        await expect(requireStaff(['compliance_analyst'], '/admin/risk')).rejects.toThrow('redirect:/mfa?next=%2Fadmin%2Frisk');
        await expect(requireStaff(['finance_operator'], '/admin/ledger')).rejects.toThrow('redirect:/dashboard');

        await markMfaVerified();
        const after = await getActor();
        expect(after).toMatchObject({ platformRoles: ['compliance_analyst'] });
        expect(after!.pendingPlatformRoles).toBeUndefined();
        await expect(requireStaff(['compliance_analyst'], '/admin/risk')).resolves.toMatchObject({ userId: after!.userId });

        // Once adminMfaMaxAgeMinutes has elapsed (30 min here) the roles are pending again, the session still open.
        await state.app.deps.uow.run((db) => db.securitySettings.update('default', { adminMfaMaxAgeMinutes: 30 }));
        vi.useFakeTimers({ now: Date.now() + 31 * 60_000, toFake: ['Date'] });
        try {
            expect(await getActor()).toMatchObject({ platformRoles: [], pendingPlatformRoles: ['compliance_analyst'] });
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves accounts without a platform role unchanged (no MFA needed for party access)', async () => {
        await signIn('buyer');
        const actor = await getActor();
        expect(actor).toMatchObject({ platformRoles: [] });
        expect(actor!.pendingPlatformRoles).toBeUndefined();
        await expect(requireStaff(['compliance_analyst'], '/admin/risk')).rejects.toThrow('redirect:/dashboard');
    });
});
