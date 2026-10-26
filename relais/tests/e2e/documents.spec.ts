// Étape 3 — documents et extraction, sur la vraie base (RLS réelle) avec le vrai code serveur et une IA
// SIMULÉE (aucun appel réseau). Le test réel avec Claude est dans tests/integration (clé requise).
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DISCHARGE_SUMMARY_PAGES, FICTIONAL_IDENTIFIERS, PRESCRIPTION_PAGES } from '../support/documents';
import { buildTextPdf } from '../support/pdf';
import {
    ageDocuments,
    backendState,
    createFileWithConsent,
    expectAccessible,
    onboard,
    resetBackend,
    runScheduled,
    setStorageOutage,
    storedFile,
    test,
    waitForTitle
} from './helpers';

test.beforeEach(async () => {
    await resetBackend();
});

const fileNav = (page: Page) => page.getByRole('navigation', { name: 'Sections du dossier' });

async function setUpFile(page: Page): Promise<string> {
    await onboard(page, 'claire@example.test', 'Claire', ['Renseignements de santé']);
    const fileUrl = await createFileWithConsent(page, 'Papa');
    await page.getByLabel('Prénom', { exact: true }).fill('Roger');
    await page.getByLabel('Nom de famille (facultatif)').fill('Gagnon');
    await page.getByRole('radio', { name: 'En résidence privée pour aînés (RPA)' }).check();
    await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
    await expect(page.getByText('Profil enregistré.')).toBeVisible();
    return fileUrl;
}

async function allowAutomaticReading(page: Page, fileUrl: string): Promise<void> {
    await page.goto(`${fileUrl}/consentement`);
    await waitForTitle(page, 'Consentement de la personne aidée');
    const section = page.getByRole('region', { name: 'Lecture automatique des documents (facultatif)' });
    await section.getByRole('radio', { name: /a signé le formulaire/ }).check();
    await section.getByLabel(/J’atteste que mon proche a lu/).check();
    await section.getByRole('button', { name: 'Enregistrer l’autorisation' }).click();
    await expect(section.getByText('Autorisation enregistrée.')).toBeVisible();
    await expect(section.getByRole('heading', { name: 'Lecture automatique autorisée' })).toBeVisible();
}

async function openDocuments(page: Page): Promise<void> {
    await fileNav(page).getByRole('link', { name: 'Documents' }).click();
    await waitForTitle(page, 'Documents');
}

