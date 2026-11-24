/**
 * Validation de la demande de devis, partagée par le navigateur (retour
 * immédiat) et par la fonction serveur (seule source de vérité).
 * Aucune dépendance : ce fichier est inclus dans le script du formulaire.
 */

export const SHIPMENT_TYPES = ['vehicle', 'full_container', 'groupage', 'other'] as const;
export type ShipmentType = (typeof SHIPMENT_TYPES)[number];

export const CONTAINER_SIZES = ['20', '40'] as const;
export type ContainerSize = (typeof CONTAINER_SIZES)[number];

/** Valeur de destination pour « Autre destination ». */
export const OTHER_DESTINATION = 'other';

/** Champ piège : invisible pour les humains, rempli par les robots. */
export const HONEYPOT_FIELD = 'website';

export const QUOTE_FIELDS = [
  'full_name',
  'phone',
  'email',
  'shipment_type',
  'vehicle_make',
  'vehicle_model',
  'vehicle_year',
  'vehicle_running',
  'container_size',
  'destination',
  'desired_date',
  'message',
  'consent',
] as const;
export type QuoteField = (typeof QUOTE_FIELDS)[number];

/** Codes d'erreur, traduits par la clé `quote.errors.<code>`. */
export type QuoteErrorCode =
  | 'required'
  | 'name'
  | 'phone'
  | 'email'
  | 'shipment_type'
  | 'vehicle_year'
  | 'vehicle_running'
  | 'container_size'
  | 'destination'
  | 'desired_date'
  | 'too_long'
  | 'consent';

export type QuoteErrors = Partial<Record<QuoteField, QuoteErrorCode>>;

/** Demande validée et normalisée, prête à être enregistrée. */
export interface QuoteData {
  full_name: string;
  phone: string;
  email: string;
  shipment_type: ShipmentType;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_year: number | null;
  vehicle_running: boolean | null;
  container_size: ContainerSize | null;
  destination: string;
  desired_date: string | null;
  message: string | null;
  locale: string;
}

export interface QuoteValidationOptions {
  /** Identifiants de destination acceptés (ceux de la config). */
  destinations: string[];
  allowOtherDestination: boolean;
  locales: string[];
  defaultLocale: string;
  /** Date du jour au format AAAA-MM-JJ. Par défaut : aujourd'hui. */
  today?: string;
}

export type QuoteValidationResult = { ok: true; data: QuoteData } | { ok: false; errors: QuoteErrors };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function toBoolean(value: unknown): boolean | null {
  if (value === true || value === 'yes' || value === 'true') return true;
  if (value === false || value === 'no' || value === 'false') return false;
  return null;
}

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function validateQuote(raw: Record<string, unknown>, options: QuoteValidationOptions): QuoteValidationResult {
  const errors: QuoteErrors = {};
  const today = options.today ?? todayIso();

  const full_name = text(raw.full_name);
  if (!full_name) errors.full_name = 'required';
  else if (full_name.length < 2 || full_name.length > 120) errors.full_name = 'name';

  const phone = text(raw.phone);
  const digits = phone.replace(/[\s().-]/g, '');
  if (!phone) errors.phone = 'required';
  else if (phone.length > 30 || !/^\+?\d{7,15}$/.test(digits)) errors.phone = 'phone';

  const email = text(raw.email).toLowerCase();
  if (!email) errors.email = 'required';
  else if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'email';

  const typeValue = text(raw.shipment_type);
  const shipment_type = (SHIPMENT_TYPES as readonly string[]).includes(typeValue) ? (typeValue as ShipmentType) : null;
  if (!shipment_type) errors.shipment_type = 'shipment_type';

  let vehicle_make: string | null = null;
  let vehicle_model: string | null = null;
  let vehicle_year: number | null = null;
  let vehicle_running: boolean | null = null;
  if (shipment_type === 'vehicle') {
    vehicle_make = text(raw.vehicle_make);
    if (!vehicle_make) errors.vehicle_make = 'required';
    else if (vehicle_make.length > 60) errors.vehicle_make = 'too_long';

    vehicle_model = text(raw.vehicle_model);
    if (!vehicle_model) errors.vehicle_model = 'required';
    else if (vehicle_model.length > 60) errors.vehicle_model = 'too_long';

    const yearText = text(raw.vehicle_year);
    const maxYear = Number(today.slice(0, 4)) + 1;
    vehicle_year = /^\d{4}$/.test(yearText) ? Number(yearText) : null;
    if (!yearText) errors.vehicle_year = 'required';
    else if (vehicle_year === null || vehicle_year < 1950 || vehicle_year > maxYear) errors.vehicle_year = 'vehicle_year';

    vehicle_running = toBoolean(raw.vehicle_running);
    if (vehicle_running === null) errors.vehicle_running = 'vehicle_running';
  }

  let container_size: ContainerSize | null = null;
  if (shipment_type === 'full_container') {
    const sizeValue = text(raw.container_size);
    container_size = (CONTAINER_SIZES as readonly string[]).includes(sizeValue) ? (sizeValue as ContainerSize) : null;
    if (!container_size) errors.container_size = 'container_size';
  }

  const destination = text(raw.destination);
  const knownDestination =
    options.destinations.includes(destination) || (options.allowOtherDestination && destination === OTHER_DESTINATION);
  if (!knownDestination) errors.destination = 'destination';

  const desired_date = text(raw.desired_date) || null;
  if (desired_date && (!isRealDate(desired_date) || desired_date < today)) errors.desired_date = 'desired_date';

  const message = text(raw.message) || null;
  if (message && message.length > 2000) errors.message = 'too_long';

  if (raw.consent !== true && raw.consent !== 'true' && raw.consent !== 'on') errors.consent = 'consent';

  const localeValue = text(raw.locale);
  const locale = options.locales.includes(localeValue) ? localeValue : options.defaultLocale;

  if (Object.keys(errors).length > 0 || !shipment_type) return { ok: false, errors };
  return {
    ok: true,
    data: {
      full_name,
      phone,
      email,
      shipment_type,
      vehicle_make,
      vehicle_model,
      vehicle_year,
      vehicle_running,
      container_size,
      destination,
      desired_date,
      message,
      locale,
    },
  };
}
