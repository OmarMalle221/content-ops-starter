import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Shared helpers of the phase 6 UI journeys (wallet, transfers, business, developers).
 * Everything goes through the web origin (/api/* proxy), with the browser session.
 */
export const PASSWORD = 'CorrectHorse42Battery';
export const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

/** Sandbox disclaimer of the shared shell (FR or EN). */
export const SANDBOX_TEXT = /Aucun fonds réel|No real funds/;

/** Unique, readable e-mail per journey and run. */
export function journeyEmail(journey: string): string {
  return `e2e-${journey}-${Date.now().toString(36)}@example.com`;
}

/**
 * Registration through the UI. The API throttles registrations per client IP (5 per minute), so
 * when several journeys run back to back the form may be refused for a moment: the whole step is
 * retried with expect polling until the dashboard shows up (never a fixed sleep).
 */
export async function registerThroughUi(
  page: Page,
  user: { email: string; firstName: string; lastName: string; country: string },
) {
  await expect(async () => {
    if (/\/dashboard/.test(page.url())) return;
    await page.goto('/register');
    await page.getByLabel(/Prénom|First name/).fill(user.firstName);
    await page.getByLabel(/^Nom$|Last name/).fill(user.lastName);
    await page.getByLabel(/Courriel|Email/).fill(user.email);
    await page.getByLabel(/Pays|Country/).selectOption(user.country);
    await page.getByLabel(/Mot de passe|Password/).fill(PASSWORD);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: /Créer un compte|Create an account/ }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000, 10_000] });
}

/** JSON call through the web proxy with the browser session (CSRF: first-party Origin). */
export async function api<T = Record<string, any>>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  data?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await request[method](`/api${path}`, {
    data,
    headers: { origin: WEB_URL, 'content-type': 'application/json' },
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = text as unknown as T;
  }
  return { status: res.status(), body };
}

/** Personal organisation of the signed-in user. */
export async function personalOrganizationId(page: Page): Promise<string> {
  const me = await api<{ user: { organizations: Array<{ id: string; type: string }> } }>(
    page.request,
    'get',
    '/v1/auth/me',
  );
  expect(me.status, JSON.stringify(me.body)).toBe(200);
  const org = me.body.user.organizations.find((o) => o.type === 'PERSONAL') ?? me.body.user.organizations[0];
  return org.id;
}

/** Every screen carries the sandbox disclaimer and renders no raw translation key. */
export async function expectSandboxScreen(page: Page, rawKey: RegExp) {
  await expect(page.getByRole('status').first()).toContainText(SANDBOX_TEXT);
  const text = await page.locator('main').innerText();
  expect(text, `raw translation key on ${page.url()}`).not.toMatch(rawKey);
}

/** The open modal dialog (Radix hides the rest of the page from the accessibility tree). */
export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/** French amounts use narrow formatting with no-break spaces: "1 500,00 $". */
export function frMoney(amount: string, symbol: string): RegExp {
  const [whole, frac] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fr = `${grouped}${frac ? `,${frac}` : ''} ${symbol}`;
  const enWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const en = `${symbol === '$' ? '$' : symbol}${enWhole}${frac ? `.${frac}` : ''}`;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escape(fr)}|${escape(en)}`);
}
