import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import consentTexts from '../../src/content/consent-texts.fr.json';
import resources from '../../src/content/emergency-resources.json';

describe('données de référence', () => {
    it('les fichiers SQL générés sont à jour avec les sources JSON', () => {
        expect(() => execFileSync('node', ['scripts/generate-reference-sql.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
    });

    it('chaque texte de consentement a une version datée, un titre, un résumé et des sections', () => {
        for (const text of Object.values(consentTexts)) {
            expect(text.version).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/);
            expect(text.title.length).toBeGreaterThan(0);
            expect(text.summary.length).toBeGreaterThan(0);
            expect(text.sections.length).toBeGreaterThan(0);
        }
    });

    it('seule la politique de confidentialité est obligatoire', () => {
        const required = Object.entries(consentTexts)
            .filter(([, text]) => text.required)
            .map(([type]) => type);
        expect(required).toEqual(['privacy_policy']);
    });

    it('les ressources d’urgence comprennent le 911 et le 9-8-8, avec un numéro composable', () => {
        const bySlug = new Map(resources.map((r) => [r.slug, r]));
        expect(bySlug.get('urgence-911')?.phone).toBe('911');
        expect(bySlug.get('ligne-9-8-8')?.phone).toBe('988');
        for (const r of resources) {
            expect(r.phone ?? r.sms ?? r.url).toBeTruthy();
            if (r.phone) expect(r.phone).toMatch(/^[0-9 +-]+$/);
        }
    });
});
