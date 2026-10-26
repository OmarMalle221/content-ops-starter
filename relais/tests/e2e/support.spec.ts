// Étape 6 — bilan privé, demandes d'intervenante, tableau de suivi (MFA), évaluation du pilote et mesures
// agrégées. Plusieurs personnes à la fois : chacune dans son propre contexte de navigateur.
import { devices, expect, type Browser, type Page } from '@playwright/test';
import { backendState, expectAccessible, onboard, resetBackend, signIn, test, TOTP_CODE, waitForTitle } from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

async function newPersona(browser: Browser): Promise<Page> {
    const context = await browser.newContext({
        ...devices['Pixel 7'],
        baseURL: 'http://127.0.0.1:4173',
        locale: 'fr-CA',
        timezoneId: 'America/Toronto'
    });
    return context.newPage();
}

/** Compte interne (intervenante ou admin) : vérification en deux étapes, puis accueil. */
async function staff(page: Page, email: string, name: string): Promise<void> {
    await signIn(page, email);
    await waitForTitle(page, 'Vérification en deux étapes');
    await page.getByLabel('Code de l’application (6 chiffres)').fill(TOTP_CODE);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await waitForTitle(page, 'Bienvenue dans Relais');
    await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await page.getByLabel('Votre prénom').fill(name);
    await page.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(page, `Bonjour ${name}`);
}

async function answerCheckin(page: Page, values: [number, number, number]): Promise<void> {
    const questions = [/manqué d’énergie/, /ne plus arriver à tout faire/, /porter tout ça sans aide/];
    for (const [i, question] of questions.entries()) {
        await page
            .getByRole('group', { name: question })
            .getByRole('radio', { name: new RegExp(`^${values[i]} — `) })
            .check();
    }
    await page.getByRole('button', { name: 'Voir mon bilan' }).click();
}

test('bilan privé, demandes d’intervenante (bilan et écran d’urgence), avis sans contenu, tableau de suivi', async ({ page, browser }) => {
    // L'intervenante existe avant les demandes : elle reçoit les avis.
    const nadia = await newPersona(browser);
    await staff(nadia, 'intervenante.nadia@example.test', 'Nadia');
    await expect(nadia.getByRole('link', { name: 'Tableau de suivi des demandes' })).toBeVisible();

    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé', 'Mon bilan de la semaine']);
    await page.getByRole('link', { name: /Comment allez-vous cette semaine/ }).click();
    await waitForTitle(page, 'Comment allez-vous cette semaine ?');
    await expect(page.getByText(/gardées pour vous seulement/)).toBeVisible();
    await expectAccessible(page);
    await answerCheckin(page, [4, 4, 4]);
    await expect(page.getByRole('heading', { name: 'Cette semaine semble lourde.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Info-aidant (L’Appui)' })).toBeVisible();
    await expectAccessible(page);
    let state = await backendState();
    const claireId = state.users.find((u) => u.email === 'claire@example.test')!.id;
    expect(state.checkins).toEqual([expect.objectContaining({ user_id: claireId, fatigue: 4, overwhelm: 4, isolation: 4 })]);

    // Demande depuis le bilan : les réponses ne sont pas transmises.
    await page.getByRole('link', { name: 'Parler à une intervenante' }).click();
    await waitForTitle(page, 'Parler à une intervenante');
    await expect(page.getByText('Vos réponses au bilan ne sont pas transmises.')).toBeVisible();
    await page.getByLabel('Votre numéro de téléphone').fill('514 555-0101');
    await page.getByLabel('Quand vous joindre ? (facultatif)').fill('En soirée');
    await page.getByRole('button', { name: 'Envoyer ma demande' }).click();
    await expect(page.getByText(/Votre demande est envoyée/)).toBeVisible();
    await expect(page.getByText('Reçue : une intervenante va vous contacter.')).toBeVisible();

    // Écran d'urgence déclenché par le message : rappel demandé sur place, saisie conservée.
    await page.goto('/parler-a-une-intervenante');
    await waitForTitle(page, 'Parler à une intervenante');
    await page.getByLabel('Ce dont vous voulez parler (facultatif)').fill('Je n’en peux plus, je veux mourir');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('link', { name: /9-8-8|988/ }).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Demander qu’on me rappelle' }).click();
    await dialog.getByRole('radio', { name: /Par courriel/ }).check();
    await dialog.getByRole('button', { name: 'Envoyer ma demande' }).click();
    await expect(dialog.getByText(/Votre demande est envoyée/)).toBeVisible();
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Revenir à ma saisie' }).click();
    await expect(page.getByLabel('Ce dont vous voulez parler (facultatif)')).toHaveValue('Je n’en peux plus, je veux mourir');

    state = await backendState();
    expect(state.supportRequests.map((r) => [r.origin, r.preferred_contact, r.email, Boolean(r.notified_at)])).toEqual([
        ['checkin', 'phone', null, true],
        ['distress_screen', 'email', 'claire@example.test', true]
    ]);
    // Avis aux intervenantes : origine seulement, aucun renseignement sur la personne.
    expect(state.emails.map((e) => [e.to, e.subject])).toEqual([
        ['intervenante.nadia@example.test', 'Relais : nouvelle demande d’intervenante'],
        ['intervenante.nadia@example.test', 'Relais : nouvelle demande (écran d’urgence)']
    ]);
    expect(JSON.stringify(state.emails)).not.toMatch(/Claire|claire@|514|soirée|mourir/);

    // Tableau de suivi : l'écran d'urgence en premier ; rien du bilan.
    await nadia.getByRole('link', { name: 'Tableau de suivi des demandes' }).click();
    await waitForTitle(nadia, 'Demandes d’intervenante');
    await expect(nadia.getByRole('radio', { name: 'Nouvelles (2)' })).toBeChecked();
    await expectAccessible(nadia);
    const first = nadia.getByRole('link', { name: /Claire/ }).first();
    await expect(first).toContainText('Écran d’urgence');
    await first.click();
    await waitForTitle(nadia, 'Claire');
    await expect(nadia.getByRole('link', { name: /^Écrire à Claire/ })).toHaveAttribute('href', 'mailto:claire@example.test');
    await nadia.getByRole('button', { name: 'Je m’en occupe' }).click();
    await expect(nadia.getByText('Prise en charge par vous')).toBeVisible();
    await nadia.getByLabel('Nouvelle note interne').fill('Courriel envoyé, rappel prévu ce soir.');
    await nadia.getByRole('button', { name: 'Ajouter la note' }).click();
    await expect(nadia.getByText('Courriel envoyé, rappel prévu ce soir.')).toBeVisible();
    await expectAccessible(nadia);
    await nadia.goto('/intervenante');
    await nadia.getByRole('radio', { name: /^Toutes les ouvertes/ }).check();
    await nadia.getByRole('link', { name: /Bilan de la semaine/ }).click();
    await waitForTitle(nadia, 'Claire');
    await expect(nadia.getByText('Disponibilités :')).toBeVisible();
    expect(await nadia.locator('main').innerText()).not.toMatch(/sur 5|[Ff]atigue|débordement|isolement/);
    await nadia.getByRole('button', { name: 'Fermer la demande' }).click();
    await expect(nadia.getByText('Fermée.')).toBeVisible();

    // Côté aidante : états à jour, notes internes jamais visibles.
    await page.reload();
    await waitForTitle(page, 'Parler à une intervenante');
    await expect(page.getByText('Prise en charge par une intervenante.')).toBeVisible();
    await expect(page.getByText('Fermée.')).toBeVisible();
    await expect(page.getByText(/rappel prévu ce soir/)).toHaveCount(0);
    state = await backendState();
    expect(state.supportNotes).toEqual([expect.objectContaining({ body: 'Courriel envoyé, rappel prévu ce soir.' })]);

    // Retrait du consentement « Mon bilan de la semaine » : le bilan gardé est effacé.
    await page.goto('/mes-consentements');
    await waitForTitle(page, 'Mes consentements');
    const checkinConsent = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Mon bilan de la semaine' }) });
    await checkinConsent.getByRole('button', { name: 'Retirer ce consentement' }).click();
    await expect(checkinConsent.getByText('Les réponses gardées de votre bilan de la semaine sont effacées tout de suite.')).toBeVisible();
    await checkinConsent.getByRole('button', { name: 'Confirmer le retrait' }).click();
    await expect.poll(async () => (await backendState()).checkins).toEqual([]);
});