test('résumé de départ de 3 pages : brouillon en moins de 30 s, relecture, chronologie, suppression', async ({ page }) => {
    const fileUrl = await setUpFile(page);
    await allowAutomaticReading(page, fileUrl);
    await expectAccessible(page);
    await openDocuments(page);
    await expect(page.getByText(/Lecture automatique activée/)).toBeVisible();
    await expectAccessible(page);

    const started = Date.now();
    await page.getByLabel('Choisir un fichier (PDF ou photo)').setInputFiles({
        name: 'resume-depart.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(buildTextPdf(DISCHARGE_SUMMARY_PAGES))
    });
    await expect(page.getByRole('heading', { name: 'Vérifier le brouillon' })).toBeVisible();
    expect(Date.now() - started).toBeLessThan(30_000);
    await expectAccessible(page);

    // Brouillon : ce qui est écrit, ré-identifié localement ; rappel Info-Santé tiré des ressources.
    await expect(page.getByRole('group', { name: 'Médicament 1 : Metformine' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Médicament 3 : Atorvastatine' })).toBeVisible();
    await expect(page.getByLabel('Auteur ou établissement (facultatif)')).toHaveValue('Dre Isabelle Fortin, gériatre');
    await expect(page.getByRole('link', { name: 'Info-Santé : 811' })).toHaveAttribute('href', 'tel:811');

    // Rien de ce qui identifie la personne n'a quitté le serveur.
    let state = await backendState();
    expect(state.llmInputs).toHaveLength(1);
    for (const identifier of FICTIONAL_IDENTIFIERS) expect(state.llmInputs[0]).not.toContain(identifier);
    expect(state.aiCalls).toHaveLength(1);
    expect(state.aiCalls[0]).toMatchObject({ status: 'ok', model: 'simulated' });
    expect(state.aiCalls[0]!.pseudonymized_counts).toMatchObject({ health_card: 1, birth_date: 1, record_number: 1, sin: 1 });
    expect(JSON.stringify([state.aiCalls, state.accessLog])).not.toMatch(/Roger|Gagnon|Metformine|GAGR/);
    const docId = state.documents[0]!.id;
    expect(state.storageFiles).toEqual([`${fileUrl.split('/').pop()}/${docId}`]);
    expect(state.timelineEvents).toHaveLength(0); // rien n'entre au dossier sans confirmation

    await page.getByRole('button', { name: 'Confirmer et ajouter au dossier' }).click();
    await expect(page.getByText('Le document a été ajouté au dossier.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Résumé de départ de l’hôpital' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ce que contient le document' })).toBeVisible();
    await expectAccessible(page);

    // Le fichier original : URL signée, consultation journalisée.
    await page.getByRole('button', { name: 'Afficher le document original' }).click();
    const original = page.getByRole('link', { name: 'Ouvrir le document (lien valable 60 secondes)' });
    const href = await original.getAttribute('href');
    const response = await page.request.get(href as string);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/pdf');
    expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');

    await fileNav(page).getByRole('link', { name: 'Chronologie' }).click();
    await waitForTitle(page, 'Chronologie');
    await expect(page.getByRole('heading', { name: 'Hospitalisation : chute à domicile' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retour à la résidence' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Rendez-vous en gériatrie' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Voir le document source' })).toHaveCount(6); // 3 événements + 3 médicaments
    await expect(page.getByText('Médicaments mentionnés dans les documents')).toBeVisible();
    await expectAccessible(page);

    // Ajout à la main, puis retour au document par sa source.
    await page.getByRole('button', { name: 'Ajouter un événement' }).click();
    await page.getByLabel('Date', { exact: true }).fill('2026-09-01');
    await page.getByLabel('Type', { exact: true }).selectOption('living_setting_change');
    await page.getByLabel('Description courte').fill('Arrivée à la résidence');
    await page.getByRole('button', { name: 'Ajouter à la chronologie' }).click();
    await expect(page.getByText('Événement ajouté.')).toBeVisible();
    await expect(page.getByText('Ajouté à la main')).toBeVisible();

    state = await backendState();
    expect(state.timelineEvents.map((e) => [e.source_type, e.event_type, e.title])).toEqual([
        ['manual', 'living_setting_change', 'Arrivée à la résidence'],
        ['document', 'hospitalization', 'Hospitalisation : chute à domicile'],
        ['document', 'discharge', 'Retour à la résidence'],
        ['document', 'appointment', 'Rendez-vous en gériatrie']
    ]);
    expect(state.medications.map((m) => m.name_as_written)).toEqual(['Metformine', 'Ramipril', 'Atorvastatine']);
    const actions = state.accessLog.map((l) => l.action);
    for (const action of ['document_uploaded', 'extraction_viewed', 'extraction_confirmed', 'document_viewed'])
        expect(actions).toContain(action);

    // Suppression : le fichier, l'extraction, les médicaments et les événements tirés du document.
    await page.getByRole('link', { name: 'Voir le document source' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Résumé de départ de l’hôpital' })).toBeVisible();
    await page.getByRole('button', { name: 'Supprimer le document' }).click();
    await page.getByRole('button', { name: 'Supprimer définitivement' }).click();
    await waitForTitle(page, 'Documents');
    await expect(page.getByText('Document supprimé.')).toBeVisible();
    state = await backendState();
    expect(state.documents).toEqual([]);
    expect(state.storageFiles).toEqual([]);
    expect(state.storageObjects).toEqual([]);
    expect(state.deletionQueue).toEqual([]);
    expect(state.medications).toEqual([]);
    expect(state.timelineEvents.map((e) => e.title)).toEqual(['Arrivée à la résidence']);
    expect(state.accessLog.map((l) => l.action)).toContain('document_deleted');
});

test('photo : métadonnées retirées, saisie à la main ; garde-fous ; suppression du dossier, fichiers repris par la purge', async ({
    page
}) => {
    const fileUrl = await setUpFile(page);
    await openDocuments(page);
    await expect(page.getByText(/Lecture automatique non activée/)).toBeVisible();

    // La photo source contient une position GPS et le modèle de l'appareil (EXIF).
    const photo = readFileSync(new URL('../fixtures/photo-with-gps.jpg', import.meta.url));
    expect(photo.includes('Exif')).toBe(true);
    await page.getByLabel('Prendre une photo').setInputFiles({ name: 'ordonnance.jpg', mimeType: 'image/jpeg', buffer: photo });
    await expect(page.getByText('Relais ne lit pas encore les photos automatiquement.')).toBeVisible();

    let state = await backendState();
    const photoDoc = state.documents[0]!;
    expect(photoDoc.mime_type).toBe('image/jpeg');
    const stored = await storedFile(`${photoDoc.care_file_id}/${photoDoc.id}`);
    expect(stored.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(stored.includes('Exif')).toBe(false);
    expect(stored.includes('FictivePhone')).toBe(false);
    expect(state.llmInputs).toEqual([]);

    await page.getByRole('button', { name: 'Noter moi-même le contenu' }).click();
    await expect(page.getByRole('heading', { name: 'Noter le contenu du document' })).toBeVisible();
    await expectAccessible(page);
    await page.getByLabel('Titre').fill('Ordonnance');
    await page.getByRole('button', { name: 'Ajouter un médicament' }).click();
    await page.getByLabel('Nom', { exact: true }).fill('Atorvastatine');
    await page.getByLabel('Dose (facultatif)').fill('20 mg');
    await page.getByRole('button', { name: 'Confirmer et ajouter au dossier' }).click();
    await expect(page.getByText('Atorvastatine — 20 mg')).toBeVisible();
    await expect(page.getByText(/Contenu noté à la main/)).toBeVisible();

    // Garde-fous : le marqueur fait ajouter par l'IA simulée un conseil et un médicament inventé.
    await allowAutomaticReading(page, fileUrl);
    await openDocuments(page);
    await page.getByLabel('Choisir un fichier (PDF ou photo)').setInputFiles({
        name: 'ordonnance.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(buildTextPdf(PRESCRIPTION_PAGES.map((p) => [...p, 'TEST-CONSEIL'])))
    });
    await expect(page.getByRole('heading', { name: 'Vérifier le brouillon' })).toBeVisible();
    await expect(page.getByText(/Le résumé automatique a été retiré/)).toBeVisible();
    await expect(page.getByLabel('Résumé')).toHaveValue('');
    const aspirin = page.getByRole('group', { name: 'Médicament 2 : Aspirine' });
    await expect(aspirin.getByText(/À vérifier : introuvable tel quel/)).toBeVisible();
    await expect(aspirin.getByRole('checkbox', { name: 'Garder cet élément' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Confirmer et ajouter au dossier' }).click();
    await expect(page.getByText('Le document a été ajouté au dossier.')).toBeVisible();

    state = await backendState();
    expect(state.medications.map((m) => m.name_as_written).sort()).toEqual(['Atorvastatine', 'Metformine']);
    expect(state.aiCalls[0]?.status).toBe('guard_flagged');
    expect(state.storageFiles).toHaveLength(2);

    // Suppression du dossier pendant une panne de Storage : le dossier part, ses fichiers restent inscrits.
    await setStorageOutage(true);
    await page.goto(`${fileUrl}/parametres`);
    await waitForTitle(page, 'Paramètres du dossier');
    await page.getByLabel('Je comprends que la suppression est définitive.').check();
    await page.getByRole('button', { name: 'Supprimer le dossier' }).click();
    await waitForTitle(page, 'Bonjour Claire');
    state = await backendState();
    expect(state.careFiles).toEqual([]);
    expect(state.documents).toEqual([]);
    expect(state.storageFiles).toHaveLength(2);
    expect(state.deletionQueue).toHaveLength(2);

    // La purge planifiée : secret exigé ; en panne, rien n'est perdu ; ensuite, les fichiers sont effacés.
    expect((await runScheduled('purge-storage', 'mauvais-secret')).status).toBe(401);
    expect(await (await runScheduled('purge-storage')).json()).toEqual({ expired_uploads: 0, orphans: 0, removed: 0, failed: 2 });
    expect((await backendState()).deletionQueue).toHaveLength(2);
    await setStorageOutage(false);
    expect(await (await runScheduled('purge-storage')).json()).toEqual({ expired_uploads: 0, orphans: 0, removed: 2, failed: 0 });
    state = await backendState();
    expect(state.storageFiles).toEqual([]);
    expect(state.storageObjects).toEqual([]);
    expect(state.deletionQueue).toEqual([]);
    const fileId = fileUrl.split('/').pop();
    const trace = state.accessLog.filter((l) => l.care_file_id === fileId);
    expect(trace.map((l) => l.action)).toEqual(['care_file_deleted']);
    expect(trace[0]!.metadata).toMatchObject({ documents: 2, medications: 2 });
});

test('envoi interrompu : « Envoi incomplet », effacé par la purge après 24 h, noté au journal', async ({ page }) => {
    const fileUrl = await setUpFile(page);
    await openDocuments(page);
    // Le réseau coupe pendant le dépôt du fichier : le document reste « Envoi incomplet ».
    await page.route('**/storage/v1/object/documents/**', (route) => route.abort('connectionreset'));
    await page.getByLabel('Choisir un fichier (PDF ou photo)').setInputFiles({
        name: 'ordonnance.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(buildTextPdf(PRESCRIPTION_PAGES))
    });
    await expect(page.getByText('L’envoi n’a pas abouti. Vérifiez votre connexion et réessayez.')).toBeVisible();
    await expect(page.getByText('Envoi incomplet')).toBeVisible();
    await page.unroute('**/storage/v1/object/documents/**');
    let state = await backendState();
    expect(state.documents.map((doc) => doc.status)).toEqual(['pending_upload']);

    // Moins de 24 h : la purge n'y touche pas.
    expect(await (await runScheduled('purge-storage')).json()).toEqual({ expired_uploads: 0, orphans: 0, removed: 0, failed: 0 });
    expect((await backendState()).documents).toHaveLength(1);

    // Plus de 24 h : effacé par Relais, et l'aidante principale le voit dans son journal.
    await ageDocuments(25);
    expect(await (await runScheduled('purge-storage')).json()).toEqual({ expired_uploads: 1, orphans: 0, removed: 1, failed: 0 });
    state = await backendState();
    expect(state.documents).toEqual([]);
    expect(state.deletionQueue).toEqual([]);
    await page.goto(`${fileUrl}/journal`);
    await waitForTitle(page, 'Journal des accès');
    await expect(page.getByText('Relais a effacé un document dont l’envoi était resté incomplet plus de 24 heures')).toBeVisible();
    await expectAccessible(page);
});
