import { describe, expect, it } from 'vitest';
import { checkVin } from '@/domain/vehicle/vin';

describe('VIN structural checks', () => {
    it('accepts a North American VIN with a correct check digit', () => {
        const r = checkVin('2t3w1rfv7mc123456');
        expect(r.structurallyValid).toBe(true);
        expect(r.checkDigitEvaluated).toBe(true);
        expect(r.normalized).toBe('2T3W1RFV7MC123456');
    });

    it('detects a wrong check digit (typo)', () => {
        const r = checkVin('2T3W1RFV8MC123456');
        expect(r.issues).toContain('CHECK_DIGIT_MISMATCH');
        expect(r.expectedCheckDigit).toBe('7');
    });

    it('rejects forbidden letters I, O, Q and wrong length', () => {
        expect(checkVin('2T3W1RFVOMC123456').issues).toContain('FORBIDDEN_CHARACTERS');
        expect(checkVin('2T3W1RFV7MC12345').issues).toContain('LENGTH');
    });

    it('does not enforce the check digit outside North America', () => {
        const r = checkVin('JTMW1RFV0KD012345');
        expect(r.checkDigitEvaluated).toBe(false);
        expect(r.structurallyValid).toBe(true);
    });
});
