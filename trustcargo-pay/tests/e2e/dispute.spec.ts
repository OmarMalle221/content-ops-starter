import { expect, test } from '@playwright/test';
import { confirmDialog, loginAs, loginStaff } from './helpers';

test('a dispute manager decides a refund (MFA) and the partner confirms it', async ({ page }) => {
    await loginStaff(page, 'disputes');
    await page.goto('/admin/disputes');
    await page.getByRole('link', { name: /TC-/ }).first().click();
    await page.waitForURL(/\/admin\/transactions\/[0-9a-f-]{36}/);
    await expect(page.getByText('Documents suspects').first()).toBeVisible();
    await confirmDialog(page, /Rendre une décision/, async (p) => {
        await p.getByLabel('Issue').selectOption('REFUND_TO_BUYER');
        await p
            .getByLabel('Motivation')
            .fill('Le connaissement et la déclaration d’exportation ne correspondent pas au véhicule vendu ; aucune correction fournie.');
        await p.getByLabel('Clause contractuelle appliquée').fill('Conditions de remboursement');
    });
    await expect(page.getByText('Remboursement en cours').first()).toBeVisible();
    const txPath = new URL(page.url()).pathname;

    await loginStaff(page, 'finance');
    await page.goto(`${txPath}?tab=payments`);
    await page.getByTestId('sim-transfer-paid').first().click();
    await expect(page.getByText('Remboursée').first()).toBeVisible();

    await loginAs(page, 'buyer');
    await page.goto('/transactions');
    await expect(page.getByRole('row', { name: /Lexus/ }).getByText('Remboursée')).toBeVisible();
});

test('the buyer can open a dispute, which freezes payouts', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.goto('/transactions');
    await page.getByRole('link', { name: 'Toyota RAV4 2021' }).first().click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    await page.goto(`${new URL(page.url()).pathname}?tab=disputes`);
    await confirmDialog(page, 'Ouvrir un litige', async (p) => {
        await p.getByLabel('Motif').selectOption('NOT_AS_DESCRIBED');
        await p
            .getByLabel('Description du problème')
            .fill('Les photos de chargement montrent des dommages non déclarés sur la portière avant gauche.');
        await p.getByLabel('Résultat souhaité').fill('Réduction de prix');
    });
    await expect(page.getByText('En litige').first()).toBeVisible();
    await expect(page.getByText('Réponse attendue').first()).toBeVisible();
});
