import { describe, expect, it } from 'vitest';
import { MockScreeningProvider } from '@/server/adapters/mock/mock-providers';
import { isStorableString, storableString, storableValue, truncateText } from '@/server/text';

const CAR = '\u{1F697}'; // two UTF-16 code units

describe('storable text', () => {
    it('truncates on code points, never inside a surrogate pair', () => {
        expect(truncateText('x'.repeat(499) + CAR + 'tail', 500)).toBe('x'.repeat(499) + CAR);
        expect(truncateText(CAR.repeat(3), 2)).toBe(CAR + CAR);
        expect(truncateText('short', 500)).toBe('short');
        expect(truncateText('abc', 0)).toBe('');
        expect(truncateText('ab', 2)).toBe('ab');
    });

    it('replaces lone surrogates with U+FFFD and refuses U+0000 with a VALIDATION error', () => {
        expect(storableString('a\uD83Db', 'f')).toBe('a�b');
        expect(storableString('\uDE97 end', 'f')).toBe('� end');
        expect(storableString(`ok ${CAR}`, 'f')).toBe(`ok ${CAR}`);
        expect(() => storableString('bad\u0000reason', 'f')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(isStorableString(`ok ${CAR}`)).toBe(true);
        expect(isStorableString('a\uD83D')).toBe(false);
        expect(isStorableString('a\u0000')).toBe(false);
    });

    it('applies the rule to every string of a JSON document, keys included, and keeps other values', () => {
        const value = { reason: 'x\uD83D', nested: [{ ['k\uDC00']: 'v' }], amount: 5n, flag: true, none: null };
        expect(storableValue(value, 'metadata')).toEqual({
            reason: 'x�',
            nested: [{ ['k�']: 'v' }],
            amount: 5n,
            flag: true,
            none: null
        });
        expect(() => storableValue({ list: ['ok', 'n\u0000'] }, 'metadata')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(() => storableValue({ ['k\u0000']: 1 }, 'metadata')).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });
});

describe('simulated screening provider', () => {
    it('issues a new reference for every screening, also for the same person', async () => {
        const screening = new MockScreeningProvider();
        const subject = { id: '0190a000-0000-7000-8000-000000000001', name: 'Awa Ndiaye' };
        const [first, second] = [await screening.screen(subject), await screening.screen(subject)];
        expect(first.providerReference).toMatch(/^sim_scr_/);
        expect(second.providerReference).not.toBe(first.providerReference);
    });
});
