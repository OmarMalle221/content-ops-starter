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
