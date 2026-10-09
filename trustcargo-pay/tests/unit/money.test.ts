import { describe, expect, it } from 'vitest';
import {
    add,
    allocateByBps,
    formatMoney,
    fromDTO,
    money,
    MoneyError,
    parseMoney,
    subtract,
    sum,
    toDecimalString,
    toDTO
} from '@/domain/money';

describe('money', () => {
    it('parses decimal input into exact minor units', () => {
        expect(parseMoney('18500', 'CAD').amountMinor).toBe(1_850_000n);
        expect(parseMoney('18 500,50', 'CAD').amountMinor).toBe(1_850_050n);
        expect(parseMoney('0.1', 'USD').amountMinor).toBe(10n);
        expect(parseMoney('12 000 000', 'XOF').amountMinor).toBe(12_000_000n);
    });

    it('rejects precision the currency does not support instead of rounding', () => {
        expect(() => parseMoney('10.001', 'EUR')).toThrow(MoneyError);
        expect(() => parseMoney('100.5', 'XOF')).toThrow(MoneyError);
        expect(() => parseMoney('-5', 'CAD')).toThrow(MoneyError);
        expect(() => parseMoney('1e3', 'CAD')).toThrow(MoneyError);
    });

    it('never mixes currencies', () => {
        expect(() => add(money(1n, 'CAD'), money(1n, 'USD'))).toThrow(MoneyError);
    });

    it('avoids floating point drift (0.1 + 0.2)', () => {
        const total = add(parseMoney('0.1', 'CAD'), parseMoney('0.2', 'CAD'));
        expect(toDecimalString(total)).toBe('0.30');
        expect(toDecimalString(subtract(total, parseMoney('0.3', 'CAD')))).toBe('0.00');
    });

    it('allocates milestones so the parts always sum exactly to the total', () => {
        const total = parseMoney('18500', 'CAD');
        const parts = allocateByBps(total, [1000, 4000, 5000]);
        expect(parts.map((p) => p.amountMinor)).toEqual([185_000n, 740_000n, 925_000n]);
        expect(sum(parts, 'CAD').amountMinor).toBe(total.amountMinor);

        const odd = money(100n, 'XOF');
        const thirds = allocateByBps(odd, [3333, 3333, 3334]);
        expect(sum(thirds, 'XOF').amountMinor).toBe(100n);
        expect(thirds.map((p) => p.amountMinor)).toEqual([33n, 33n, 34n]);
    });

    it('rejects shares that do not sum to 100%', () => {
        expect(() => allocateByBps(money(100n, 'CAD'), [5000, 4000])).toThrow(/10000/);
        expect(() => allocateByBps(money(100n, 'CAD'), [5000.5, 4999.5])).toThrow(MoneyError);
    });

    it('formats with locale while keeping full precision', () => {
        expect(formatMoney(parseMoney('18500', 'CAD'), 'en-CA')).toBe('$18,500.00');
        expect(formatMoney(money(12_000_000n, 'XOF'), 'fr-FR').replace(/\s/g, ' ')).toMatch(/12 000 000\sF\s?CFA/);
        expect(formatMoney(money(900719925474099312n, 'USD'), 'en-US')).toBe('$9,007,199,254,740,993.12');
    });

    it('round-trips through DTOs', () => {
        const m = parseMoney('1234.56', 'EUR');
        expect(fromDTO(toDTO(m))).toEqual(m);
        expect(() => fromDTO({ amountMinor: '1.5', currency: 'EUR' })).toThrow(MoneyError);
    });
});
