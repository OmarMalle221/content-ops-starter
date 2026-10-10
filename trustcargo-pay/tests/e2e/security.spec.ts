import { expect, test } from '@playwright/test';
import { loginAs, passMfa } from './helpers';

test('outsiders get a 404 for transactions they are not party to (UI and API)', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.goto('/transactions');
    await page.getByRole('link', { name: 'Toyota RAV4 2021' }).first().click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    const path = new URL(page.url()).pathname;
    const id = path.split('/').pop()!;

    // Cheikh Fall is not a party to the RAV4 transaction.
    await loginAs(page, 'buyer2');
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(page.getByText('Élément introuvable ou inaccessible.')).toBeVisible();
    const api = await page.request.get(`/api/v1/transactions/${id}`);
    expect(api.status()).toBe(404);
    expect((await api.json()).error.code).toBe('NOT_FOUND');
});

test('the API rejects unauthenticated, cross-origin and non-JSON mutations', async ({ page, request }) => {
    const anon = await request.get('/api/v1/transactions');
    expect(anon.status()).toBe(401);

    await loginAs(page, 'seller');
    const cross = await page.request.post('/api/v1/transactions', { data: {}, headers: { origin: 'https://evil.example' } });
    expect(cross.status()).toBe(403);
    const form = await page.request.post('/api/v1/transactions', { form: { a: '1' }, headers: { origin: new URL(page.url()).origin } });
    expect(form.status()).toBe(422);
});

test('forged partner webhooks are rejected and never change state', async ({ request }) => {
    const body = JSON.stringify({
        id: 'evt_forged',
        type: 'funds.confirmed',
        created: new Date().toISOString(),
        data: { instructionReference: 'sim_pi_x', amountMinor: '1', currency: 'CAD' }
    });
    const unsigned = await request.post('/api/v1/webhooks/payments/mock', { data: body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.status()).toBe(401);
    const forged = await request.post('/api/v1/webhooks/payments/mock', {
        data: body,
        headers: { 'content-type': 'application/json', 'x-trustcargo-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` }
    });
    expect(forged.status()).toBe(401);
});

test('back-office requires a staff role and MFA; platform admins cannot read transactions', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.goto('/admin/risk');
    await expect(page).toHaveURL(/\/dashboard/);

    await loginAs(page, 'admin');
    await expect(page).toHaveURL(/\/mfa/);
    const code = (await page.getByTestId('demo-totp').textContent())!.trim();
    await page.getByLabel('Code de vérification').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page.getByText('Code de vérification invalide ou expiré.')).toBeVisible();
    await page.getByLabel('Code de vérification').fill((await page.getByTestId('demo-totp').textContent())!.trim());
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await page.waitForURL(/\/admin$/);
    await page.goto('/admin/transactions');
    await expect(page).toHaveURL(/\/admin$/);
});

test('a staff session without a recent MFA reads no transaction outside /admin either (UI and API)', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.goto('/transactions');
    await page.getByRole('link', { name: 'Toyota RAV4 2021' }).first().click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    const id = new URL(page.url()).pathname.split('/').pop()!;

    // The dispute manager only has the first factor (the e-mail link, here the persona sign-in).
    await loginAs(page, 'disputes');
    await expect(page).toHaveURL(/\/mfa/);
    await page.goto(`/transactions/${id}?tab=documents`);
    await expect(page).toHaveURL(/\/mfa\?next=/);
    for (const path of [`/api/v1/transactions/${id}`, `/api/v1/transactions/${id}/documents`]) {
        const res = await page.request.get(path);
        expect(res.status()).toBe(404);
    }
    await page.goto('/admin/disputes');
    await expect(page).toHaveURL(/\/mfa\?next=%2Fadmin%2Fdisputes/);

    await page.goto(`/transactions/${id}?tab=documents`);
    await passMfa(page);
    await expect(page).toHaveURL(new RegExp(`/transactions/${id}\\?tab=documents`));
    expect((await page.request.get(`/api/v1/transactions/${id}/documents`)).status()).toBe(200);
});

test('security headers are set (CSP with nonce, frame denial, nosniff)', async ({ request }) => {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy']!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
});
