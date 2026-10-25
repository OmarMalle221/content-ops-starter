// Étape 5 — coordination et rendez-vous, sur la vraie base (RLS, déclencheurs) avec le vrai code serveur.
import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { DISCHARGE_SUMMARY_PAGES } from '../support/documents';
import { buildTextPdf } from '../support/pdf';
import { backendState, createFileWithConsent, expectAccessible, FAKE_SUPABASE, onboard, resetBackend, test, waitForTitle } from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

const fileNav = (page: Page) => page.getByRole('navigation', { name: 'Sections du dossier' });
const torontoDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

async function setUpFile(page: Page): Promise<string> {
    const fileUrl = await createFileWithConsent(page, 'Papa');
    await page.getByLabel('Prénom', { exact: true }).fill('Roger');
    await page.getByLabel('Nom de famille (facultatif)').fill('Gagnon');
    await page.getByRole('radio', { name: 'En résidence privée pour aînés (RPA)' }).check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await expect(page.getByText('Profil enregistré.')).toBeVisible();
    return fileUrl;
}

async function addAppointment(page: Page, input: { title: string; date: string; time: string; location?: string }): Promise<void> {
    await fileNav(page).getByRole('link', { name: 'Agenda' }).click();
    await waitForTitle(page, 'Agenda');
    await page.getByRole('link', { name: 'Ajouter un rendez-vous' }).click();
    await waitForTitle(page, 'Nouveau rendez-vous');
    await page.getByLabel('Objet du rendez-vous').fill(input.title);
    await page.getByLabel('Date', { exact: true }).fill(input.date);
    await page.getByLabel('Heure', { exact: true }).fill(input.time);
    if (input.location) await page.getByLabel('Lieu (facultatif)').fill(input.location);
    await page.getByLabel('Qui accompagne').selectOption({ label: 'Claire (vous)' });
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await waitForTitle(page, input.title);
    await expect(page.getByText('Rendez-vous enregistré.')).toBeVisible();
}

test('du document au rendez-vous : tâche tirée d’un « à faire », questions, page imprimable sourcée, .ics, carnet', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    const fileUrl = await setUpFile(page);

    // Lecture automatique d'un résumé de départ (IA simulée), confirmé tel quel.
    await page.goto(`${fileUrl}/consentement`);
    const ai = page.getByRole('region', { name: 'Lecture automatique des documents (facultatif)' });
    await ai.getByRole('radio', { name: /a signé le formulaire/ }).check();
    await ai.getByLabel(/J’atteste que mon proche a lu/).check();
    await ai.getByRole('button', { name: 'Enregistrer l’autorisation' }).click();
    await expect(ai.getByText('Autorisation enregistrée.')).toBeVisible();
    await fileNav(page).getByRole('link', { name: 'Documents' }).click();
    await page.getByLabel('Choisir un fichier (PDF ou photo)').setInputFiles({
        name: 'resume-depart.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(buildTextPdf(DISCHARGE_SUMMARY_PAGES))
    });
    await page.getByRole('button', { name: 'Confirmer et ajouter au dossier' }).click();
    await expect(page.getByText('Le document a été ajouté au dossier.')).toBeVisible();

    // « À faire » du document → tâche, avec lien vers sa source.
    await page.getByRole('link', { name: 'Créer une tâche : prise de sang au CLSC dans deux semaines' }).click();
    await waitForTitle(page, 'Tâches');
    await expect(page.getByLabel('Quoi faire')).toHaveValue('prise de sang au CLSC dans deux semaines');
    await page.getByLabel('Qui s’en occupe').selectOption({ label: 'Claire (vous)' });
    await page.getByLabel('À faire au plus tard le (facultatif)').fill(torontoDay(0));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Tâche enregistrée.')).toBeVisible();
    const item = page.getByRole('listitem').filter({ hasText: 'prise de sang au CLSC' });
    await expect(item.getByText(/^Aujourd’hui : À faire d’ici le/)).toBeVisible();
    await expect(item.getByRole('link', { name: 'Voir la source : prise de sang au CLSC dans deux semaines' })).toBeVisible();
    await expectAccessible(page);
    let state = await backendState();
    expect(state.tasks).toEqual([
        expect.objectContaining({
            title: 'prise de sang au CLSC dans deux semaines',
            status: 'todo',
            source_document_id: state.documents[0]!.id
        })
    ]);

    // Le rendez-vous de suivi annoncé dans le document.
    await addAppointment(page, { title: 'Rendez-vous en gériatrie', date: '2026-11-12', time: '10:30', location: 'Clinique externe' });
    await expect(page.getByText('Jeudi 12 novembre, à 10 h 30')).toBeVisible();
    await page.getByLabel('Nouvelle question').fill('Faut-il ajuster la prise de sang prévue ?');
    await page.getByRole('button', { name: 'Ajouter la question' }).click();
    await expect(page.getByText('Faut-il ajuster la prise de sang prévue ?')).toBeVisible();
    await expectAccessible(page);
    state = await backendState();
    expect(state.appointments).toEqual([
        expect.objectContaining({ title: 'Rendez-vous en gériatrie', starts_at: '2026-11-12T15:30:00.000Z' })
    ]);

    // Fichier .ics produit sur le téléphone : objet, heure et lieu seulement.
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Ajouter à mon calendrier' }).click()
    ]);
    expect(download.suggestedFilename()).toBe('rendez-vous-2026-11-12.ics');
    const ics = await readFile((await download.path()) as string, 'utf8');
    expect(ics).toContain('DTSTART:20261112T153000Z');
    expect(ics).toContain('SUMMARY:Rendez-vous en gériatrie');
    expect(ics).not.toMatch(/prise de sang|Roger|Gagnon/);

    // Page à imprimer : seulement des faits du dossier, chacun avec sa source.
    await page.getByRole('link', { name: 'Préparer ce rendez-vous' }).click();
    await waitForTitle(page, 'Préparer le rendez-vous');
    const facts = page.getByTestId('prep-fact');
    await expect(facts).toHaveCount(6); // 3 événements de la chronologie + 3 médicaments, tous tirés du document
    for (const fact of await facts.all())
        await expect(fact.getByText(/^Source : document « Résumé de départ de l’hôpital »/)).toBeVisible();
    await expect(page.getByText('Roger Gagnon')).toBeVisible();
    await expect(page.getByText('Source : profil du dossier')).toBeVisible();
    await expect(page.getByText('Faut-il ajuster la prise de sang prévue ?')).toBeVisible();
    await expectAccessible(page);
    await page.evaluate(() => {
        window.print = () => undefined;
    });
    await page.getByRole('button', { name: 'Imprimer' }).click();
    await expect.poll(async () => (await backendState()).accessLog.map((l) => l.action)).toContain('prep_sheet_printed');

    // Version imprimée : sans navigation ni boutons, toujours accessible.
    await page.emulateMedia({ media: 'print' });
    await expect(fileNav(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Imprimer' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Aide immédiate' })).toBeHidden();
    await expect(page.getByText('Réponses et notes')).toBeVisible();
    await expectAccessible(page);
    await page.emulateMedia({ media: 'screen' });

    // Carnet de bord.
    await fileNav(page).getByRole('link', { name: 'Carnet' }).click();
    await waitForTitle(page, 'Carnet de bord');
    await page.getByLabel('Nouvelle note').fill('Papa a bien dormi, il a hâte au rendez-vous.');
    await page.getByRole('button', { name: 'Ajouter au carnet' }).click();
    await expect(page.getByText('Note ajoutée au carnet.')).toBeVisible();
    await expect(page.getByText(/^Claire \(vous\), /)).toBeVisible();
    await expectAccessible(page);

    // Aperçu : le rendez-vous et la tâche de la semaine.
    await fileNav(page).getByRole('link', { name: 'Aperçu' }).click();
    await expect(page.getByText('1 tâche à faire pour vous.')).toBeVisible();
    state = await backendState();
    expect(state.journalEntries).toEqual([
        expect.objectContaining({ body: 'Papa a bien dormi, il a hâte au rendez-vous.', author_id: state.users[0]!.id })
    ]);
    expect(state.appointmentQuestions).toEqual(['Faut-il ajuster la prise de sang prévue ?']);
});

