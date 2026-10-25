// Étape 4 — navigateur de droits, sur la vraie base (RLS, déclencheurs et contrôles réels) avec le vrai code
// serveur et une IA SIMULÉE. Familles fictives : mère de 82 ans à domicile (A), père de 79 ans en RPA (B).
import { expect, type Page } from '@playwright/test';
import {
    backendState,
    createFileWithConsent,
    expectAccessible,
    onboard,
    resetBackend,
    signIn,
    test,
    TOTP_CODE,
    waitForTitle
} from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

const fileNav = (page: Page) => page.getByRole('navigation', { name: 'Sections du dossier' });
const CIPH = 'Crédit d’impôt pour personnes handicapées (CIPH)';

async function setUpFile(page: Page, recipient: { first: string; last: string; birthYear: number; setting: RegExp }): Promise<void> {
    await createFileWithConsent(page, recipient.first === 'Louise' ? 'Maman' : 'Papa');
    await page.getByLabel('Prénom', { exact: true }).fill(recipient.first);
    await page.getByLabel('Nom de famille (facultatif)').fill(recipient.last);
    await page.getByLabel('Année de naissance (facultatif)').fill(String(recipient.birthYear));
    await page.getByRole('radio', { name: recipient.setting }).check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await expect(page.getByText('Profil enregistré.')).toBeVisible();
}

async function answer(page: Page, question: RegExp, choice: 'Oui' | 'Non' | 'Je ne sais pas'): Promise<void> {
    await page.getByRole('group', { name: question }).getByRole('radio', { name: choice, exact: true }).check();
}

/** Chaque carte affichée porte la source, la date de vérification (ou « À VÉRIFIER ») et l'admissibilité à confirmer. */
async function expectEveryCardSourced(page: Page, count: number): Promise<void> {
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(count);
    for (const card of await cards.all()) {
        const source = card.getByTestId('program-source');
        await expect(source).toContainText('Source : ');
        await expect(source).toContainText(/Fiche À VÉRIFIER|Fiche vérifiée le \d/);
        await expect(source).toContainText('Admissibilité à confirmer auprès de : ');
    }
    // Aucun montant, taux ni pourcentage, nulle part.
    expect(await page.locator('main').innerText()).not.toMatch(/\$|%|€/);
}

