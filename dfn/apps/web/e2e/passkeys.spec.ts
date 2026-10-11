import { expect, test, type Page } from '@playwright/test';
import { registerThroughUi } from './journey-helpers';

/**
 * Phase 6 — passkeys through the real browser ceremony, with a Chrome DevTools Protocol virtual
 * authenticator (CTAP2, internal transport, resident keys, user verification always granted):
 * add a passkey from the settings (fresh password proof), sign out, sign back in with the
 * passkey only (no password, no MFA step), and check the screens keep the sandbox disclaimer.
 */
const PASSWORD = 'CorrectHorse42Battery';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);
const email = `e2e-passkey-${run}@example.com`;
const RAW_KEY = /\bpasskeys\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

async function register(page: Page) {
  // Registration is throttled per IP (5 per minute): the shared helper retries through it.
  await registerThroughUi(page, { email, firstName: 'Fatou', lastName: 'Ndiaye', country: 'CA' });
}

async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test('adds a passkey from the settings and signs in with it, without password or MFA step', async ({
  page,
}) => {
  const { cdp, authenticatorId } = await addVirtualAuthenticator(page);
  await register(page);

  // Settings: the passkeys and recovery codes cards are rendered, translated, with the disclaimer.
  await page.goto('/settings');
  await expect(page.getByRole('status')).toContainText(/Aucun fonds réel|No real funds/);
  await expect(page.getByText(/Clés d’accès|Passkeys/).first()).toBeVisible();
  await expect(page.getByText(/Activez d’abord la double authentification|Enable two-factor/)).toBeVisible();
  await page.locator('#passkey-name').fill('Clé virtuelle E2E');
  await page.locator('#passkey-add-password').fill(PASSWORD);
  await page.getByRole('button', { name: /Ajouter une clé d’accès|Add a passkey/ }).click();
  await expect(page.getByText(/Clé d’accès ajoutée|Passkey added/)).toBeVisible();
  await expect(page.getByText('Clé virtuelle E2E')).toBeVisible();
  const credentials = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials.credentials).toHaveLength(1);
  expect(credentials.credentials[0].isResidentCredential).toBe(true);
  expect(await page.locator('main').innerText()).not.toMatch(RAW_KEY);

  // Sign out, then sign in with the passkey only.
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: { origin: WEB_URL, 'content-type': 'application/json' },
    data: {},
  });
  expect(logout.status()).toBe(200);
  await page.context().clearCookies();
  await page.goto('/login');
  await page
    .getByRole('button', { name: /Se connecter avec une clé d’accès|Sign in with a passkey/ })
    .click();
  await expect(page).toHaveURL(/\/dashboard/);
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { mfaRequired: boolean; user: { email: string } };
  expect(body.mfaRequired).toBe(false);
  expect(body.user.email).toBe(email);

  // The passkey shows a last-use date now.
  await page.goto('/settings');
  await expect(page.getByText('Clé virtuelle E2E')).toBeVisible();
  await expect(page.getByText(/Dernière utilisation jamais|Last used never/)).toHaveCount(0);
});
