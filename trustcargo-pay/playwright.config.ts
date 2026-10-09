import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3200);
// In this repository's cloud sandbox a Chromium build is pre-installed; CI installs its own.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? (process.env.CI ? undefined : '/opt/pw-browsers/chromium');

export default defineConfig({
    testDir: 'tests/e2e',
    // One server with in-memory state: tests run serially and each creates or uses distinct data.
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 90_000,
    expect: { timeout: 15_000 },
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        locale: 'fr-CA',
        launchOptions: executablePath ? { executablePath } : {}
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
        { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ }
    ],
    webServer: {
        command: process.env.E2E_SKIP_BUILD ? `npx next start -p ${PORT}` : `npx next build && npx next start -p ${PORT}`,
        url: `http://localhost:${PORT}/api/v1/health`,
        timeout: 300_000,
        reuseExistingServer: !process.env.CI,
        env: {
            TRUSTCARGO_MODE: 'demo',
            SESSION_SECRET: 'e2e-session-secret-0123456789abcdefghijklmnop',
            MOCK_PROVIDER_WEBHOOK_SECRET: 'e2e-webhook-secret-0123456789',
            APP_URL: `http://localhost:${PORT}`
        }
    }
});