test('famille A : questionnaire, liste personnalisée sourcée, statut, pièces, explication et lettre sans nom envoyé', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    const year = new Date().getFullYear();
    await setUpFile(page, { first: 'Louise', last: 'Tremblay', birthYear: year - 82, setting: /^À domicile/ });

    await fileNav(page).getByRole('link', { name: 'Droits' }).click();
    await waitForTitle(page, 'Aides et programmes');
    // Prérempli par le profil : âge et milieu de vie.
    await expect(page.getByLabel('Âge de votre proche')).toHaveValue('82');
    await expect(page.getByRole('radio', { name: 'À domicile', exact: true })).toBeChecked();
    await expectAccessible(page);
    await answer(page, /paie-t-il des services/, 'Oui');
    await answer(page, /aide domestique/, 'Oui');
    await answer(page, /incapacité grave/, 'Je ne sais pas');
    await answer(page, /Dépend-il de vous/, 'Je ne sais pas');
    await answer(page, /Habitez-vous avec lui/, 'Non');
    await answer(page, /logement aurait-il besoin/, 'Oui');
    await page.getByRole('button', { name: 'Voir les aides possibles' }).click();

    const likely = page.getByRole('region', { name: 'Vous pourriez y avoir droit' });
    const possible = page.getByRole('region', { name: 'À vérifier : il manque une information' });
    await expect(likely.getByRole('article')).toHaveCount(4);
    await expect(possible.getByRole('article')).toHaveCount(4);
    await expect(likely.getByRole('heading', { name: 'Crédit d’impôt pour maintien à domicile des aînés' })).toBeVisible();
    await expect(possible.getByRole('heading', { name: CIPH })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Peu probable selon vos réponses' })).toHaveCount(0);
    await expectEveryCardSourced(page, 8);
    await expectAccessible(page);

    let state = await backendState();
    expect(state.filePrograms).toHaveLength(8);
    expect(state.filePrograms.every((p) => p.status === 'to_explore')).toBe(true);
    expect(state.checklist.filter((i) => i.origin === 'program').length).toBeGreaterThan(0);
    expect(state.accessLog.map((l) => JSON.stringify(l.metadata)).join()).not.toMatch(/Louise|Tremblay/);

    // Fiche d'un programme : statut, pièces à fournir (de la fiche et ajoutées), notes.
    await possible.getByRole('link', { name: `Voir la fiche et les démarches : ${CIPH}` }).click();
    await waitForTitle(page, CIPH);
    await expect(page.getByTestId('program-source')).toContainText('Fiche À VÉRIFIER');
    await page.getByRole('radio', { name: 'Demande en cours' }).check();
    await expect(page.getByText('Statut enregistré.')).toBeVisible();
    await page.getByRole('checkbox', { name: /Formulaire T2201/ }).check();
    await expect(page.getByRole('checkbox', { name: /Formulaire T2201/ })).toBeChecked();
    await page.getByLabel('Pièce à ajouter').fill('Copie du dernier avis de cotisation');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Copie du dernier avis de cotisation' })).toBeVisible();
    await expectAccessible(page);
    state = await backendState();
    const ciph = state.filePrograms.find((p) => p.slug === 'credit-impot-personnes-handicapees')!;
    expect(ciph.status).toBe('in_progress');
    expect(ciph.requested_at).not.toBeNull();
    expect(state.checklist).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ label: expect.stringContaining('Formulaire T2201'), origin: 'program', is_done: true }),
            { label: 'Copie du dernier avis de cotisation', origin: 'custom', is_done: false }
        ])
    );

    // Explication tirée de la seule fiche (IA simulée), puis servie depuis le cache.
    await page.getByRole('button', { name: 'Expliquer simplement' }).click();
    await expect(page.getByText('La fiche ne précise pas le montant de l’aide.')).toBeVisible();
    await expect(page.getByText(/à partir de cette fiche seulement/)).toBeVisible();
    await page.reload();
    await waitForTitle(page, CIPH);
    await page.getByRole('button', { name: 'Expliquer simplement' }).click();
    await expect(page.getByText('La fiche ne précise pas le montant de l’aide.')).toBeVisible();
    state = await backendState();
    expect(state.aiCalls.filter((c) => c.purpose === 'program_explanation')).toHaveLength(1);
    expect(state.explanations).toHaveLength(1);

    // Lettre : modèle à espaces réservés ; les noms sont ajoutés sur le téléphone, jamais envoyés.
    await page.getByRole('button', { name: 'Préparer la lettre' }).click();
    const letter = page.getByLabel('Votre lettre (modifiable)');
    await expect(letter).toHaveValue(/Louise Tremblay/);
    await expect(letter).toHaveValue(/Claire/);
    await expect(letter).toHaveValue(/\[VOTRE TÉLÉPHONE\]/);
    await page.getByRole('button', { name: 'Enregistrer la lettre dans le dossier' }).click();
    await expect(page.getByText('Lettre enregistrée.')).toBeVisible();
    state = await backendState();
    expect(state.llmInputs).toHaveLength(2);
    for (const input of state.llmInputs) expect(input).not.toMatch(/Louise|Tremblay|Claire|claire@/);
    expect(state.aiCalls.every((c) => c.care_file_id === null && c.model === 'simulated' && c.status === 'ok')).toBe(true);
    expect(state.filePrograms.find((p) => p.slug === 'credit-impot-personnes-handicapees')?.letter_draft).toContain('Louise Tremblay');
});

test('famille B : père de 79 ans en RPA, programmes peu probables repliés mais sourcés', async ({ page }) => {
    await onboard(page, 'denis@example.test', 'Denis', ['Renseignements de santé']);
    await setUpFile(page, {
        first: 'Roger',
        last: 'Gagnon',
        birthYear: new Date().getFullYear() - 79,
        setting: /résidence privée pour aînés/
    });
    await fileNav(page).getByRole('link', { name: 'Droits' }).click();
    await waitForTitle(page, 'Aides et programmes');
    await expect(page.getByLabel('Âge de votre proche')).toHaveValue('79');
    await answer(page, /paie-t-il des services/, 'Oui');
    await answer(page, /aide domestique/, 'Non');
    await answer(page, /incapacité grave/, 'Oui');
    await answer(page, /Dépend-il de vous/, 'Oui');
    await answer(page, /Habitez-vous avec lui/, 'Non');
    await answer(page, /logement aurait-il besoin/, 'Non');
    await page.getByRole('button', { name: 'Voir les aides possibles' }).click();

    await expect(page.getByRole('region', { name: 'Vous pourriez y avoir droit' }).getByRole('article')).toHaveCount(6);
    const unlikely = page.getByRole('region', { name: 'Peu probable selon vos réponses' });
    await unlikely.getByText('Voir les 2 programmes peu probables').click();
    await expect(unlikely.getByRole('heading', { name: /PEFSAD/ })).toBeVisible();
    await expect(unlikely.getByRole('heading', { name: 'Programme d’adaptation de domicile (PAD)' })).toBeVisible();
    await expectEveryCardSourced(page, 8);
    await expectAccessible(page);

    // Seuls les programmes probables ou possibles entrent dans les démarches du dossier.
    const state = await backendState();
    expect(state.filePrograms.map((p) => p.slug).sort()).toEqual(
        [
            'credit-impot-personnes-handicapees',
            'credit-maintien-domicile-aines',
            'credit-personne-aidante',
            'lappui-info-aidant-repit',
            'montant-canadien-aidant-naturel',
            'soutien-domicile-clsc'
        ].sort()
    );
});

