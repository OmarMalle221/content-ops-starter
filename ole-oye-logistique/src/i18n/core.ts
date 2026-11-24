/**
 * Moteur de traduction, sans dépendance à Astro : utilisable aussi bien dans
 * les pages que dans les fonctions Netlify.
 */
import { siteConfig, pick, isTodo, TODO } from '../config/site.config';

export type Dict = Record<string, unknown>;
export type Vars = Record<string, string | number>;

function lookup(dict: Dict | undefined, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    return node && typeof node === 'object' ? (node as Dict)[part] : undefined;
  }, dict);
}

/** Variables disponibles dans tous les textes : `{company}`, `{city}`, `{region}`, etc. */
export function globalVars(lang: string): Vars {
  const { contact } = siteConfig;
  const address = [contact.address.street, contact.address.city, contact.address.region, contact.address.postalCode]
    .filter((part) => !isTodo(part))
    .join(', ');
  return {
    company: siteConfig.name,
    legalName: siteConfig.legalName,
    city: siteConfig.origin.city,
    region: pick(siteConfig.region, lang),
    phone: contact.phoneDisplay,
    email: contact.email,
    address: isTodo(contact.address.street) ? `${TODO}, ${address}` : address,
  };
}

export function interpolate(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

function interpolateDeep<T>(value: T, vars: Vars): T {
  if (typeof value === 'string') return interpolate(value, vars) as T;
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateDeep(item, vars)]),
    ) as T;
  }
  return value;
}

export interface Translator {
  /** Texte traduit. Renvoie la clé si elle est introuvable, pour repérer l'oubli à l'écran. */
  t: (key: string, vars?: Vars) => string;
  /** Valeur traduite structurée (liste, objet), textes interpolés. */
  tx: <T = unknown>(key: string, vars?: Vars) => T;
  lang: string;
}

/**
 * Crée un traducteur pour une langue. Une clé absente de la langue demandée
 * est lue dans la langue par défaut : une traduction partielle reste utilisable.
 */
export function createTranslator(dictionaries: Record<string, Dict>, lang: string): Translator {
  const fallback = dictionaries[siteConfig.defaultLocale];
  const current = dictionaries[lang] ?? fallback;
  const base = globalVars(lang);

  const tx = <T,>(key: string, vars?: Vars): T => {
    const value = lookup(current, key) ?? lookup(fallback, key) ?? key;
    return interpolateDeep(value, { ...base, ...vars }) as T;
  };
  const t = (key: string, vars?: Vars): string => {
    const value = tx<unknown>(key, vars);
    return typeof value === 'string' ? value : key;
  };
  return { t, tx, lang };
}
