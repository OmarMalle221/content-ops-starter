// WCAG 1.4.10 (redistribution) : à 320 px de large (zoom de 400 % sur un écran de 1280 px), aucune page ne
// défile horizontalement.
import { expect, type Page } from '@playwright/test';
import { createFileWithConsent, onboard, resetBackend, test, waitForTitle } from './helpers';

test.use({ viewport: { width: 320, height: 640 } });

test.beforeEach(async () => {
    await resetBackend();
});

async function expectNoHorizontalScroll(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `défilement horizontal sur ${path}`).toBeLessThanOrEqual(0);
}

test('aucune page ne défile horizontalement à 320 px', async ({ page }) => {
    for (const path of ['/', '/connexion', '/aide', '/confidentialite']) await expectNoHorizontalScroll(page, path);

    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé', 'Mon bilan de la semaine', 'Évaluation du pilote']);
    const fileUrl = await createFileWithConsent(page, 'Maman');
    await waitForTitle(page, 'Profil');
    const paths = [
        '/accueil',
        '/mes-consentements',
        '/compte',
        '/bilan',
        '/parler-a-une-intervenante',
        '/evaluation',
        fileUrl,
        `${fileUrl}/profil`,
        `${fileUrl}/contacts`,
        `${fileUrl}/membres`,
        `${fileUrl}/consentement`,
        `${fileUrl}/journal`,
        `${fileUrl}/parametres`,
        `${fileUrl}/documents`,
        `${fileUrl}/chronologie`,
        `${fileUrl}/droits`,
        `${fileUrl}/taches`,
        `${fileUrl}/agenda`,
        `${fileUrl}/agenda/nouveau`,
        `${fileUrl}/carnet`
    ];
    for (const path of paths) await expectNoHorizontalScroll(page, path);
});
