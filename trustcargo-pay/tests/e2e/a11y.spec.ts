import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loginAs, loginStaff } from './helpers';

const serious = (violations: { impact?: string | null; id: string; nodes: { target: unknown; failureSummary?: string }[] }[]) =>
    violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .flatMap((v) =>
            v.nodes.map(
                (n) => `${v.id}: ${JSON.stringify(n.target)} — ${(n.failureSummary ?? '').split('\n').slice(1, 2).join(' ').trim()}`
            )
        );

test('key pages have no serious or critical WCAG 2.x A/AA violations (axe)', async ({ page }) => {
    const scan = async () =>
        serious((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations);
    await page.goto('/');
    expect(await scan(), 'landing').toEqual([]);
    await loginAs(page, 'buyer');
    expect(await scan(), 'dashboard').toEqual([]);
    await page.goto('/transactions');
    await page.getByRole('link', { name: 'Toyota Highlander 2019' }).first().click();
    await page.waitForURL(/\/transactions\/[0-9a-f-]{36}/);
    for (const tab of ['overview', 'contract', 'milestones', 'documents', 'payments', 'history']) {
        await page.goto(`${new URL(page.url()).pathname}?tab=${tab}`);
        expect(await scan(), tab).toEqual([]);
    }
    await page.goto('/transactions/new');
    expect(await scan(), 'wizard').toEqual([]);
    await loginStaff(page, 'compliance');
    await page.goto('/admin/risk');
    expect(await scan(), 'admin risk').toEqual([]);
});
