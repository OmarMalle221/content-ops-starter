import { expect, type Page } from '@playwright/test';

export async function loginAs(page: Page, persona: string) {
    await page.context().clearCookies();
    await page.goto('/');
    await page.getByTestId(`persona-${persona}`).click();
    await page.waitForURL((u) => /^\/(dashboard|admin|mfa)/.test(u.pathname));
    await page.waitForLoadState('networkidle');
}

/** Back-office personas are redirected to the TOTP challenge; the demo shows the current code. */
export async function loginStaff(page: Page, persona: string) {
    await loginAs(page, persona);
    await page.waitForURL((u) => u.pathname === '/mfa');
    await passMfa(page);
}

export async function passMfa(page: Page) {
    const code = (await page.getByTestId('demo-totp').textContent())!.trim();
    await page.getByLabel('Code de vérification').fill(code);
    await page.getByRole('button', { name: 'Vérifier' }).click();
    await page.waitForURL((u) => u.pathname !== '/mfa');
    await page.waitForLoadState('networkidle');
}

export function pdfFile(name: string) {
    const body = `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${name} — document fictif de test\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
    return { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(body) };
}

export async function confirmDialog(page: Page, triggerName: string | RegExp, fill?: (page: Page) => Promise<void>) {
    await page.getByRole('button', { name: triggerName }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    if (fill) await fill(page);
    await dialog.getByRole('button', { name: triggerName }).last().click();
    await expect(dialog).toBeHidden();
}
