import { expect, test } from '@playwright/test';
import { loginAs } from './helpers';

test('mobile layout: navigation menu and no horizontal overflow', async ({ page }) => {
    await loginAs(page, 'buyer');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('#mobile-nav').getByRole('link', { name: 'Transactions' }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await page.getByRole('link', { name: 'Toyota Highlander 2019' }).first().click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    await expect(page.getByText('Terminée').first()).toBeVisible();
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow2).toBeLessThanOrEqual(1);
});

test('language switch to English', async ({ page }) => {
    await loginAs(page, 'buyer');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('#mobile-nav').getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: /Hello Awa/ })).toBeVisible();
    await expect(page.getByText('Demo environment — no real funds')).toBeVisible();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.locator('#mobile-nav').getByRole('button', { name: 'Français' }).click();
    await expect(page.getByRole('heading', { name: /Bonjour Awa/ })).toBeVisible();
});
