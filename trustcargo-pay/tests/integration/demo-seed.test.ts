import { describe, expect, it } from 'vitest';
import { seedDemoScenarios } from '@/server/demo/seed';
import { actors, createTestApp } from './helpers';

describe('demo seed (drives the real services end to end)', () => {
    it('produces the expected scenarios with a balanced ledger and a valid audit chain', async () => {
        const app = await createTestApp();
        await seedDemoScenarios(app);
        const a = await actors(app);
        const list = await app.transactions.listForActor(a.seller);
        const byTitle = Object.fromEntries(list.map((x) => [x.transaction.title, x.transaction.status]));
        expect(byTitle).toEqual({
            'Toyota Highlander 2019': 'COMPLETED',
            'Lexus RX 350 2020': 'DISPUTED',
            'Toyota RAV4 2021': 'MILESTONE_REVIEW',
            'Honda CR-V 2019': 'AWAITING_FUNDING',
            'Toyota Corolla 2020': 'AWAITING_PARTIES'
        });
        const overview = await app.admin.overview(a.auditor);
        expect(overview.trialBalance.every((t) => t.balanced)).toBe(true);
        const log = await app.admin.auditLog(a.auditor);
        expect(log.chain.valid).toBe(true);

        const rav4 = list.find((x) => x.transaction.title === 'Toyota RAV4 2021')!.transaction;
        const view = await app.views.transaction(a.buyer, rav4.id);
        expect(view.milestones.map((m) => m.status)).toEqual(['RELEASED', 'SUBMITTED', 'PENDING']);
        expect(view.payment!.heldMinor).toBe('1665000');
        expect(view.can.reviewMilestone).toBe(true);

        const lexus = list.find((x) => x.transaction.title === 'Lexus RX 350 2020')!.transaction;
        const alerts = (await app.risk.listAlerts(a.compliance, { transactionId: lexus.id })).map((x) => x.alert.ruleId).sort();
        expect(alerts).toEqual(
            expect.arrayContaining(['VIN_DOCUMENT_MISMATCH', 'SHIPPING_DOCUMENT_INCONSISTENT', 'DECLARED_VALUE_INCONSISTENT'])
        );

        const rec = await app.reconciliation.run(a.finance);
        expect(rec.status).toBe('MATCHED');
        expect(await app.transactions.pendingInvitations(a.buyer2)).toHaveLength(1);
    });
});
