import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

/**
 * Test avec contrôle de la console : toute violation de la CSP (même politique que Netlify, appliquée par
 * `vite preview`) ou erreur JavaScript non interceptée fait échouer le test.
 */
export const test = base.extend({
    page: async ({ page }, use) => {
        const problems: string[] = [];
        page.on('console', (message) => {
            if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text());
        });
        page.on('pageerror', (error) => problems.push(`${error.name}: ${error.message}`));
        await use(page);
        expect(problems).toEqual([]);
    }
});

export const FAKE_SUPABASE = 'http://127.0.0.1:54399';
export const LOGIN_CODE = '123456';
export const TOTP_CODE = '654321';

export async function resetBackend(): Promise<void> {
    const res = await fetch(`${FAKE_SUPABASE}/__test/reset`, { method: 'POST' });
    expect(res.ok).toBe(true);
}

/** État de la base (lu en superutilisateur par le faux Supabase), pour vérifier les effets d'un parcours. */
export interface BackendState {
    users: Array<{
        id: string;
        email: string;
        display_name: string | null;
        app_role: string;
        factors: Array<{ id: string; status: string }>;
    }>;
    consents: Array<{
        user_id: string;
        care_file_id: string | null;
        consent_type: string;
        text_version: string;
        granted_by: string;
        legal_basis: string | null;
        revoked_at: string | null;
    }>;
    careFiles: Array<{ id: string; owner_id: string; title: string }>;
    members: Array<{ care_file_id: string; user_id: string; role: string; access_level: string }>;
    invitations: Array<{
        id: string;
        care_file_id: string;
        email: string;
        role: string;
        accepted_at: string | null;
        revoked_at: string | null;
    }>;
    careRecipients: Array<{ care_file_id: string; first_name: string; living_setting: string }>;
    contacts: Array<{ care_file_id: string; kind: string; name: string; created_by: string | null }>;
    accessLog: Array<{ actor_id: string | null; care_file_id: string | null; action: string; metadata: Record<string, unknown> }>;
    documents: Array<{ id: string; care_file_id: string; status: string; mime_type: string; title: string | null; needs_review: boolean }>;
    extractions: Array<{ document_id: string; status: string; method: string; guard_flags: string[] }>;
    timelineEvents: Array<{
        title: string;
        event_type: string;
        occurred_on: string;
        source_type: string;
        source_document_id: string | null;
    }>;
    medications: Array<{ name_as_written: string; dosage_as_written: string | null; source_document_id: string }>;
    storageObjects: string[];
    storageFiles: string[];
    deletionQueue: string[];
    programs: Array<{
        id: string;
        slug: string;
        summary: string;
        verification_status: string;
        verified_on: string | null;
        verified_by: string | null;
        version: number;
    }>;
    filePrograms: Array<{
        slug: string;
        care_file_id: string;
        match_level: string;
        status: string;
        letter_draft: string | null;
        requested_at: string | null;
        decided_at: string | null;
    }>;
    checklist: Array<{ label: string; origin: string; is_done: boolean }>;
    tasks: Array<{
        title: string;
        status: string;
        assignee_id: string | null;
        due_on: string | null;
        completed_by: string | null;
        source_document_id: string | null;
    }>;
    appointments: Array<{ id: string; title: string; starts_at: string; companion_id: string | null }>;
    appointmentQuestions: string[];
    journalEntries: Array<{ body: string; author_id: string | null }>;
    reminderDeliveries: Array<{ user_id: string; sent_on: string; task_count: number; appointment_count: number }>;
    emails: Array<{ to: string; subject: string; text: string; html: string }>;
    checkins: Array<{ user_id: string; week_start: string; fatigue: number; overwhelm: number; isolation: number }>;
    supportRequests: Array<{
        id: string;
        requester_id: string;
        origin: string;
        contact_name: string;
        preferred_contact: string;
        phone: string | null;
        email: string | null;
        status: string;
        assigned_worker_id: string | null;
        notified_at: string | null;
        closed_at: string | null;
    }>;
    supportNotes: Array<{ support_request_id: string; author_id: string | null; body: string }>;
    pilotFeedback: Array<{ user_id: string; week_start: string; hours_saved: string | null; satisfaction: number | null }>;
    explanations: Array<{ program_id: string; program_version: number }>;
    resources: Array<{ slug: string; phone: string | null; verification_status: string; verified_by: string | null }>;
    aiCalls: Array<{
        status: string;
        model: string;
        purpose: string;
        care_file_id: string | null;
        pseudonymized_counts: Record<string, number>;
    }>;
    llmInputs: string[];
}

/** Octets d'un fichier déposé dans le faux Storage. */
export async function storedFile(path: string): Promise<Buffer> {
    const res = await fetch(`${FAKE_SUPABASE}/__test/storage?path=${encodeURIComponent(path)}`);
    expect(res.ok).toBe(true);
    return Buffer.from(await res.arrayBuffer());
}

export async function backendState(): Promise<BackendState> {
    const res = await fetch(`${FAKE_SUPABASE}/__test/state`);
    return (await res.json()) as BackendState;
}

/** Aucune violation WCAG 2.2 A/AA détectée par axe sur la page telle qu'affichée. */
export async function expectAccessible(page: Page): Promise<void> {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    expect(summary).toEqual([]);
}

export async function waitForTitle(page: Page, name: string): Promise<void> {
    const heading = page.getByRole('heading', { level: 1, name });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
}

/** Connexion par le parcours réel : adresse, puis code reçu. */
export async function signIn(page: Page, email: string): Promise<void> {
    await page.goto('/connexion');
    await waitForTitle(page, 'Se connecter');
    await page.getByLabel('Votre adresse courriel').fill(email);
    await page.getByRole('button', { name: 'Recevoir un code' }).click();
    await page.getByLabel('Code à 6 chiffres').fill(LOGIN_CODE);
    await page.getByRole('button', { name: 'Me connecter' }).click();
}

/** Nouveau compte qui accepte la politique (et les consentements demandés), puis choisit son prénom. */
export async function onboard(page: Page, email: string, name: string, optional: string[] = []): Promise<void> {
    await signIn(page, email);
    await waitForTitle(page, 'Bienvenue dans Relais');
    await page.getByLabel(/J’accepte : Comment Relais protège vos renseignements/).check();
    for (const title of optional) await page.getByLabel(`J’accepte : ${title}`).check();
    await page.getByRole('button', { name: 'Enregistrer mes choix' }).click();
    await waitForTitle(page, 'Comment voulez-vous qu’on vous appelle ?');
    await page.getByLabel('Votre prénom').fill(name);
    await page.getByRole('button', { name: 'Continuer' }).click();
    await waitForTitle(page, `Bonjour ${name}`);
}

/** Crée un dossier et enregistre le formulaire de consentement signé. Renvoie l'adresse du dossier. */
export async function createFileWithConsent(page: Page, title = 'Maman'): Promise<string> {
    await page.getByRole('link', { name: 'Créer le dossier d’un proche' }).click();
    await waitForTitle(page, 'Créer le dossier d’un proche');
    await page.getByLabel('Nom du dossier').fill(title);
    await page.getByRole('button', { name: 'Créer le dossier' }).click();
    await waitForTitle(page, 'Consentement de la personne aidée');
    await page.getByRole('radio', { name: /a signé le formulaire/ }).check();
    await page.getByLabel(/J’atteste que mon proche a lu/).check();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await waitForTitle(page, 'Profil');
    return new URL(page.url()).pathname.replace(/\/profil$/, '');
}
