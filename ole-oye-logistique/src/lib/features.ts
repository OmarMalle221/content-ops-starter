/**
 * Fonctionnalités optionnelles du site, activées dans `site.config.ts`.
 * Les textes d'interface qui parlent d'une fonctionnalité sont marqués pour
 * disparaître avec elle : le site ne promet jamais ce qu'il n'offre pas.
 */
import { siteConfig } from '../config/site.config';

export type FeatureName = keyof typeof siteConfig.features;

export function isEnabled(feature: FeatureName): boolean {
  return siteConfig.features[feature] === true;
}

/** Élément de liste dans `src/i18n/*.json` : texte simple, ou objet réservé à une fonctionnalité. */
export type FeatureItem<T extends object = { text: string }> = string | (T & { feature?: FeatureName });

/** Retire d'une liste les éléments réservés à une fonctionnalité désactivée. */
export function enabledItems<T extends { feature?: FeatureName }>(items: T[]): T[] {
  return items.filter((item) => !item.feature || isEnabled(item.feature));
}

/** Même chose pour une liste de paragraphes, ramenée à de simples textes. */
export function enabledTexts(items: FeatureItem[]): string[] {
  return items
    .filter((item) => typeof item === 'string' || !item.feature || isEnabled(item.feature))
    .map((item) => (typeof item === 'string' ? item : item.text));
}

/**
 * Texte ayant une variante qui mentionne le suivi : avec le suivi actif, la clé
 * `<clé>Tracking` est préférée si elle existe.
 */
export function trackingText(t: (key: string) => string, key: string): string {
  const variantKey = `${key}Tracking`;
  const variant = isEnabled('tracking') ? t(variantKey) : variantKey;
  return variant === variantKey ? t(key) : variant;
}