test('évaluation du pilote : 2 questions, puis mesures regroupées (masquées sous 3 répondants)', async ({ page, browser }) => {
    const answer = async (persona: Page, email: string, name: string, hours: string, satisfaction: string) => {
        await onboard(persona, email, name, ['Évaluation du pilote']);
        await persona.getByRole('link', { name: 'Évaluation du pilote : 2 questions' }).click();
        await waitForTitle(persona, 'Évaluation du pilote');
        await persona.getByLabel(/Combien d’heures Relais vous a-t-il fait gagner/).fill(hours);
        await persona.getByRole('radio', { name: new RegExp(`^${satisfaction} — `) }).check();
        await persona.getByRole('button', { name: 'Envoyer mes réponses' }).click();
        await expect(persona.getByText('Merci ! Vos réponses de la semaine sont enregistrées.')).toBeVisible();
    };
    await answer(page, 'claire@example.test', 'Claire', '2,5', '4');
    await expectAccessible(page);
    await answer(await newPersona(browser), 'denis@example.test', 'Denis', '1', '5');

    const ada = await newPersona(browser);
    await staff(ada, 'admin.ada@example.test', 'Ada');
    await ada.goto('/admin/pilote');
    await waitForTitle(ada, 'Mesures du pilote');
    await expect(ada.getByText('Résultats masqués : 2 répondants, il en faut au moins 3.')).toBeVisible();
    await expectAccessible(ada);

    await answer(await newPersona(browser), 'emma@example.test', 'Emma', '3', '3');
    await ada.reload();
    await waitForTitle(ada, 'Mesures du pilote');
    await expect(ada.getByText('Temps gagné : 2,2 h par semaine en moyenne')).toBeVisible();
    await expect(ada.getByText('Satisfaction : 4 sur 5 en moyenne')).toBeVisible();
    await expect(ada.getByText(/Claire|Denis|Emma/)).toHaveCount(0);
    const state = await backendState();
    expect(state.pilotFeedback).toHaveLength(3);
});
