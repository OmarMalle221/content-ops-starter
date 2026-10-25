import { afterEach, describe, expect, it } from 'vitest';
import { errorFields, logEvent, sanitizeLogFields, setLogSink, type LogEvent } from '../../src/lib/log';

afterEach(() => setLogSink(null));

function capture(): Array<Record<string, string | number>> {
    const entries: Array<Record<string, string | number>> = [];
    setLogSink((entry) => entries.push(entry));
    return entries;
}

describe('journaliseur à liste blanche', () => {
    it('garde les champs techniques autorisés', () => {
        const entries = capture();
        logEvent('api_error', { route: '/compte', status: 500, code: '23505', durationMs: 42 });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ event: 'api_error', route: '/compte', status: 500, code: '23505', durationMs: 42 });
    });

    it('retire tout champ inconnu, y compris un texte saisi ou un courriel', () => {
        const fields = sanitizeLogFields({
            text: 'Je veux mourir',
            email: 'aidante@example.test',
            message: 'duplicate key value (user_id)=(...)',
            note: 'Maman prend du Tylenol',
            count: 3
        });
        expect(fields).toEqual({ count: 3 });
    });

    it('masque une valeur autorisée qui ressemble à du texte libre', () => {
        expect(sanitizeLogFields({ code: 'Maman est tombée ce matin' })).toEqual({ code: '[redacted]' });
        expect(sanitizeLogFields({ route: '/dossier?note=chimio' })).toEqual({ route: '[redacted]' });
    });

    it('ignore un nom d’événement inconnu', () => {
        const entries = capture();
        logEvent('patient_note' as LogEvent, { count: 1 });
        expect(entries).toHaveLength(0);
    });

    it('ne garde jamais le message d’une erreur', () => {
        const error = Object.assign(new Error('valeur saisie : NAM ABCD 1234 5678'), { code: 'PGRST116', status: 406 });
        const fields = errorFields(error);
        expect(fields).toEqual({ errorName: 'Error', code: 'PGRST116', status: 406 });
        expect(JSON.stringify(fields)).not.toContain('ABCD');
    });
});
