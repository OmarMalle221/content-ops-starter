// Étape 2 — dossier familial et membres, sur la vraie base (RLS réelle via le faux Supabase).
import { devices, expect, type Browser, type Page } from '@playwright/test';
import { backendState, expectAccessible, onboard, resetBackend, signIn, test, waitForTitle } from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

/** Crée le dossier « Maman » et enregistre le formulaire de consentement signé. Renvoie l'adresse du dossier. */
async function createFileWithConsent(page: Page): Promise<string> {
    await page.getByRole('link', { name: 'Créer le dossier d’un proche' }).click();
    await waitForTitle(page, 'Créer le dossier d’un proche');
    await page.getByLabel('Nom du dossier').fill('Maman');
    await page.getByRole('button', { name: 'Créer le dossier' }).click();
    await waitForTitle(page, 'Consentement de la personne aidée');
    await page.getByRole('radio', { name: /a signé le formulaire/ }).check();
    await page.getByLabel(/J’atteste que mon proche a lu/).check();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await waitForTitle(page, 'Profil');
    return new URL(page.url()).pathname.replace(/\/profil$/, '');
}

async function invite(page: Page, fileUrl: string, email: string, kind: RegExp, level?: string): Promise<string> {
    await page.goto(`${fileUrl}/membres`);
    await waitForTitle(page, 'Membres');
    await page.getByLabel('Son adresse courriel').fill(email);
    await page.getByRole('radio', { name: kind }).check();
    if (level) await page.getByRole('radio', { name: level }).check();
    await page.getByRole('button', { name: 'Créer le lien d’invitation' }).click();
    const link = page.getByLabel('Lien d’invitation');
    await expect(link).toHaveValue(/\/invitation#[0-9a-f]{64}$/);
    return link.inputValue();
}

async function phonePage(browser: Browser): Promise<Page> {
    const context = await browser.newContext({ ...devices['Pixel 7'], locale: 'fr-CA', timezoneId: 'America/Toronto' });
    return context.newPage();
}

test('aidante principale : dossier, consentement, profil, besoins et contacts', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    await expect(page.getByText(/Vous n’avez pas encore de dossier/)).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('link', { name: 'Créer le dossier d’un proche' }).click();
    await waitForTitle(page, 'Créer le dossier d’un proche');
    await expectAccessible(page);
    await page.getByLabel('Nom du dossier').fill('Maman');
    await page.getByRole('button', { name: 'Créer le dossier' }).click();

    // Sans consentement, la page l'exige ; le formulaire imprimable est proposé.
    await waitForTitle(page, 'Consentement de la personne aidée');
    await expectAccessible(page);
    await page.getByRole('radio', { name: /a signé le formulaire/ }).check();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Cochez l’attestation pour continuer.')).toBeVisible();
    await page.getByLabel(/J’atteste que mon proche a lu/).check();
    await page.getByRole('button', { name: 'Enregistrer' }).click();

    await waitForTitle(page, 'Profil');
    await page.getByLabel('Prénom', { exact: true }).fill('Louise');
    await page.getByLabel('Année de naissance (facultatif)').fill('1944');
    await page.getByRole('radio', { name: 'En résidence privée pour aînés (RPA)' }).check();
    await page.getByLabel('Nom de la résidence (facultatif)').fill('Les Jardins');
    await page.getByLabel('En attente d’une place en CHSLD').check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await expect(page.getByText('Profil enregistré.')).toBeVisible();

    await page.getByLabel('Autonomie, décrite par vous').fill('Aide pour le bain, ne conduit plus.');
    await page.getByLabel('Soutien à domicile du CLSC').check();
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByText('Renseignements enregistrés.')).toBeVisible();
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Sections du dossier' }).getByRole('link', { name: 'Contacts' }).click();
    await waitForTitle(page, 'Contacts clés');
    await page.getByRole('button', { name: 'Ajouter un contact' }).click();
    await page.getByLabel('Type').selectOption('clsc');
    await page.getByLabel('Nom', { exact: true }).fill('CLSC du quartier');
    await page.getByLabel('Téléphone (facultatif)').fill('514 555-0101');
    await page.getByRole('button', { name: 'Enregistrer le contact' }).click();
    await expect(page.getByText('Contact enregistré.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Appeler CLSC du quartier' })).toHaveAttribute('href', 'tel:5145550101');
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Sections du dossier' }).getByRole('link', { name: 'Aperçu' }).click();
    await waitForTitle(page, 'Maman');
    await expect(page.getByText('Louise, ')).toBeVisible();
    await expect(page.getByText('En attente d’une place en CHSLD')).toBeVisible();
    await expectAccessible(page);

    const state = await backendState();
    expect(state.careRecipients).toEqual([expect.objectContaining({ first_name: 'Louise', living_setting: 'rpa' })]);
    expect(state.contacts).toEqual([expect.objectContaining({ kind: 'clsc', created_by: state.users[0]?.id })]);
    expect(state.consents.filter((c) => c.care_file_id !== null)).toEqual([
        expect.objectContaining({
            consent_type: 'care_recipient_data',
            granted_by: 'care_recipient_signed_form',
            legal_basis: 'person_consents'
        })
    ]);
});

