import { describe, expect, it } from 'vitest';
import { buildReversal, journalTemplates, LedgerError, normalBalance, validateJournal } from '@/domain/ledger/ledger';

const args = { provider: 'mock', transactionId: 'tx1', currency: 'CAD' as const, amountMinor: 1_850_000n, externalReference: 'pi_1' };

describe('double-entry ledger rules', () => {
    it('produces balanced journal templates', () => {
        for (const draft of [
            journalTemplates.fundsReportedReceived(args),
            journalTemplates.releaseAuthorized({ ...args, payoutId: 'po1' }),
            journalTemplates.payoutSettled({ ...args, payoutId: 'po1' }),
            journalTemplates.refundAuthorized({ ...args, refundId: 'rf1' }),
            journalTemplates.refundSettled({ ...args, refundId: 'rf1' })
        ]) {
            expect(() => validateJournal(draft)).not.toThrow();
        }
    });

    it('rejects unbalanced, empty, non-positive and mixed-currency journals', () => {
        const base = journalTemplates.fundsReportedReceived(args);
        expect(() => validateJournal({ ...base, entries: [base.entries[0]!, { ...base.entries[1]!, amountMinor: 1n }] })).toThrow(
            LedgerError
        );
        expect(() => validateJournal({ ...base, entries: [base.entries[0]!] })).toThrow(/two entries/);
        expect(() => validateJournal({ ...base, entries: base.entries.map((e) => ({ ...e, amountMinor: 0n })) })).toThrow(/positive/);
        expect(() => validateJournal({ ...base, entries: [base.entries[0]!, { ...base.entries[1]!, currency: 'USD' }] })).toThrow(
            /Multi-currency/
        );
    });

    it('builds reversals by mirroring directions and refuses to reverse a reversal', () => {
        const original = journalTemplates.releaseAuthorized({ ...args, payoutId: 'po1' });
        const reversal = buildReversal({ id: 'j1', kind: original.kind, transactionId: 'tx1' }, original.entries, 'payout failed');
        expect(reversal.kind).toBe('REVERSAL');
        expect(reversal.idempotencyKey).toBe('reversal:j1');
        expect(reversal.entries.map((e) => e.direction)).toEqual(['CREDIT', 'DEBIT']);
        validateJournal(reversal);
        expect(() => buildReversal({ id: 'j2', kind: 'REVERSAL' }, reversal.entries, 'x')).toThrow(LedgerError);
    });

    it('computes balances on the normal side of the account', () => {
        expect(normalBalance('ASSET', 100n, 30n)).toBe(70n);
        expect(normalBalance('LIABILITY', 30n, 100n)).toBe(70n);
    });
});
