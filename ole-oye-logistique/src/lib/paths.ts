import { siteConfig } from '../config/site.config';

/** Pages publiques, dans l'ordre du menu. La clé sert aussi de clé de traduction (`nav.<clé>`). */
export const PAGES = {
  home: '',
  services: 'services',
  destinations: 'destinations',
  quote: 'devis',
  tracking: 'suivi',
  contact: 'contact',
  privacy: 'confidentialite',
  legal: 'mentions-legales',
} as const;

export type PageKey = keyof typeof PAGES;

export const NAV_PAGES: PageKey[] = ['home', 'services', 'destinations', 'tracking', 'contact'];

/** Adresse d'une page dans une langue : `pagePath('en', 'quote')` → `/en/devis/`. */
export function pagePath(lang: string, page: PageKey): string {
  const slug = PAGES[page];
  return slug ? `/${lang}/${slug}/` : `/${lang}/`;
}

/** Chemins statiques générés pour chaque page `[lang]`. */
export function localeStaticPaths() {
  return siteConfig.locales.map((locale) => ({ params: { lang: locale.code } }));
}