test('saisie libre du dossier : l’écran d’urgence s’affiche et le texte est gardé', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    await createFileWithConsent(page);
    const field = page.getByLabel('Autonomie, décrite par vous');
    await field.fill('Honnêtement, je n’en peux plus');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('Ce que vous vivez est lourd. Vous pouvez en parler maintenant.');
    await expect(dialog.getByRole('link', { name: 'Appeler le 911' })).toHaveAttribute('href', 'tel:911');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Revenir à ma saisie' }).click();
    await expect(dialog).toBeHidden();
    await expect(field).toHaveValue('Honnêtement, je n’en peux plus');
});

test('invitations : coordination, lecture des droits, mauvaise adresse, journal', async ({ page, browser }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    const fileUrl = await createFileWithConsent(page);
    await page.getByLabel('Prénom', { exact: true }).fill('Louise');
    await page.getByRole('radio', { name: 'À domicile' }).check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await page.getByLabel('Autonomie, décrite par vous').fill('Aide pour le bain.');
    await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect(page.getByText('Renseignements enregistrés.')).toBeVisible();

    const emmaLink = await invite(page, fileUrl, 'emma@example.test', /Un membre de la famille/, 'Coordination seulement');
    await expect(page.getByText('emma@example.test', { exact: true })).toBeVisible();
    await expectAccessible(page);

    // Le lien ouvert par quelqu'un d'autre ne fonctionne pas.
    const olivier = await phonePage(browser);
    await onboard(olivier, 'olivier@example.test', 'Olivier');
    await olivier.goto(emmaLink);
    await waitForTitle(olivier, 'Invitation');
    await olivier.getByRole('button', { name: 'Rejoindre le dossier' }).click();
    await expect(olivier.getByText(/envoyée à une autre adresse courriel/)).toBeVisible();

    // Emma : lien reçu, connexion, accueil des nouveaux, puis invitation acceptée.
    const emma = await phonePage(browser);
    await emma.goto(emmaLink);
    await waitForTitle(emma, 'Invitation');
    await expect(emma).toHaveURL(/\/invitation$/); // jeton retiré de l'adresse affichée
    await emma.getByRole('link', { name: 'Me connecter pour accepter' }).click();
    await waitForTitle(emma, 'Se connecter');
    await emma.getByLabel('Votre adresse courriel').fill('emma@example.test');
    await emma.getByRole('button', { name: 'Recevoir un code' }).click();
    await emma.getByLabel('Code à 6 chiffres').fill('123456');
    await emma.getByRole('button', { name: 'Me connecter' }).click();
    await waitForTitle(emma, 'Bienvenue dans Relais');
    await emma.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    await emma.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await emma.getByLabel('Votre prénom').fill('Emma');
    await emma.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(emma, 'Bonjour Emma');
    await emma.getByRole('link', { name: 'Voir l’invitation' }).click();
    await waitForTitle(emma, 'Invitation');
    await emma.getByRole('button', { name: 'Rejoindre le dossier' }).click();
    await waitForTitle(emma, 'Maman');

    // Coordination : pas d'onglet Journal ni Paramètres, profil visible, santé masquée par la base.
    const tabs = emma.getByRole('navigation', { name: 'Sections du dossier' });
    await expect(tabs.getByRole('link', { name: 'Journal' })).toHaveCount(0);
    await expect(tabs.getByRole('link', { name: 'Paramètres' })).toHaveCount(0);
    await tabs.getByRole('link', { name: 'Profil' }).click();
    await waitForTitle(emma, 'Profil');
    await expect(emma.getByText('Vous pouvez consulter cette section sans la modifier.')).toBeVisible();
    await expect(emma.getByRole('heading', { name: 'Autonomie et services' })).toHaveCount(0);
    await expectAccessible(emma);
    // Même en tapant l'adresse, le journal reste réservé.
    await emma.goto(`${fileUrl}/journal`);
    await expect(emma.getByText('Cette section est réservée à la personne aidante principale du dossier.')).toBeVisible();
    // Coordination : peut ajouter un contact.
    await emma.goto(`${fileUrl}/contacts`);
    await waitForTitle(emma, 'Contacts clés');
    await emma.getByRole('button', { name: 'Ajouter un contact' }).click();
    await emma.getByLabel('Type').selectOption('pharmacy');
    await emma.getByLabel('Nom', { exact: true }).fill('Pharmacie du coin');
    await emma.getByRole('button', { name: 'Enregistrer le contact' }).click();
    await expect(emma.getByText('Contact enregistré.')).toBeVisible();

    // L'aidante principale voit le journal, change le niveau d'Emma, puis la retire.
    await page.goto(`${fileUrl}/journal`);
    await waitForTitle(page, 'Journal des accès');
    await expect(page.getByText('Emma a rejoint le dossier')).toBeVisible();
    await expect(page.getByText('Emma a ouvert le dossier').first()).toBeVisible();
    await expectAccessible(page);
    await page.goto(`${fileUrl}/membres`);
    await waitForTitle(page, 'Membres');
    await page.getByLabel('Niveau d’accès de Emma').selectOption('read_only');
    await expect(page.getByText('Niveau d’accès modifié.')).toBeVisible();
    await page.getByRole('button', { name: 'Retirer du dossier : Emma' }).click();
    await page.getByRole('group', { name: 'Retirer Emma du dossier ?' }).getByRole('button', { name: 'Retirer du dossier' }).click();
    await expect(page.getByText('Membre retiré.')).toBeVisible();

    await emma.goto(fileUrl);
    await expect(emma.getByText('Ce dossier n’existe pas, ou vous n’y avez plus accès.')).toBeVisible();

    const state = await backendState();
    const actions = state.accessLog.map((l) => l.action);
    expect(actions).toEqual(
        expect.arrayContaining(['member_invited', 'member_joined', 'member_access_changed', 'member_removed', 'file_opened'])
    );
});

