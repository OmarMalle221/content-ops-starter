import { siteConfig, pick, isTodo } from '../config/site.config';

/** Données structurées schema.org « LocalBusiness ». Les champs non remplis sont omis. */
export function localBusinessJsonLd(lang: string, siteUrl: string): Record<string, unknown> {
  const { contact, brand } = siteConfig;
  const absolute = (path: string) => new URL(path, siteUrl).href;

  const address: Record<string, string> = {
    '@type': 'PostalAddress',
    addressLocality: contact.address.city,
    addressRegion: contact.address.region,
    addressCountry: contact.address.country,
  };
  if (!isTodo(contact.address.street)) address.streetAddress = contact.address.street;
  if (!isTodo(contact.address.postalCode)) address.postalCode = contact.address.postalCode;

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': `${absolute('/')}#business`,
    name: siteConfig.name,
    description: pick(siteConfig.tagline, lang),
    url: absolute(`/${lang}/`),
    telephone: contact.phone,
    image: absolute(brand.ogImage),
    logo: absolute(brand.logo),
    address,
    areaServed: siteConfig.destinations.map((d) => pick(d.country, lang)).filter((c, i, all) => all.indexOf(c) === i),
    availableLanguage: siteConfig.locales.map((l) => l.htmlLang),
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: contact.phone,
      contactType: 'customer service',
      availableLanguage: siteConfig.locales.map((l) => l.htmlLang),
    },
  };
  if (!isTodo(contact.email)) data.email = contact.email;
  if (contact.hours.spec.length > 0) {
    data.openingHoursSpecification = contact.hours.spec.map((slot) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: slot.days,
      opens: slot.opens,
      closes: slot.closes,
    }));
  }
  return data;
}

/** Lien Google Maps vers l'entrepôt : celui de la config, sinon une recherche sur l'adresse. */
export function mapsLink(): string {
  const { contact } = siteConfig;
  if (contact.mapsUrl) return contact.mapsUrl;
  const parts = [contact.address.street, contact.address.city, contact.address.region, contact.address.postalCode].filter(
    (part) => !isTodo(part),
  );
  const query = isTodo(contact.address.street) ? [siteConfig.name, ...parts] : parts;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query.join(', '))}`;
}
