import { expect, test } from '@playwright/test';
import {
  dialog,
  expectSandboxScreen,
  frMoney,
  journeyEmail,
  personalOrganizationId,
  registerThroughUi,
} from './journey-helpers';

/**
 * Phase 6 — Diaspora Wallet through the UI: sandbox self-deposit dialog (daily cap shown),
 * balances derived from the ledger, operations filter and CSV statement link.
 */
const RAW_KEY = /\b(wallet|walletPlus|beneficiary|secprefs|common|status)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

test('self-deposit through the dialog, balances, operations filter and CSV statement', async ({ page }) => {
  await registerThroughUi(page, {
    email: journeyEmail('wallet'),
    firstName: 'Aïssatou',
    lastName: 'Diallo',
    country: 'CA',
  });
  const orgId = await personalOrganizationId(page);

  await page.goto('/wallet');
  await expectSandboxScreen(page, RAW_KEY);
  await expect(page.getByRole('heading', { name: /Portefeuille|Wallet/ }).first()).toBeVisible();

  // 1. Sandbox self-deposit in CAD through the dialog — the daily cap is displayed before confirming.
  await page.getByRole('button', { name: /Alimenter \(fictif\)|Top up \(simulated\)/ }).click();
  const deposit = dialog(page);
  await expect(deposit).toBeVisible();
  await expect(deposit.getByText(/Plafond quotidien \(sandbox\)|Daily cap \(sandbox\)/)).toBeVisible();
  await expect(deposit.getByText(frMoney('50000.00', '$')).first()).toBeVisible();
  await deposit.getByLabel(/^Devise$|^Currency$/).selectOption('CAD');
  await deposit.getByLabel(/^Montant$|^Amount$/).fill('1500.00');
  await deposit.getByRole('button', { name: /Alimenter \(fictif\)|Top up \(simulated\)/ }).click();
  await expect(deposit).toBeHidden();
  await expect(page.getByText(frMoney('1500.00', '$')).first()).toBeVisible();

  // 2. A second deposit in EUR: each currency keeps its own ledger-derived balance.
  await page.getByRole('button', { name: /Alimenter \(fictif\)|Top up \(simulated\)/ }).click();
  await expect(deposit).toBeVisible();
  await deposit.getByLabel(/^Devise$|^Currency$/).selectOption('EUR');
  await deposit.getByLabel(/^Montant$|^Amount$/).fill('200');
  await deposit.getByRole('button', { name: /Alimenter \(fictif\)|Top up \(simulated\)/ }).click();
  await expect(deposit).toBeHidden();
  await expect(page.getByText(frMoney('200.00', '€')).first()).toBeVisible();
  await expect(page.getByText(frMoney('1500.00', '$')).first()).toBeVisible();
  // Remaining cap for CAD went down accordingly (50 000 − 1 500).
  await expect(page.getByText(frMoney('48500.00', '$')).first()).toBeVisible();

  // 3. Operations of the CAD wallet: the deposit is listed; the kind filter narrows the table.
  const operations = page.locator('table');
  await expect(operations.getByText(/Sandbox self-deposit of 1500\.00 CAD/)).toBeVisible();
  await page.getByLabel(/Type d’opération|Operation type|Kind/).selectOption('WITHDRAWAL');
  await page.getByRole('button', { name: /Appliquer|Apply/ }).click();
  await expect(page).toHaveURL(/kind=WITHDRAWAL/);
  await expect(
    page.getByText(/Aucune opération ne correspond aux filtres|No operation matches/),
  ).toBeVisible();
  await page.getByLabel(/Type d’opération|Operation type|Kind/).selectOption('DEPOSIT');
  await page.getByRole('button', { name: /Appliquer|Apply/ }).click();
  await expect(page).toHaveURL(/kind=DEPOSIT/);
  await expect(page.locator('table').getByText(/Sandbox self-deposit of 1500\.00 CAD/)).toBeVisible();

  // 4. The statement link keeps the filters and returns a sandbox CSV.
  const statement = page.getByRole('link', { name: /Exporter le relevé \(CSV\)|Export statement \(CSV\)/ });
  const href = await statement.getAttribute('href');
  expect(href).toContain(`/api/v1/wallets/${orgId}/CAD/statement.csv`);
  expect(href).toContain('kind=DEPOSIT');
  const csv = await page.request.get(href!);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toMatch(/^text\/csv/);
  const body = await csv.text();
  expect(body).toContain('SANDBOX statement');
  expect(body).toContain('Aucun fonds réel');
  expect(body).toMatch(/DEPOSIT,.*1500\.00,CAD,POSTED/);
  expect(body).not.toContain('WITHDRAWAL');

  // 5. Reset brings every operation back.
  await page.getByRole('button', { name: /Réinitialiser|Reset/ }).click();
  await expect(page).not.toHaveURL(/kind=/);
  await expectSandboxScreen(page, RAW_KEY);
});
