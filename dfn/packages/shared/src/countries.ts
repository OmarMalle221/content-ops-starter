export interface CountryDefinition {
  code: string;
  name: { fr: string; en: string };
  defaultCurrency: string;
  region: 'NORTH_AMERICA' | 'EUROPE' | 'WEST_AFRICA';
}

export const COUNTRIES: Record<string, CountryDefinition> = {
  CA: { code: 'CA', name: { fr: 'Canada', en: 'Canada' }, defaultCurrency: 'CAD', region: 'NORTH_AMERICA' },
  US: {
    code: 'US',
    name: { fr: 'États-Unis', en: 'United States' },
    defaultCurrency: 'USD',
    region: 'NORTH_AMERICA',
  },
  FR: { code: 'FR', name: { fr: 'France', en: 'France' }, defaultCurrency: 'EUR', region: 'EUROPE' },
  BE: { code: 'BE', name: { fr: 'Belgique', en: 'Belgium' }, defaultCurrency: 'EUR', region: 'EUROPE' },
  SN: { code: 'SN', name: { fr: 'Sénégal', en: 'Senegal' }, defaultCurrency: 'XOF', region: 'WEST_AFRICA' },
  CI: {
    code: 'CI',
    name: { fr: "Côte d'Ivoire", en: "Côte d'Ivoire" },
    defaultCurrency: 'XOF',
    region: 'WEST_AFRICA',
  },
  GN: { code: 'GN', name: { fr: 'Guinée', en: 'Guinea' }, defaultCurrency: 'GNF', region: 'WEST_AFRICA' },
  ML: { code: 'ML', name: { fr: 'Mali', en: 'Mali' }, defaultCurrency: 'XOF', region: 'WEST_AFRICA' },
};

export const SUPPORTED_COUNTRY_CODES = Object.keys(COUNTRIES);

/** Corridors open in the sandbox. Canada → Senegal is the launch corridor. */
export interface Corridor {
  origin: string;
  destination: string;
  status: 'LAUNCH' | 'EXPANSION' | 'RESEARCH';
}

export const CORRIDORS: Corridor[] = [
  { origin: 'CA', destination: 'SN', status: 'LAUNCH' },
  { origin: 'CA', destination: 'GN', status: 'EXPANSION' },
  { origin: 'CA', destination: 'CI', status: 'EXPANSION' },
  { origin: 'US', destination: 'SN', status: 'EXPANSION' },
  { origin: 'FR', destination: 'SN', status: 'EXPANSION' },
  { origin: 'FR', destination: 'CI', status: 'EXPANSION' },
  { origin: 'BE', destination: 'SN', status: 'RESEARCH' },
  { origin: 'US', destination: 'GN', status: 'RESEARCH' },
];

export function isCorridorSupported(origin: string, destination: string): boolean {
  return CORRIDORS.some((c) => c.origin === origin && c.destination === destination);
}
