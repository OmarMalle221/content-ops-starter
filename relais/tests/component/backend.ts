// Faux backend en mémoire pour les tests de composants : remplace src/lib/api et src/lib/supabase
// (voir setup.ts). Chaque test part d'un état neuf (resetBackend).
import type { Session } from '@supabase/supabase-js';
import { vi } from 'vitest';
import type { Profile, Resource } from '../../src/lib/api';
import type { ConsentRecord, UserConsentType } from '../../src/lib/consents';
import snapshot from '../../src/content/emergency-resources.json';

export const USER_ID = 'a0000000-0000-4000-8000-00000000000a';

export function fakeSession(aal: 'aal1' | 'aal2' = 'aal1', userId = USER_ID): Session {
    const payload = btoa(JSON.stringify({ sub: userId, aal, role: 'authenticated' })).replace(/=+$/, '');
    return {
        access_token: `eyJhbGciOiJub25lIn0.${payload}.sig`,
        refresh_token: 'refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: userId, email: 'aidante@example.test', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' }
    } as Session;
}

interface BackendState {
    session: Session | null;
    profile: Profile;
    consents: ConsentRecord[];
    resources: Resource[];
    failResources: boolean;
}

export const backend: BackendState = {
    session: null,
    profile: { id: USER_ID, display_name: null, app_role: 'member' },
    consents: [],
    resources: [],
    failResources: false
};

export function resetBackend(): void {
    backend.session = null;
    backend.profile = { id: USER_ID, display_name: null, app_role: 'member' };
    backend.consents = [];
    backend.resources = snapshot as Resource[];
    backend.failResources = false;
    for (const fn of Object.values(api)) fn.mockClear();
}

let nextId = 1;
const id = () => `c0000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;

export function consent(type: UserConsentType, version = '2026-10-26', revokedAt: string | null = null): ConsentRecord {
    return { id: id(), consent_type: type, text_version: version, granted_at: '2026-10-26T14:00:00Z', revoked_at: revokedAt };
}

export const api = {
    getProfile: vi.fn(async () => ({ ...backend.profile })),
    updateDisplayName: vi.fn(async (_userId: string, name: string) => {
        backend.profile = { ...backend.profile, display_name: name };
    }),
    listMyConsents: vi.fn(async () => [...backend.consents]),
    grantConsent: vi.fn(async (type: UserConsentType, version: string) => {
        backend.consents = backend.consents.map((c) =>
            c.consent_type === type && c.revoked_at === null ? { ...c, revoked_at: '2026-10-26T15:00:00Z' } : c
        );
        backend.consents.unshift(consent(type, version));
    }),
    revokeConsent: vi.fn(async (consentId: string) => {
        backend.consents = backend.consents.map((c) => (c.id === consentId ? { ...c, revoked_at: '2026-10-26T15:00:00Z' } : c));
    }),
    listHelpResources: vi.fn(async () => {
        if (backend.failResources) throw new Error('réseau indisponible');
        return [...backend.resources];
    }),
    exportMyData: vi.fn(async () => ({ format: 'relais-export/1' })),
    deleteMyAccount: vi.fn(async () => undefined),
    signOutLocally: vi.fn(async () => undefined)
};

export const auth = {
    getSession: vi.fn(async () => ({ data: { session: backend.session }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => undefined } } })),
    signInWithOtp: vi.fn(async () => ({ data: {}, error: null })),
    verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    mfa: {
        listFactors: vi.fn(async () => ({
            data: { totp: [], all: [{ id: 'stale-factor', factor_type: 'totp', status: 'unverified' }] },
            error: null
        })),
        unenroll: vi.fn(async () => ({ data: {}, error: null })),
        enroll: vi.fn(async () => ({
            data: { id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg/>', secret: 'ABCDEF' } },
            error: null
        })),
        challengeAndVerify: vi.fn(async () => ({ data: {}, error: null }))
    }
};
