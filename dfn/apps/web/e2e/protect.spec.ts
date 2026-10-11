import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'CorrectHorse42Battery';
const run = Date.now().toString(36);
const buyerEmail = `e2e-buyer-${run}@example.com`;
const sellerEmail = `e2e-seller-${run}@example.com`;

async function register(page: Page, email: string, firstName: string, lastName: string, country: string) {
  await page.goto('/register');
  await page.getByLabel(/Prénom|First name/).fill(firstName);
  await page.getByLabel(/^Nom$|Last name/).fill(lastName);
  await page.getByLabel(/Courriel|Email/).fill(email);
  await page.getByLabel(/Pays|Country/).selectOption(country);
  await page.getByLabel(/Mot de passe|Password/).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Créer un compte|Create an account/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function verifyIdentity(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: /Lancer la vérification|Start verification/ }).click();
  await expect(page.getByText(/Vérifiée \(simulation\)|Verified \(simulation\)/).first()).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: /Se déconnecter|Sign out/ }).click();
  await expect(page).toHaveURL(/\/login/);
}

test('sandbox banner is always visible and the API is tagged', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText(/Aucun fonds réel|No real funds/);
  const health = await request.get('/api/v1/health');
  expect(health.headers()['x-dfn-mode']).toBe('sandbox');
});

test('buyer creates a protected transaction, seller joins, funding is simulated and a milestone is released', async ({
  page,
  browser,
}) => {
  // Buyer
  await register(page, buyerEmail, 'Moussa', 'Ndiaye', 'CA');
  await verifyIdentity(page);
  await page.goto('/transactions/new');
  await page.getByLabel(/^Titre$|^Title$/).fill('Toyota Hilux 2019 — e2e');
  await page.getByLabel(/Description/).fill('Pick-up double cabine, inspection avant embarquement.');
  await page.getByLabel(/Montant total|Total amount/).fill('18500.00');
  await page.getByLabel(/Courriel du vendeur|Seller email/).fill(sellerEmail);
  const titles = page.getByLabel(/Intitulé du jalon|Milestone title/);
  await titles.nth(0).fill('Embarquement');
  await titles.nth(1).fill('Livraison');
  const amounts = page.locator('input[id^="m-amount-"]');
  await amounts.nth(0).fill('9250.00');
  await amounts.nth(1).fill('9250.00');
  await page.getByRole('button', { name: /Créer et inviter|Create and invite/ }).click();
  const link = await page.locator('code').first().innerText();
  expect(link).toContain('/invite/');
  const token = link.split('/invite/')[1];
  await logout(page);

  // Seller (separate browser context)
  const sellerContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  await seller.goto(`/invite/${token}`);
  await expect(seller.getByText('Toyota Hilux 2019 — e2e')).toBeVisible();
  await seller.getByRole('link', { name: /Créer un compte|Create an account/ }).click();
  await seller.getByLabel(/Prénom|First name/).fill('Awa');
  await seller.getByLabel(/^Nom$|Last name/).fill('Diop');
  await seller.getByLabel(/Courriel|Email/).fill(sellerEmail);
  await seller.getByLabel(/Pays|Country/).selectOption('SN');
  await seller.getByLabel(/Mot de passe|Password/).fill(PASSWORD);
  await seller.getByRole('checkbox').check();
  await seller.getByRole('button', { name: /Créer un compte|Create an account/ }).click();
  // Registering with the invitation token joins the transaction automatically.
  await expect(seller).toHaveURL(/\/invite\//);
  await seller.getByRole('link', { name: /Détails|Details/ }).click();
  await expect(seller).toHaveURL(/\/transactions\//);
  const txUrl = seller.url();
  await seller.getByRole('button', { name: /Accepter les conditions|Accept terms/ }).click();
  await expect(seller.getByText(/Conditions à accepter|Terms to accept/).first()).toBeVisible();
  await verifyIdentity(seller);

  // Buyer accepts terms, requests funding, simulates partner confirmation
  await page.goto('/login');
  await page.getByLabel(/Courriel|Email/).fill(buyerEmail);
  await page.getByLabel(/Mot de passe|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /Se connecter|Sign in/ }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.goto(txUrl);
  await page.getByRole('button', { name: /Accepter les conditions|Accept terms/ }).click();
  await page.getByRole('button', { name: /Demander les instructions|Request funding/ }).click();
  await expect(page.getByText(/En attente de financement|Awaiting funding/).first()).toBeVisible();
  await page.getByRole('button', { name: /Simuler la confirmation|Simulate partner/ }).click();
  await expect(page.getByText(/Fonds \(fictifs\) reçus|Funds \(simulated\) received/).first()).toBeVisible();

  // Seller uploads evidence and submits milestone 1
  await seller.goto(txUrl);
  const milestone1 = seller.getByRole('listitem').filter({ hasText: 'Embarquement' }).first();
  await milestone1.getByRole('button', { name: /Ajouter un document|Add a document/ }).click();
  await seller.getByLabel(/Fichier|File/).setInputFiles({
    name: 'bol.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  });
  await seller
    .getByRole('button', { name: /Téléverser|Upload/ })
    .last()
    .click();
  await expect(seller.getByRole('dialog')).toBeHidden();
  await expect(seller.getByText('bol.pdf').first()).toBeVisible();
  await milestone1.getByRole('button', { name: /Soumettre les preuves|Submit evidence/ }).click();
  const submitDialog = seller.getByRole('dialog');
  await submitDialog.getByRole('checkbox').first().check();
  await submitDialog.getByRole('button', { name: /Confirmer|Confirm/ }).click();
  await expect(seller.getByText(/Preuves soumises|Evidence submitted/).first()).toBeVisible();

  // Buyer approves → simulated release; wallet of the seller is credited
  await page.goto(txUrl);
  await page
    .getByRole('button', { name: /Valider et libérer|Approve & release/ })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Confirmer|Confirm/ })
    .click();
  await expect(page.getByText(/Libéré \(fictif\)|Released \(simulated\)/).first()).toBeVisible();
  await seller.goto('/wallet');
  await expect(seller.getByText(/9\u00a0250,00|9,250\.00/).first()).toBeVisible();
  await sellerContext.close();
});
