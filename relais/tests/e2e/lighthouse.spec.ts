// Critère d'acceptation : accessibilité Lighthouse de 90 ou plus sur mobile, pour chaque page.
// Lighthouse pilote le même navigateur que Playwright (port de débogage) et garde la session ouverte
// (disableStorageReset), ce qui permet d'auditer aussi les pages réservées aux personnes connectées.
import { chromium, expect, test } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DISCHARGE_SUMMARY_PAGES } from '../support/documents';
import { buildTextPdf } from '../support/pdf';
import { resetBackend, signIn, TOTP_CODE, waitForTitle } from './helpers';

const APP = 'http://127.0.0.1:4173';
const PORT = 9333;
const MIN_SCORE = 0.9;

async function accessibilityScore(path: string): Promise<{ score: number; failing: string[] }> {
    const result = await lighthouse(`${APP}${path}`, {
        port: PORT,
        onlyCategories: ['accessibility'],
        disableStorageReset: true,
        output: 'json',
        logLevel: 'error'
    });
    if (!result) throw new Error(`Lighthouse n'a rien produit pour ${path}`);
    // Une redirection (ex. vers la connexion) ferait auditer une autre page que celle demandée.
    expect(new URL(result.lhr.finalDisplayedUrl).pathname).toBe(path);
    const category = result.lhr.categories.accessibility;
    const failing = (category?.auditRefs ?? [])
        .filter((ref) => ref.weight > 0 && result.lhr.audits[ref.id]?.score === 0)
        .map((ref) => ref.id);
    return { score: category?.score ?? 0, failing };
}

test('accessibilité Lighthouse ≥ 90 sur mobile, pages publiques et connectées', async () => {
    test.setTimeout(600_000);
    await resetBackend();
    const profile = mkdtempSync(join(tmpdir(), 'relais-lh-'));
    const context = await chromium.launchPersistentContext(profile, { args: [`--remote-debugging-port=${PORT}`] });
    const scores: Record<string, number> = {};
    const problems: string[] = [];
    try {
        const page = context.pages()[0] ?? (await context.newPage());
        const audit = async (path: string) => {
            const { score, failing } = await accessibilityScore(path);
            scores[path] = score;
            if (score < MIN_SCORE) problems.push(`${path} : ${Math.round(score * 100)} (${failing.join(', ')})`);
        };

        for (const path of ['/', '/connexion', '/confidentialite', '/aide']) await audit(path);

        await signIn(page, 'lighthouse@example.test');
        await waitForTitle(page, 'Bienvenue dans Relais');
        await audit('/bienvenue');

        await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
        await page.getByLabel('J’accepte : Renseignements de santé').check();
        await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
        await page.getByLabel('Votre prénom').fill('Lucie');
        await page.getByRole('button', { name: 'Continuer' }).click();
        await waitForTitle(page, 'Bonjour Lucie');
        for (const path of ['/accueil', '/mes-consentements', '/compte', '/dossiers/nouveau', '/invitation']) await audit(path);

        // Pages du dossier (étape 2) : création, consentement, puis chaque section.
        await page.goto(`${APP}/dossiers/nouveau`);
        await page.getByLabel('Nom du dossier').fill('Maman');
        await page.getByRole('button', { name: 'Créer le dossier' }).click();
        await waitForTitle(page, 'Consentement de la personne aidée');
        const fileUrl = new URL(page.url()).pathname.replace(/\/consentement$/, '');
        await audit(`${fileUrl}/consentement`);
        await page.getByRole('radio', { name: /a signé le formulaire/ }).check();
        await page.getByLabel(/J’atteste que mon proche a lu/).check();
        await page.getByRole('button', { name: 'Enregistrer' }).click();
        await waitForTitle(page, 'Profil');
        for (const section of ['', '/profil', '/contacts', '/membres', '/journal', '/parametres']) await audit(`${fileUrl}${section}`);
        await audit(`${fileUrl}/formulaire-consentement`);

        // Étape 3 : lecture automatique autorisée, document lu (IA simulée), relecture, chronologie.
        await page.goto(`${APP}${fileUrl}/consentement`);
        const ai = page.getByRole('region', { name: 'Lecture automatique des documents (facultatif)' });
        await ai.getByRole('radio', { name: /a signé le formulaire/ }).check();
        await ai.getByLabel(/J’atteste que mon proche a lu/).check();
        await ai.getByRole('button', { name: 'Enregistrer l’autorisation' }).click();
        await expect(ai.getByText('Autorisation enregistrée.')).toBeVisible();
        await audit(`${fileUrl}/consentement`);
        await page.goto(`${APP}${fileUrl}/documents`);
        await page.getByLabel('Choisir un fichier (PDF ou photo)').setInputFiles({
            name: 'resume.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(buildTextPdf(DISCHARGE_SUMMARY_PAGES))
        });
        await expect(page.getByRole('heading', { name: 'Vérifier le brouillon' })).toBeVisible();
        const documentPath = new URL(page.url()).pathname;
        for (const path of [`${fileUrl}/documents`, documentPath, `${fileUrl}/chronologie`]) await audit(path);

        // Étape 4 : questionnaire, liste personnalisée, fiche d'un programme (avec son explication).
        await page.goto(`${APP}${fileUrl}/droits`);
        await waitForTitle(page, 'Aides et programmes');
        await audit(`${fileUrl}/droits`);
        await page.getByRole('button', { name: 'Voir les aides possibles' }).click();
        await expect(page.getByRole('heading', { name: 'Vous pourriez y avoir droit' })).toBeVisible();
        await audit(`${fileUrl}/droits`);
        await audit(`${fileUrl}/droits/soutien-domicile-clsc`);
        await audit('/aide');

        // Administration : autre compte (rôle admin, vérification en deux étapes).
        await context.clearCookies();
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });
        await signIn(page, 'admin.lighthouse@example.test');
        await waitForTitle(page, 'Vérification en deux étapes');
        await page.getByLabel('Code de l’application (6 chiffres)').fill(TOTP_CODE);
        await page.getByRole('button', { name: 'Vérifier' }).click();
        await waitForTitle(page, 'Bienvenue dans Relais');
        await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
        await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
        await page.getByLabel('Votre prénom').fill('Ada');
        await page.getByRole('button', { name: 'Continuer' }).click();
        await waitForTitle(page, 'Bonjour Ada');
        await page.goto(`${APP}/admin/programmes`);
        await waitForTitle(page, 'Fiches des programmes');
        const programPath = await page.getByRole('link', { name: /CIPH/ }).getAttribute('href');
        for (const path of ['/admin', '/admin/programmes', programPath as string, '/admin/programmes/nouvelle', '/admin/ressources'])
            await audit(path);
    } finally {
        await context.close();
        rmSync(profile, { recursive: true, force: true });
    }

    console.log(
        'Accessibilité Lighthouse (mobile) :',
        Object.entries(scores)
            .map(([p, s]) => `${p} ${Math.round(s * 100)}`)
            .join(' · ')
    );
    expect(problems).toEqual([]);
});
