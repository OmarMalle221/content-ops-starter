import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { setLogSink } from '../../src/lib/log';
import { resetBackend } from './backend';

// Les composants parlent à un faux backend en mémoire (tests/component/backend.ts).
vi.mock('../../src/lib/api', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/api')>();
    const { api } = await import('./backend');
    return { ...actual, ...api };
});
vi.mock('../../src/lib/careFiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/careFiles')>();
    const { careFilesApi } = await import('./backend');
    return { ...actual, ...careFilesApi };
});
vi.mock('../../src/lib/documents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/documents')>();
    const { documentsApi } = await import('./backend');
    return { ...actual, ...documentsApi };
});
vi.mock('../../src/lib/benefits', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/benefits')>();
    const { benefitsApi } = await import('./backend');
    return { ...actual, ...benefitsApi };
});
vi.mock('../../src/lib/coordination', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/lib/coordination')>();
    const { coordinationApi } = await import('./backend');
    return { ...actual, ...coordinationApi };
});
vi.mock('../../src/lib/supabase', async () => {
    const { auth } = await import('./backend');
    return { supabase: () => ({ auth }) };
});

beforeEach(() => {
    resetBackend();
    setLogSink(() => undefined);
});

afterEach(() => {
    cleanup();
    setLogSink(null);
});