test('rappel quotidien : courriel générique (aucune donnée de santé), un seul par jour, secret exigé', async ({ page }) => {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé', 'Rappels par courriel']);
    await setUpFile(page);
    await fileNav(page).getByRole('link', { name: 'Tâches' }).click();
    await waitForTitle(page, 'Tâches');
    await expect(page.getByText(/Rappels par courriel activés/)).toBeVisible();
    await page.getByRole('button', { name: 'Ajouter une tâche' }).click();
    await page.getByLabel('Quoi faire').fill('Renouveler l’ordonnance de Metformine');
    await page.getByLabel('Qui s’en occupe').selectOption({ label: 'Claire (vous)' });
    await page.getByLabel('À faire au plus tard le (facultatif)').fill(torontoDay(0));
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Tâche enregistrée.')).toBeVisible();
    await addAppointment(page, { title: 'Clinique de gériatrie', date: torontoDay(1), time: '10:00', location: 'Hôpital Notre-Dame' });

    const cron = (secret: string) =>
        fetch(`${FAKE_SUPABASE}/functions/v1/send-reminders`, { method: 'POST', headers: { 'x-relais-cron-secret': secret }, body: '{}' });
    expect((await cron('mauvais-secret')).status).toBe(401);
    const first = await cron('test-cron-secret');
    expect(await first.json()).toMatchObject({ due: 1, sent: 1, failed: 0 });

    const state = await backendState();
    expect(state.emails).toHaveLength(1);
    const email = state.emails[0]!;
    expect(email.to).toBe('claire@example.test');
    expect(email.text).toContain('Vous avez 1 tâche à faire d’ici demain et 1 rendez-vous aujourd’hui ou demain dans Relais.');
    expect(JSON.stringify(email)).not.toMatch(/Metformine|ordonnance|Roger|Gagnon|Papa|gériatrie|Notre-Dame|Claire/);
    expect(state.reminderDeliveries).toEqual([expect.objectContaining({ task_count: 1, appointment_count: 1 })]);

    // Deuxième passage le même jour : rien.
    expect(await (await cron('test-cron-secret')).json()).toMatchObject({ due: 0, sent: 0 });
    expect((await backendState()).emails).toHaveLength(1);
});
