import { describe, expect, it } from 'vitest';
import {
  computeFeeMinor,
  formatMoney,
  minorToDecimalString,
  parseDecimalToMinor,
  sumMinor,
} from '../src/money';

describe('money', () => {
  it('parses decimals into minor units without floating point', () => {
    expect(parseDecimalToMinor('1250.50', 'CAD')).toBe(125050n);
    expect(parseDecimalToMinor('1250,5', 'EUR')).toBe(125050n);
    expect(parseDecimalToMinor('0.1', 'USD')).toBe(10n);
    expect(parseDecimalToMinor('750000', 'XOF')).toBe(750000n);
  });

  it('rejects malformed or over-precise amounts', () => {
    expect(() => parseDecimalToMinor('12.345', 'CAD')).toThrow();
    expect(() => parseDecimalToMinor('12.5', 'XOF')).toThrow();
    expect(() => parseDecimalToMinor('-5', 'CAD')).toThrow();
    expect(() => parseDecimalToMinor('abc', 'CAD')).toThrow();
  });

  it('renders minor units as decimal strings', () => {
    expect(minorToDecimalString(125050n, 'CAD')).toBe('1250.50');
    expect(minorToDecimalString(5n, 'CAD')).toBe('0.05');
    expect(minorToDecimalString(-199n, 'EUR')).toBe('-1.99');
    expect(minorToDecimalString(750000n, 'XOF')).toBe('750000');
  });

  it('computes basis-point fees with half-up rounding', () => {
    expect(computeFeeMinor(100000n, 150)).toBe(1500n);
    expect(computeFeeMinor(333n, 150)).toBe(5n); // 4.995 → 5
    expect(computeFeeMinor(1n, 1)).toBe(0n);
    expect(() => computeFeeMinor(100n, -1)).toThrow();
  });

  it('sums heterogeneous inputs as BigInt', () => {
    expect(sumMinor([1n, '2', 3])).toBe(6n);
  });

  it('formats for display', () => {
    expect(formatMoney(125050n, 'CAD', 'en-CA')).toContain('1,250.50');
  });
});
