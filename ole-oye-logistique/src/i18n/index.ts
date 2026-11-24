/**
 * Traductions pour les pages Astro. Tous les fichiers `src/i18n/*.json` sont
 * chargés automatiquement : ajouter une langue ne demande aucun changement ici.
 */
import { createTranslator, type Dict, type Translator } from './core';

const modules = import.meta.glob<{ default: Dict }>('./*.json', { eager: true });

export const dictionaries: Record<string, Dict> = Object.fromEntries(
  Object.entries(modules).map(([path, module]) => [path.replace(/^\.\/(.+)\.json$/, '$1'), module.default]),
);

export function useTranslations(lang: string): Translator {
  return createTranslator(dictionaries, lang);
}

export type { Translator, Vars } from './core';
