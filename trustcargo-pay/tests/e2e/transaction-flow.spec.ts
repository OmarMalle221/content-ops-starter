import { expect, test } from '@playwright/test';
import { confirmDialog, loginAs, pdfFile } from './helpers';

test.describe.configure({ mode: 'serial' });

let transactionUrl = '';
let inviteUrl = '';

test('seller creates a vehicle transaction through the 7-step wizard', async ({ page }) => {
    await loginAs(page, 'seller');
    await page.goto('/transactions/new');
    await page.getByTestId('wizard-next').click();

    await page.getByLabel('Marque').fill('Toyota');
    await page.getByLabel('Modèle').fill('Camry');
    await page.getByLabel('Année').fill('2020');
    await page.getByLabel('Kilométrage (km)').fill('80500');
    await page.getByLabel('VIN (17 caractères)').fill('2T3W1RFV8MC123456');
    await page.getByLabel('Prix').fill('15900');
    await page.getByTestId('wizard-next').click();
    // Local VIN check catches the typo (wrong check digit) before anything is created.
    await expect(page.getByText(/Structure invalide/)).toBeVisible();
    await page.getByLabel('VIN (17 caractères)').fill('2T3W1RFV7MC123456');
    await page.getByTestId('wizard-next').click();

    await page.getByLabel('Nom complet').fill('Cheikh Fall');
    await page.getByLabel('Courriel').fill('cheikh.fall@demo.trustcargo.test');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByLabel('Description du bien')).toHaveValue(/Toyota Camry 2020/);
    await page.getByTestId('wizard-next').click();

    await expect(page.getByTestId('milestone-total')).toContainText('100');
    await page.getByLabel('Part (%)').first().fill('15');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByRole('alert').filter({ hasText: /somme des jalons/ })).toBeVisible();
    await page.getByLabel('Part (%)').first().fill('10');
    await page.getByTestId('wizard-next').click();

    await expect(page.getByText('Vérifiez les informations')).toBeVisible();
    await page.getByTestId('wizard-create').click();
    await expect(page.getByText('Transaction créée')).toBeVisible();
    inviteUrl = (await page.getByTestId('invite-link').first().textContent())!;
    expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{30,}/);
    await page.getByRole('link', { name: 'Ouvrir la transaction' }).click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    await expect(page.getByText('En attente des parties').first()).toBeVisible();
    transactionUrl = new URL(page.url()).pathname;

    // Documents the corridor requires before the buyer may pay.
    await page.goto(`${transactionUrl}?tab=documents`);
    for (const [type, label] of [
        ['TITLE', 'titre'],
        ['INVOICE', 'facture']
    ] as const) {
        await page.getByLabel('Type de document').selectOption(type);
        await page.getByLabel(/^Fichier/).setInputFiles(pdfFile(label));
        await page.getByRole('button', { name: 'Déposer un document' }).click();
        await expect(page.getByText('Action effectuée.')).toBeVisible();
    }
});

test('an invitation cannot be used by another account', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.goto(new URL(inviteUrl).pathname);
    await page.getByTestId('join-transaction').click();
    await expect(page.getByText('Vous n’êtes pas autorisé à effectuer cette action.')).toBeVisible();
});

test('buyer joins, verifies identity (simulated) and accepts the contract', async ({ page }) => {
    await loginAs(page, 'buyer2');
    await page.goto(new URL(inviteUrl).pathname);
    await expect(page.getByText('Toyota Camry 2020')).toBeVisible();
    await page.getByTestId('join-transaction').click();
    await page.waitForURL(/tab=contract/);
    await expect(page.getByText('Vérifiez votre identité pour pouvoir accepter.')).toBeVisible();

    await page.goto('/verification');
    await page.getByTestId('kyc-start').click();
    await page.getByTestId('kyc-approve').click();
    await expect(page.getByText('Vérifiée').first()).toBeVisible();

    await page.goto(`${transactionUrl}?tab=contract`);
    await confirmDialog(page, /J’accepte ces conditions/);
    await expect(page.getByText('En attente de financement').first()).toBeVisible();
});

test('funding only moves through signed partner events (simulator)', async ({ page }) => {
    await loginAs(page, 'buyer2');
    await page.goto(`${transactionUrl}?tab=payments`);
    await expect(page.getByText(/aucun argent réel/i).first()).toBeVisible();
    await page.getByRole('button', { name: 'Obtenir les instructions de paiement' }).click();
    await expect(
        page.getByText('PARTENAIRE FINANCIER SIMULÉ', { exact: false }).or(page.getByText('Partenaire financier simulé (SIMULATION)'))
    ).toBeVisible();
    await expect(page.getByText('SIM •••• 0000')).toBeVisible();
    await page.getByTestId('sim-fund-ok').click();
    await expect(page.getByText('En cours').first()).toBeVisible();
    await expect(page.getByText('15 900,00 $').first()).toBeVisible();
});

test('seller provides evidence, buyer approves, partner executes the payout', async ({ page }) => {
    await loginAs(page, 'seller');
    await page.goto(`${transactionUrl}?tab=milestones`);
    const m1 = page.getByTestId('milestone-1');
    await m1.getByLabel('Type de document').selectOption('INSPECTION_REPORT');
    await m1.getByLabel(/^Fichier/).setInputFiles(pdfFile('inspection'));
    await m1.getByRole('button', { name: 'Déposer un document' }).click();
    await expect(m1.getByText('Action effectuée.')).toBeVisible();
    // The title uploaded before funding is reused as evidence.
    await m1.getByLabel('Joindre un document déjà déposé').selectOption({ label: 'Titre de propriété — Titre de propriété' });
    await m1.getByRole('button', { name: 'Joindre' }).click();
    await expect(m1.getByRole('button', { name: 'Demander la validation' })).toBeEnabled();
    await m1.getByRole('button', { name: 'Demander la validation' }).click();
    await expect(page.getByText('Jalon à valider').first()).toBeVisible();

    await loginAs(page, 'buyer2');
    await page.goto(`${transactionUrl}?tab=milestones`);
    await confirmDialog(page, 'Approuver le jalon');
    await page.goto(`${transactionUrl}?tab=payments`);
    await expect(page.getByText('Transmis au partenaire')).toBeVisible();
    await page.getByTestId('sim-transfer-paid').click();
    await expect(page.getByText('Exécuté').first()).toBeVisible();
    await page.goto(`${transactionUrl}?tab=milestones`);
    await expect(page.getByTestId('milestone-1').getByText('Versé')).toBeVisible();
});

test('documents open through short-lived signed links only', async ({ page, request }) => {
    await loginAs(page, 'buyer2');
    await page.goto(`${transactionUrl}?tab=documents`);
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Ouvrir' }).first().click();
    const doc = await popup;
    await doc.waitForLoadState();
    expect(doc.url()).toMatch(/\/api\/v1\/documents\/.+\/content\?exp=\d+&sig=[0-9a-f]{64}/);
    // Same URL without the session cookie is refused.
    const anonymous = await request.get(doc.url(), { headers: { cookie: '' } });
    expect(anonymous.status()).toBe(401);
});
