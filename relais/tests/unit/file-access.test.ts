// L'interface reprend la matrice d'accès de la base (private.can_read / private.can_write) pour ne pas
// proposer d'action refusée. Ce test fige la même table que supabase/tests/rls_test.sql.
import { describe, expect, it } from 'vitest';
import { fileAccess, type DataArea } from '../../src/features/files/useFile';

const AREAS: DataArea[] = ['profile', 'coordination', 'health', 'benefits', 'manage'];

function matrix(level: Parameters<typeof fileAccess>[0], consent = true, health = true) {
    const access = fileAccess(level, consent, health);
    return {
        read: AREAS.filter((a) => access.canRead(a)),
        write: AREAS.filter((a) => access.canWrite(a))
    };
}

describe('matrice d’accès de l’interface', () => {
    it('propriétaire : tout lire, tout écrire, gérer', () => {
        expect(matrix('owner')).toEqual({ read: AREAS, write: AREAS });
    });

    it('accès complet : tout sauf la gestion', () => {
        expect(matrix('full')).toEqual({
            read: ['profile', 'coordination', 'health', 'benefits'],
            write: ['profile', 'coordination', 'health', 'benefits']
        });
    });

    it('coordination : profil et coordination en lecture, coordination en écriture', () => {
        expect(matrix('coordination')).toEqual({ read: ['profile', 'coordination'], write: ['coordination'] });
    });

    it('lecture seule : lire sans écrire', () => {
        expect(matrix('read_only')).toEqual({ read: ['profile', 'coordination', 'health', 'benefits'], write: [] });
    });

    it('non-membre : rien', () => {
        expect(matrix(undefined)).toEqual({ read: [], write: [] });
    });

    it('sans consentement de la personne aidée : seule la gestion reste possible', () => {
        expect(matrix('owner', false).write).toEqual(['manage']);
        expect(matrix('full', false).write).toEqual([]);
    });

    it('sans consentement santé de l’utilisateur : pas d’écriture de santé', () => {
        expect(matrix('full', true, false).write).toEqual(['profile', 'coordination', 'benefits']);
    });
});