test('administration : montant refusé, vérification datée et signée, « je ne sais pas » si l’IA invente', async ({ page }) => {
    await signIn(page, 'admin.ada@example.test');
    await waitForTitle(page, 'Vérification en deux étapes');
    await page.getByLabel('Code de l’application (6 chiffres)').fill(TOTP_CODE);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await waitForTitle(page, 'Bienvenue dans Relais');
    await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    await page.getByLabel('J’accepte : Renseignements de santé').check();
    await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await page.getByLabel('Votre prénom').fill('Ada');
    await page.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(page, 'Bonjour Ada');

    await page.getByRole('link', { name: 'Administration' }).click();
    await waitForTitle(page, 'Administration');
    await page.getByRole('link', { name: 'Fiches des programmes' }).click();
    await waitForTitle(page, 'Fiches des programmes');
    await expect(page.getByText('À vérifier', { exact: true })).toHaveCount(8);
    await expectAccessible(page);
    await page.getByRole('link', { name: CIPH }).click();
    await waitForTitle(page, 'Modifier la fiche');
    await expectAccessible(page);

    // La base refuse tout montant dans une fiche.
    const summary = page.getByLabel('Description factuelle');
    const original = await summary.inputValue();
    await summary.fill(`${original} Jusqu’à 1 000 $ par année.`);
    await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
    await expect(page.getByText(/Refusé : la fiche contient un montant/)).toBeVisible();

    // Fiche vérifiée à la source : date du jour et initiales. (Le marqueur TEST-INVENTION fait inventer
    // un montant à l'IA simulée, pour vérifier le garde-fou plus bas.)
    await summary.fill(`${original} TEST-INVENTION`);
    await page.getByLabel('J’ai vérifié aujourd’hui cette fiche à la source officielle.').check();
    await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
    await expect(page.getByText('Entrez vos initiales pour confirmer la vérification.')).toBeVisible();
    await page.getByLabel('Vos initiales').fill('AL');
    await page.getByRole('button', { name: 'Enregistrer la fiche' }).click();
    await waitForTitle(page, 'Fiches des programmes');
    await expect(page.getByText('Fiche enregistrée.')).toBeVisible();
    await expect(page.getByText(/^Vérifiée le .+ par AL$/)).toBeVisible();
    let state = await backendState();
    const ciph = state.programs.find((p) => p.slug === 'credit-impot-personnes-handicapees')!;
    expect(ciph).toMatchObject({ verification_status: 'verified', verified_by: 'AL', version: 2 });
    expect(ciph.summary).not.toContain('$');

    // Ressource d'aide vérifiée.
    await page.goto('/admin/ressources');
    await waitForTitle(page, 'Ressources d’aide');
    await page.getByText('Info-aidant (L’Appui)').click();
    const resource = page.getByRole('listitem').filter({ hasText: 'Info-aidant (L’Appui)' });
    await resource.getByLabel('J’ai vérifié aujourd’hui cette fiche à la source officielle.').check();
    await resource.getByLabel('Vos initiales').fill('AL');
    await resource.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Ressource enregistrée.')).toBeVisible();
    await expectAccessible(page);
    state = await backendState();
    expect(state.resources.find((r) => r.slug === 'info-aidant')).toMatchObject({ verification_status: 'verified', verified_by: 'AL' });

    // Côté famille : la carte porte la date de vérification ; l'explication inventée est refusée.
    await page.goto('/accueil');
    const fileUrl = await createFileWithConsent(page, 'Maman');
    await page.goto(`${fileUrl}/droits/credit-impot-personnes-handicapees`);
    await waitForTitle(page, CIPH);
    await expect(page.getByTestId('program-source')).toContainText(/Fiche vérifiée le \d/);
    await page.getByRole('button', { name: 'Expliquer simplement' }).click();
    await expect(page.getByText(/Je ne sais pas : Relais n’a pas pu préparer une explication fiable/)).toBeVisible();
    await expect(page.getByText(/1 494/)).toHaveCount(0);
    await expectAccessible(page);
    state = await backendState();
    expect(state.aiCalls).toEqual([expect.objectContaining({ purpose: 'program_explanation', status: 'guard_flagged' })]);
    expect(state.explanations).toHaveLength(0); // rien de refusé n'est mis en cache
});
