import { describe, expect, it } from 'vitest';
import { detectDistress, normalizeForDetection } from '../../src/shared/distress/detect';
import { mustNotTrigger, mustTrigger } from './distress-corpus';

describe('normalizeForDetection', () => {
    it('retire les accents, la casse et la ponctuation, et uniformise les apostrophes', () => {
        expect(normalizeForDetection('  J’VEUX   mourir!! ')).toBe("j'veux mourir");
        expect(normalizeForDetection('Épuisée, à bout…')).toBe('epuisee a bout');
    });

    it('renvoie une chaîne vide pour un texte vide ou sans lettres', () => {
        expect(normalizeForDetection('')).toBe('');
        expect(normalizeForDetection(' ... !!! ')).toBe('');
    });
});

describe('detectDistress — phrases qui doivent toujours déclencher', () => {
    it.each(mustTrigger)('« $text » → $category', ({ text, category }) => {
        const result = detectDistress(text);
        expect(result.level).not.toBe('none');
        expect(result.categories).toContain(category);
    });

    it('déclenche aussi au milieu d’un texte plus long', () => {
        const result = detectDistress('Journée difficile chez le médecin. Honnêtement je veux en finir. Demain : pharmacie.');
        expect(result.categories).toContain('suicide');
    });

    it('déclenche même avec une négation (en cas de doute, on déclenche)', () => {
        expect(detectDistress('Je ne pense pas au suicide').level).toBe('danger');
    });
});

describe('detectDistress — niveaux', () => {
    it('danger pour les idées suicidaires, la violence et l’urgence médicale', () => {
        expect(detectDistress('Je veux mourir').level).toBe('danger');
        expect(detectDistress('Il me frappe').level).toBe('danger');
        expect(detectDistress('Elle ne respire plus').level).toBe('danger');
    });

    it('crise pour l’épuisement aigu de l’aidant', () => {
        expect(detectDistress("Je n'en peux plus").level).toBe('crisis');
    });

    it('danger l’emporte quand les deux sont présents', () => {
        expect(detectDistress("Je n'en peux plus, je pourrais la tuer").level).toBe('danger');
    });
});

describe('detectDistress — phrases courantes qui ne doivent pas déclencher', () => {
    it.each(mustNotTrigger)('« %s »', (text) => {
        expect(detectDistress(text)).toEqual({ level: 'none', categories: [] });
    });
});
