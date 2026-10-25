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
