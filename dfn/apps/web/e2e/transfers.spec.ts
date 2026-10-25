import { expect, test } from '@playwright/test';
import {
  api,
  dialog,
  expectSandboxScreen,
  frMoney,
  journeyEmail,
  personalOrganizationId,
  registerThroughUi,
} from './journey-helpers';

/**
 * Phase 6 — Diaspora Transfer through the UI: transfer-security preference turned off from the
 * settings, beneficiary created from the beneficiaries screen, three-step creation flow with the
 * live quote countdown, authorisation (PROCESSING, wallet debited) and simulated partner
 * settlement from the transfer page (SETTLED, receipt available).
 */
const RAW_KEY =
  /\b(xfer|transfers|wallet|walletPlus|beneficiary|secprefs|common|status)\.[a-zA-Z]+(\.[a-zA-Z]+)*\b/;

test('beneficiary, quote countdown, authorisation and simulated settlement', async ({ page }) => {
  await registerThroughUi(page, {
    email: journeyEmail('transfer'),
    firstName: 'Ousmane',
    lastName: 'Kane',
    country: 'CA',
  });
  const orgId = await personalOrganizationId(page);

  // Setup (API, same session): fictitious funds to transfer from.
  const deposit = await api(page.request, 'post', '/v1/sandbox/wallets/self-deposit', {
    organizationId: orgId,
    currencyCode: 'CAD',
    amount: '1000.00',
  });
  expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);

  // 1. Settings: turn off "require two-step verification to authorise a transfer".
  await page.goto('/settings');
  await expectSandboxScreen(page, RAW_KEY);
  const requireMfa = page.getByRole('checkbox', {
    name: /Exiger une vérification en deux étapes|Require two-step verification/,
  });
  await expect(requireMfa).toBeChecked();
  await requireMfa.uncheck();
  const prefsForm = page.locator('form').filter({ has: requireMfa });
  await prefsForm.getByRole('button', { name: /^(Enregistrer|Save)$/ }).click();
  await expect(prefsForm.getByText(/Préférences enregistrées|Preferences saved/)).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('checkbox', {
      name: /Exiger une vérification en deux étapes|Require two-step verification/,
    }),
  ).not.toBeChecked();

  // 2. Beneficiary created through the dialog: only the masked identifier is ever displayed.
  await page.goto(`/wallet/beneficiaries?organizationId=${orgId}`);
  await expectSandboxScreen(page, RAW_KEY);
  await page
    .getByRole('button', { name: /Ajouter un bénéficiaire|Add a beneficiary/ })
    .first()
    .click();
  const beneficiaryDialog = dialog(page);
  await beneficiaryDialog.getByLabel(/Nom complet|Full name/).fill('Mame Diarra Sarr');
  await beneficiaryDialog.getByLabel(/^Pays$|^Country$/).selectOption('SN');
  await beneficiaryDialog.getByLabel(/Devise de réception|Receiving currency/).selectOption('XOF');
  await beneficiaryDialog.getByLabel(/Mode de réception|Payout method/).selectOption('MOBILE_MONEY');
  await beneficiaryDialog.getByLabel(/Banque \/ opérateur|Bank \/ operator/).fill('Wave');
  await beneficiaryDialog.getByLabel(/Numéro mobile money|Mobile money number/).fill('+221771234567');
  await expect(beneficiaryDialog.getByText('••••4567')).toBeVisible();
  await beneficiaryDialog.getByRole('button', { name: /^(Enregistrer|Save)$/ }).click();
  await expect(beneficiaryDialog).toBeHidden();
  const row = page.getByRole('row', { name: /Mame Diarra Sarr/ });
  await expect(row).toBeVisible();
  // The identifier column only shows the masked form. (Reported separately: for mobile money the
  // dialog also copies the number into the clear-text `phone` field, which the list displays.)
  await expect(row.getByRole('cell', { name: '••••4567' })).toBeVisible();

  // 3. New transfer, step 1: corridor Canada → Senegal, 150.00 CAD → simulated quote.
  await page.goto(`/transfers/new?organizationId=${orgId}`);
  await expectSandboxScreen(page, RAW_KEY);
  await page.getByLabel(/^Corridor$/).selectOption('CA-SN');
  await page.getByLabel(/Montant envoyé|Amount sent/).fill('150.00');
  await page.getByLabel(/Devise d’envoi|Sending currency/).selectOption('CAD');
  await page.getByLabel(/^(Devise de réception|Receiving currency)$/).selectOption('XOF');
  await page.getByRole('button', { name: /Obtenir un devis \(simulé\)|Get a quote \(simulated\)/ }).click();

  // Step 2: quote with a live countdown (it must tick down), fee and total debit from the API.
  const countdown = page.getByText(/(Expire dans|Expires in) \d{2}:\d{2}/).first();
  await expect(countdown).toBeVisible();
  const firstReading = await countdown.innerText();
  await expect.poll(() => countdown.innerText(), { timeout: 10_000 }).not.toBe(firstReading);
  await expect(page.getByText(frMoney('150.00', '$')).first()).toBeVisible();
  // Fee 2.99 + 0.75 % of 150.00 (1.13) = 4.12 → total debit 154.12.
  await expect(page.getByText(frMoney('154.12', '$')).first()).toBeVisible();
  await expect(page.getByLabel(/Choisir un bénéficiaire|Choose a beneficiary/)).toContainText(
    'Mame Diarra Sarr',
  );
  await page.getByRole('button', { name: /Créer le transfert|Create the transfer/ }).click();

  // Step 3: transfer QUOTED, then authorisation (no second factor: MFA is not enabled).
  const reference = page.getByText(/DFT-\d{4}-[A-Z0-9]{6}/).first();
  await expect(reference).toBeVisible();
  const ref = (await reference.innerText()).match(/DFT-\d{4}-[A-Z0-9]{6}/)![0];
  await page.getByRole('button', { name: /Autoriser le transfert|Authorise the transfer/ }).click();
  const authorize = dialog(page);
  await expect(authorize).toBeVisible();
  await expect(authorize.getByText(frMoney('154.12', '$'))).toBeVisible();
  await expect(authorize.getByText(/Mame Diarra Sarr/)).toBeVisible();
  await authorize.getByRole('button', { name: /Autoriser le transfert|Authorise the transfer/ }).click();
  await expect(page).toHaveURL(/\/transfers\/[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { name: ref })).toBeVisible();
  await expect(page.getByText(/^(En traitement \(simulé\)|Processing \(simulated\))$/).first()).toBeVisible();
  await expectSandboxScreen(page, RAW_KEY);

  // 4. Simulated partner settlement from the transfer page → SETTLED, receipt links appear.
  await page
    .getByRole('button', { name: /Simuler le règlement du partenaire|Simulate partner settlement/ })
    .click();
  await expect(page.getByText(/^(Réglé \(simulé\)|Settled \(simulated\))$/).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Simuler le règlement du partenaire|Simulate partner settlement/ }),
  ).toHaveCount(0);
  const receipt = page.getByRole('link', { name: /Reçu texte|Text receipt/ }).first();
  await expect(receipt).toBeVisible();

  // 5. The wallet was debited exactly once: 1 000.00 − 154.12 = 845.88 (fictitious).
  await page.goto(`/wallet?organizationId=${orgId}`);
  await expect(page.getByText(frMoney('845.88', '$')).first()).toBeVisible();
  await page.goto('/transfers');
  await expect(page.getByRole('row', { name: new RegExp(ref) })).toContainText(
    /Réglé \(simulé\)|Settled \(simulated\)/,
  );
  await expectSandboxScreen(page, RAW_KEY);
});
