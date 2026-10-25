import { defineConfig, devices } from '@playwright/test';

const FAKE_SUPABASE = 'http://127.0.0.1:54399';
const APP = 'http://127.0.0.1:4173';

// Tests de bout en bout sur la version compilée (PWA), en format téléphone, contre un faux Supabase
// local (tests/e2e/fake-supabase.mjs). Les tests partagent l'état du faux serveur : un seul worker.
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
            command: 'node tests/e2e/fake-supabase.mjs',
            url: `${FAKE_SUPABASE}/__test/health`,
            reuseExistingServer: !process.env.CI
        },
        {
            command: 'npx vite build --mode e2e && npx vite preview --mode e2e --host 127.0.0.1 --port 4173 --strictPort',
            url: APP,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000
        }
    ]
});
