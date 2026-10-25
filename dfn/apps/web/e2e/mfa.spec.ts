import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { registerThroughUi } from './journey-helpers';

/**
 * Phase 6 — two-factor enrolment from the settings: the authenticator code alone is not enough,
 * the current password is required (a stolen session must not attach its own factor). Then the
 * sign-in asks for the second factor and accepts a single-use recovery code shown at enrolment.
 */
const PASSWORD = 'CorrectHorse42Battery';
const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);
const email = `e2e-mfa-${run}@example.com`;

/** RFC 6238 TOTP (HMAC-SHA-1, 6 digits, 30 s steps) of a base32 secret — the authenticator app. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.replace(/=+$/, '').toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

test('enables TOTP with the current password, then signs in with a recovery code', async ({ page }) => {
  await registerThroughUi(page, { email, firstName: 'Awa', lastName: 'Diop', country: 'SN' });
  await page.goto('/settings');
  await expect(page.getByRole('status')).toContainText(/Aucun fonds réel|No real funds/);
  await page.getByRole('button', { name: /^(Activer|Enable)$/ }).click();
  const secret = ((await page.locator('code').first().textContent()) ?? '').trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  const form = page.locator('form', { has: page.locator('#mfa-enable-code') });
  const confirm = form.getByRole('button', { name: /^(Confirmer|Confirm)$/ });

  // A wrong password is refused: MFA stays off.
  await form.locator('#mfa-enable-code').fill(totp(secret));
  await expect(confirm).toBeDisabled();
  await form.locator('#mfa-enable-password').fill('not-the-password');
  await confirm.click();
  await expect(page.getByText(/Mot de passe actuel incorrect|Incorrect current password/)).toBeVisible();
  const status = await page.request.get('/api/v1/auth/mfa/status');
  expect(((await status.json()) as { mfaEnabled: boolean }).mfaEnabled).toBe(false);

  // Code + current password: enabled, recovery codes shown once.
  // Stay clear of a step boundary between generating the code and the server check.
  if (30_000 - (Date.now() % 30_000) < 4_000) await page.waitForTimeout(5_000);
  await form.locator('#mfa-enable-code').fill(totp(secret));
  await form.locator('#mfa-enable-password').fill(PASSWORD);
  await confirm.click();
  await expect(
    page.getByText(/Double authentification activée|Two-factor authentication enabled/),
  ).toBeVisible();
  const recovery = ((await page.locator('ul.font-mono li').first().textContent()) ?? '').trim();
  expect(recovery).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{2}$/);

  // Sign out and back in: the second factor is required; a recovery code completes the sign-in.
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: { origin: WEB_URL, 'content-type': 'application/json' },
    data: {},
  });
  expect(logout.status()).toBe(200);
  await page.context().clearCookies();
  // A hostile `next` (here a javascript: URL) is dropped at both steps: the sign-in lands on the
  // dashboard of this origin and nothing runs.
  await page.goto(`/login?next=${encodeURIComponent('javascript:document.title="pwned"')}`);
  await page.getByLabel(/Courriel|Email/).fill(email);
  await page.getByLabel(/Mot de passe|Password/).fill(PASSWORD);
  await page.getByRole('button', { name: /^(Se connecter|Sign in)$/ }).click();
  await expect(page).toHaveURL(/\/mfa/);
  await expect(page.getByRole('status')).toContainText(/Aucun fonds réel|No real funds/);
  await page.getByRole('button', { name: /Utiliser un code de secours|Use a recovery code/ }).click();
  await page.locator('#recovery-code').fill(recovery);
  await page.getByRole('button', { name: /^(Confirmer|Confirm)$/ }).click();
  await expect(page).toHaveURL(`${WEB_URL}/dashboard`);
  expect(await page.title()).not.toBe('pwned');
  const remaining = await page.request.get('/api/v1/auth/mfa/recovery-codes');
  expect(((await remaining.json()) as { remaining: number }).remaining).toBe(9);
});