test('paramètres : export du dossier, refus de supprimer le compte, suppression du dossier', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire');
    const fileUrl = await createFileWithConsent(page);
    await page.getByLabel('Prénom', { exact: true }).fill('Louise');
    await page.getByRole('radio', { name: 'À domicile' }).check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await expect(page.getByText('Profil enregistré.')).toBeVisible();

    // La suppression du compte est refusée tant qu'un dossier existe.
    await page.goto('/compte');
    await waitForTitle(page, 'Mon compte');
    await page.getByLabel('Je comprends que la suppression est définitive.').check();
    await page.getByRole('button', { name: 'Supprimer mon compte' }).click();
    await expect(page.getByText(/Supprimez d’abord ce dossier/)).toBeVisible();

    await page.goto(`${fileUrl}/parametres`);
    await waitForTitle(page, 'Paramètres du dossier');
    await expectAccessible(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Télécharger le dossier' }).click();
    const file = await download;
    const chunks = await (await file.createReadStream()).toArray();
    const content = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    expect(content).toMatchObject({ format: 'relais-dossier/1', care_recipient: { first_name: 'Louise' } });

    await page.getByLabel('Je comprends que la suppression est définitive.').check();
    await page.getByRole('button', { name: 'Supprimer le dossier' }).click();
    await waitForTitle(page, 'Bonjour Claire');
    await expect(page.getByText('Le dossier « Maman » a été supprimé.')).toBeVisible();

    const fileId = fileUrl.split('/').pop();
    const state = await backendState();
    expect(state.careFiles).toHaveLength(0);
    expect(state.careRecipients).toHaveLength(0);
    expect(state.consents.filter((c) => c.care_file_id !== null)).toHaveLength(0);
    expect(state.accessLog.filter((l) => l.care_file_id === fileId).map((l) => l.action)).toEqual(['care_file_deleted']);
});

test('la personne aidée peut donner et retirer son accord elle-même', async ({ page, browser }) => {
    await onboard(page, 'claire@example.test', 'Claire');
    await page.getByRole('link', { name: 'Créer le dossier d’un proche' }).click();
    await page.getByLabel('Nom du dossier').fill('Maman');
    await page.getByRole('button', { name: 'Créer le dossier' }).click();
    await waitForTitle(page, 'Consentement de la personne aidée');
    const fileUrl = new URL(page.url()).pathname.replace(/\/consentement$/, '');
    // Inviter la personne aidée est possible avant tout consentement.
    const link = await invite(page, fileUrl, 'helene@example.test', /Mon proche lui-même/);

    const helene = await phonePage(browser);
    await signIn(helene, 'helene@example.test');
    await helene.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    await helene.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await helene.getByLabel('Votre prénom').fill('Hélène');
    await helene.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(helene, 'Bonjour Hélène');
    await helene.goto(link);
    await helene.getByRole('button', { name: 'Rejoindre le dossier' }).click();
    await waitForTitle(helene, 'Maman');
    await helene.getByRole('navigation', { name: 'Sections du dossier' }).getByRole('link', { name: 'Consentement' }).click();
    await waitForTitle(helene, 'Consentement de la personne aidée');
    await expect(helene.getByText('Ce dossier vous concerne.', { exact: false })).toBeVisible();
    await helene.getByRole('button', { name: 'Je donne mon accord' }).click();
    await expect(helene.getByRole('heading', { name: 'Consentement en vigueur' })).toBeVisible();
    await expectAccessible(helene);
    await helene.getByRole('button', { name: 'Retirer le consentement' }).click();
    await helene.getByRole('button', { name: 'Confirmer le retrait' }).click();
    await expect(helene.getByText(/Consentement retiré le/)).toBeVisible();

    // L'aidante ne peut plus que demander l'accord d'un représentant légal.
    await page.goto(`${fileUrl}/consentement`);
    await waitForTitle(page, 'Consentement de la personne aidée');
    await expect(page.getByText(/Votre proche a retiré son accord lui-même/)).toBeVisible();
    await expect(page.getByRole('radio', { name: /a signé le formulaire/ })).toHaveCount(0);
});
