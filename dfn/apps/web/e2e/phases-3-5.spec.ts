import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { registerThroughUi } from './journey-helpers';

/**
 * Phases 3–5 smoke scenario: Wallet (sandbox deposit, balances), Transfer (quote → authorise →
 * processing), Business (invoice page) and the partner API (key scoping), all through the web
 * origin. Every screen must carry the sandbox disclaimer and render no raw translation key.
 */
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);
const email = `e2e-wallet-${run}@example.com`;
const RAW_KEY =
  /\b(nav|wallet|walletPlus|xfer|transfers|invoicing|business|dev|webhooks|beneficiary|jobsAdmin|ddaLab)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

async function register(page: Page) {
  // Throttle-tolerant (the API accepts 5 registrations per minute and client IP).
  await registerThroughUi(page, { email, firstName: 'Fatou', lastName: 'Ndiaye', country: 'CA' });
}

/** JSON call through the web proxy with the browser session (CSRF: first-party Origin). */
async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'put',
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await request[method](`/api${path}`, {
    data,
    headers: { origin: WEB_URL, 'content-type': 'application/json', ...headers },
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status(), body };
}

async function expectSandboxPage(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await expect(page.getByRole('status')).toContainText(/Aucun fonds réel|No real funds/);
  const text = await page.locator('main').innerText();
  expect(text, `raw translation key on ${path}`).not.toMatch(RAW_KEY);
}

test('wallet deposit, simulated transfer, invoice and partner API key through the web origin', async ({
  page,
}) => {
  await register(page);
  const me = await api<{ user: { organizations: Array<{ id: string }> } }>(
    page.request,
    'get',
    '/v1/auth/me',
  );
  const orgId = me.body.user.organizations[0].id;

  // Wallet: fictitious sandbox deposit, visible on the wallet screen
  const deposit = await api<{ newBalance: { decimal: string }; simulated: boolean }>(
    page.request,
    'post',
    '/v1/sandbox/wallets/self-deposit',
    { organizationId: orgId, currencyCode: 'CAD', amount: '1250.00' },
  );
  expect([200, 201], JSON.stringify(deposit.body)).toContain(deposit.status);
  expect(deposit.body.simulated).toBe(true);
  await expectSandboxPage(page, '/wallet');
  await expect(page.getByText(/1 250,00|1,250\.00/).first()).toBeVisible();
  await expectSandboxPage(page, '/wallet/beneficiaries');

  // Transfer: beneficiary → quote → transfer → authorisation (MFA not enabled on this account)
  const beneficiary = await api<{ id: string }>(page.request, 'post', '/v1/beneficiaries', {
    organizationId: orgId,
    name: 'Mame Diarra Sarr',
    country: 'SN',
    currencyCode: 'XOF',
    method: 'MOBILE_MONEY',
    accountIdentifier: '+221771234567',
    institutionName: 'Orange Money',
  });
  expect([200, 201], JSON.stringify(beneficiary.body)).toContain(beneficiary.status);
  const quote = await api<{ id: string; status: string }>(page.request, 'post', '/v1/transfers/quotes', {
    organizationId: orgId,
    originCountry: 'CA',
    destinationCountry: 'SN',
    sourceCurrency: 'CAD',
    destinationCurrency: 'XOF',
    amount: '200.00',
  });
  expect([200, 201], JSON.stringify(quote.body)).toContain(quote.status);
  const transfer = await api<{ id: string; reference: string }>(page.request, 'post', '/v1/transfers', {
    quoteId: quote.body.id,
    beneficiaryId: beneficiary.body.id,
    purpose: 'FAMILY_SUPPORT',
  });
  expect([200, 201], JSON.stringify(transfer.body)).toContain(transfer.status);
  const prefs = await api(page.request, 'put', '/v1/users/me/security-preferences', {
    requireMfaForTransfers: false,
  });
  expect(prefs.status, JSON.stringify(prefs.body)).toBe(200);
  const authorized = await api<{ status: string }>(
    page.request,
    'post',
    `/v1/transfers/${transfer.body.id}/authorize`,
    {},
  );
  expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
  expect(authorized.body.status).toBe('PROCESSING');
  await expectSandboxPage(page, `/transfers/${transfer.body.id}`);
  await expect(page.getByText(transfer.body.reference).first()).toBeVisible();
  await expectSandboxPage(page, '/transfers');
  await expect(page.getByText(transfer.body.reference).first()).toBeVisible();
  // The wallet was debited amount + fee (fictitious): 1 250,00 − 200,00 − (2,99 + 0,75 %) = 1 045,51
  await expectSandboxPage(page, '/wallet');
  await expect(page.getByText(/1\u00a0045,51|1,045\.51/).first()).toBeVisible();

  // Business: invoice numbered per organisation
  const invoice = await api<{ id: string; number: string }>(page.request, 'post', '/v1/invoices', {
    organizationId: orgId,
    customerName: 'Client e2e',
    currencyCode: 'CAD',
    lines: [{ description: 'Conseil', quantity: 2, unitPrice: '150.00' }],
    taxBps: 1500,
    dueDate: '2026-12-31',
  });
  expect([200, 201], JSON.stringify(invoice.body)).toContain(invoice.status);
  expect(invoice.body.number).toMatch(/^INV-\d{4}-\d{4}$/);
  await expectSandboxPage(page, `/business/invoices/${invoice.body.id}`);
  await expect(page.getByText(invoice.body.number).first()).toBeVisible();
  await expectSandboxPage(page, '/business/reports');

  // Partner API: a scoped key reads the wallet but never reaches staff routes
  const key = await api<{ credential: { keyPrefix: string }; key: string }>(
    page.request,
    'post',
    '/v1/api-credentials',
    { organizationId: orgId, name: 'Clé e2e', scopes: ['wallets:read'] },
  );
  expect([200, 201], JSON.stringify(key.body)).toContain(key.status);
  expect(key.body.key).toMatch(/^dfn_sk_/);
  await expectSandboxPage(page, '/developers');
  await expect(page.getByText(key.body.credential.keyPrefix).first()).toBeVisible();
  const bearer = { authorization: `Bearer ${key.body.key}` };
  const wallets = await page.request.get(`/api/v1/wallets/${orgId}`, { headers: bearer });
  expect(wallets.status()).toBe(200);
  expect(wallets.headers()['x-dfn-mode']).toBe('sandbox');
  const admin = await page.request.get('/api/v1/admin/stats', { headers: bearer });
  expect(admin.status()).toBe(403);
  const write = await page.request.post('/api/v1/transfers/quotes', {
    headers: { ...bearer, 'content-type': 'application/json' },
    data: {
      originCountry: 'CA',
      destinationCountry: 'SN',
      sourceCurrency: 'CAD',
      destinationCurrency: 'XOF',
      amount: '1.00',
    },
  });
  expect(write.status()).toBe(403);

  await expectSandboxPage(page, '/settings');
});
