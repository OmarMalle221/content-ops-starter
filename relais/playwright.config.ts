import { defineConfig, devices } from '@playwright/test';

const FAKE_SUPABASE = 'http://127.0.0.1:54399';
const APP = 'http://127.0.0.1:4173';

// Tests de bout en bout sur la version compilée (PWA), en format téléphone. Le faux Supabase
// (tests/e2e/fake-supabase.mjs) simule Auth et exécute les requêtes de données sur la vraie base migrée
// (PostgreSQL 16 lancé par scripts/test-db.sh --serve) : RLS, fonctions et déclencheurs réels.
// Les tests partagent la base : un seul worker.
export default defineConfig({
    testDir: 'tests/e2e',
    fullyParallel: false,
    workers: 1,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    timeout: 60_000,
    use: {
        ...devices['Pixel 7'],
        baseURL: APP,
        locale: 'fr-CA',
        timezoneId: 'America/Toronto',
        trace: 'retain-on-failure'
    },
    webServer: [
        {
            command: 'bash scripts/test-db.sh --serve node tests/e2e/fake-supabase.mjs',
            url: `${FAKE_SUPABASE}/__test/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
            gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }
        },
        {
            command: 'npx vite build --mode e2e && npx vite preview --mode e2e --host 127.0.0.1 --port 4173 --strictPort',
            url: APP,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000
        }
    ]
});
