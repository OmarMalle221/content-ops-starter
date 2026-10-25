import { expect } from '@playwright/test';
import { backendState, expectAccessible, onboard, resetBackend, signIn, test, TOTP_CODE, waitForTitle } from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

test('page d’accueil publique : ce que Relais est et n’est pas, aide immédiate visible', async ({ page }) => {
    await page.goto('/');
    await waitForTitle(page, 'Relais');
    await expect(page.getByRole('heading', { name: 'Ce que Relais n’est pas' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'Aide immédiate' })).toBeVisible();
    await expectAccessible(page);
});

test('aide immédiate sans connexion : numéros tirés de la table de ressources', async ({ page }) => {
    await page.goto('/aide');
    await waitForTitle(page, 'Aide immédiate');
    await expect(page.getByRole('link', { name: 'Appeler le 911' })).toHaveAttribute('href', 'tel:911');
    await expect(page.getByRole('link', { name: 'Appeler le 988' })).toHaveAttribute('href', 'tel:988');
    await expect(page.getByRole('link', { name: 'Texto au 988' })).toHaveAttribute('href', 'sms:988');
    await expect(page.getByRole('heading', { name: 'Info-Santé 811' })).toBeVisible();
    await expectAccessible(page);
});

test('politique de confidentialité lisible avant de créer un compte', async ({ page }) => {
    await page.goto('/confidentialite');
    await waitForTitle(page, 'Comment Relais protège vos renseignements');
    await expect(page.getByRole('heading', { name: 'Où' })).toBeVisible();
    await expectAccessible(page);
});

test('nouveau compte : code par courriel, consentements distincts, prénom', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Commencer' }).click();
    await waitForTitle(page, 'Se connecter');
    await expectAccessible(page);

    await page.getByLabel('Votre adresse courriel').fill('louise@example.test');
    await page.getByRole('button', { name: 'Recevoir un code' }).click();
    await expect(page.getByText('Nous avons envoyé un code à louise@example.test.')).toBeVisible();
    await page.getByLabel('Code à 6 chiffres').fill('000000');
    await page.getByRole('button', { name: 'Me connecter' }).click();
    await expect(page.getByText(/Ce code ne fonctionne pas/)).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel(/Code à 6 chiffres/).fill('123456');
    await page.getByRole('button', { name: 'Me connecter' }).click();

    await waitForTitle(page, 'Bienvenue dans Relais');
    await expect(page.getByRole('checkbox')).toHaveCount(4);
    for (const box of await page.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
    await expectAccessible(page);

    await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await expect(page.getByRole('alert')).toContainText('vous devez accepter la politique de confidentialité');

    await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    await page.getByLabel('J’accepte : Renseignements de santé').check();
    await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();

    await waitForTitle(page, 'Comment voulez-vous qu’on vous appelle ?');
    await expectAccessible(page);
    await page.getByLabel('Votre prénom').fill('Louise');
    await page.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(page, 'Bonjour Louise');
    await expectAccessible(page);

    const state = await backendState();
    const active = state.consents.filter((c) => c.revoked_at === null).map((c) => c.consent_type);
    expect(active.sort()).toEqual(['health_information', 'privacy_policy']);
    expect(state.users[0]?.display_name).toBe('Louise');
});

test('mes consentements : retrait confirmé puis nouvel accord', async ({ page }) => {
    await onboard(page, 'marc@example.test', 'Marc', ['Renseignements de santé']);
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Mes consentements' }).click();
    await waitForTitle(page, 'Mes consentements');
    await expectAccessible(page);

    const health = page.locator('section', { has: page.getByRole('heading', { name: 'Renseignements de santé' }) });
    await health.getByRole('button', { name: 'Retirer ce consentement' }).click();
    await expect(health.getByRole('group', { name: /Retirer le consentement/ })).toBeVisible();
    await expectAccessible(page);
    await health.getByRole('button', { name: 'Confirmer le retrait' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Consentement retiré.' })).toBeVisible();
    await expect(health.getByText(/Retiré le/)).toBeVisible();

    await health.getByRole('button', { name: 'Accorder ce consentement' }).click();
    await expect(health.getByText(/Accordé le/)).toBeVisible();

    const state = await backendState();
    const health_rows = state.consents.filter((c) => c.consent_type === 'health_information');
    expect(health_rows).toHaveLength(2);
    expect(health_rows.filter((c) => c.revoked_at === null)).toHaveLength(1);
});

test('mon compte : export de mes renseignements, puis suppression du compte', async ({ page }) => {
    await onboard(page, 'nadine@example.test', 'Nadine');
    await page.goto('/compte');
    await waitForTitle(page, 'Mon compte');
    await expectAccessible(page);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Télécharger mes renseignements' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^relais-mes-renseignements-\d{4}-\d{2}-\d{2}\.json$/);
    const content = JSON.parse(await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
    expect(content.format).toBe('relais-export/1');
    expect(content.account.email).toBe('nadine@example.test');

    const remove = page.getByRole('button', { name: 'Supprimer mon compte' });
    await expect(remove).toBeDisabled();
    await page.getByLabel('Je comprends que la suppression est définitive.').check();
    await remove.click();
    await expect(page.getByText('Votre compte a été supprimé.')).toBeVisible();
    await waitForTitle(page, 'Relais');

    const state = await backendState();
    expect(state.users).toHaveLength(0);
    expect(state.consents).toHaveLength(0);
    expect(state.accessLog.map((l) => l.action)).toContain('account_deleted');
});

test('intervenante : vérification en deux étapes obligatoire', async ({ page }) => {
    await signIn(page, 'intervenante.nadia@example.test');
    await waitForTitle(page, 'Vérification en deux étapes');
    await expect(page.getByRole('img', { name: /Code QR/ })).toBeVisible();
    await expectAccessible(page);

    // Inscription abandonnée puis reprise : l'ancien facteur non vérifié est retiré.
    await page.reload();
    await waitForTitle(page, 'Vérification en deux étapes');
    await expect(page.getByRole('img', { name: /Code QR/ })).toBeVisible();
    const pending = await backendState();
    expect(pending.users[0]?.factors).toHaveLength(1);

    await page.getByLabel('Code de l’application (6 chiffres)').fill('111111');
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await expect(page.getByText(/Ce code ne fonctionne pas/)).toBeVisible();

    await page.getByLabel(/Code de l’application/).fill(TOTP_CODE);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await waitForTitle(page, 'Bienvenue dans Relais');
});

test('pages protégées : redirection vers la connexion', async ({ page }) => {
    await page.goto('/compte');
    await waitForTitle(page, 'Se connecter');
});

test('application installable (PWA) en français, sous la CSP de production', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const manifest = await (await page.request.get(href as string)).json();
    expect(manifest).toMatchObject({ name: 'Relais', lang: 'fr-CA', display: 'standalone', start_url: '/' });
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined)).toBe(true);
});
