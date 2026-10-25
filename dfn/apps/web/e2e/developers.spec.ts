import { expect, test } from '@playwright/test';
import {
  dialog,
  expectSandboxScreen,
  journeyEmail,
  personalOrganizationId,
  registerThroughUi,
} from './journey-helpers';

/**
 * Phase 6 — partner API console through the UI: a scoped sandbox key created with the dialog, its
 * secret revealed exactly once (and usable), never shown again after the dialog is closed, then
 * revoked (the key is refused from then on).
 */
const RAW_KEY = /\b(dev|webhooks|common|status)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

test('create a sandbox API key, see its secret once, use it, revoke it', async ({ page }) => {
  await registerThroughUi(page, {
    email: journeyEmail('developers'),
    firstName: 'Cheikh',
    lastName: 'Fall',
    country: 'SN',
  });
  const orgId = await personalOrganizationId(page);

  await page.goto('/developers');
  await expectSandboxScreen(page, RAW_KEY);
  await page
    .getByRole('button', { name: /Créer une clé sandbox|Create a sandbox key/ })
    .first()
    .click();

  // 1. Creation dialog: name + one scope (least privilege); the confirm stays disabled until valid.
  const create = dialog(page);
  await expect(create).toBeVisible();
  const confirm = create.getByRole('button', { name: /Créer une clé sandbox|Create a sandbox key/ });
  await expect(confirm).toBeDisabled();
  await create.getByLabel(/Nom de la clé|Key name/).fill('Clé e2e lecture portefeuille');
  await create.getByRole('checkbox', { name: /wallets:read/ }).check();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  // 2. The secret is revealed once, with the sandbox badge and the "never shown again" warning.
  const reveal = page.getByRole('dialog', { name: /Votre clé sandbox|Your sandbox key/ });
  await expect(reveal).toBeVisible();
  await expect(reveal.getByText(/Aucun fonds réel|No real funds/).first()).toBeVisible();
  const secret = (await reveal.getByTestId('revealed-secret').innerText()).trim();
  expect(secret).toMatch(/^dfn_sk_[a-z0-9]{8}_[A-Za-z0-9_-]{20,}$/);
  const prefix = secret.split('_').slice(0, 3).join('_');

  // The key works with its scope (wallets:read) and nothing more.
  const bearer = { authorization: `Bearer ${secret}` };
  const wallets = await page.request.get(`/api/v1/wallets/${orgId}`, { headers: bearer });
  expect(wallets.status()).toBe(200);
  expect(wallets.headers()['x-dfn-mode']).toBe('sandbox');
  expect((await page.request.get('/api/v1/transfers', { headers: bearer })).status()).toBe(403);

  await reveal.getByRole('button', { name: /J’ai copié la clé|I copied the key/ }).click();
  await expect(reveal).toBeHidden();

  // 3. Never displayed again: the list shows the prefix only, also after a reload.
  const row = page.getByRole('row', { name: /Clé e2e lecture portefeuille/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(prefix);
  await expect(row).toContainText('wallets:read');
  await expect(page.getByText(secret)).toHaveCount(0);
  await page.reload();
  expect(await page.content()).not.toContain(secret);
  await expectSandboxScreen(page, RAW_KEY);

  // 4. Revocation through the row action → the key disappears from the active list and is refused.
  await page
    .getByRole('row', { name: /Clé e2e lecture portefeuille/ })
    .getByRole('button', { name: /^(Révoquer|Revoke)$/ })
    .click();
  const revoke = dialog(page);
  await expect(revoke).toContainText(prefix);
  await revoke.getByRole('button', { name: /^(Révoquer|Revoke)$/ }).click();
  await expect(revoke).toBeHidden();
  await expect(page.getByRole('row', { name: /Clé e2e lecture portefeuille/ })).toHaveCount(0);
  const refused = await page.request.get(`/api/v1/wallets/${orgId}`, { headers: bearer });
  expect(refused.status()).toBe(401);

  // The revoked key remains listed (status "Revoked") when asking for revoked keys.
  await page.getByRole('link', { name: /Afficher les clés révoquées|Show revoked keys/ }).click();
  const revokedRow = page.getByRole('row', { name: /Clé e2e lecture portefeuille/ });
  await expect(revokedRow).toContainText(/Révoquée|Revoked/);
  await expect(revokedRow.getByRole('button', { name: /^(Révoquer|Revoke)$/ })).toHaveCount(0);
  await expectSandboxScreen(page, RAW_KEY);
});
