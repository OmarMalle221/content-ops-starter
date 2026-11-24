import { describe, expect, it } from 'vitest';
import { validateQuote, type QuoteValidationOptions } from '../src/lib/quote-schema';

const options: QuoteValidationOptions = {
  destinations: ['dakar', 'abidjan'],
  allowOtherDestination: true,
  locales: ['fr', 'en'],
  defaultLocale: 'fr',
  today: '2026-11-24',
};

const vehicle = {
  full_name: 'Awa Diop',
  phone: '+1 (514) 555-0199',
  email: 'Awa@Example.com',
  shipment_type: 'vehicle',
  vehicle_make: 'Toyota',
  vehicle_model: 'Corolla',
  vehicle_year: '2015',
  vehicle_running: 'yes',
  destination: 'dakar',
  desired_date: '2026-12-15',
  message: 'Avec quelques colis dans le coffre.',
  consent: true,
  locale: 'fr',
};

describe('validateQuote', () => {
  it('accepte une demande de véhicule complète et la normalise', () => {
    const result = validateQuote(vehicle, options);
    expect(result).toEqual({
      ok: true,
      data: {
        full_name: 'Awa Diop',
        phone: '+1 (514) 555-0199',
        email: 'awa@example.com',
        shipment_type: 'vehicle',
        vehicle_make: 'Toyota',
        vehicle_model: 'Corolla',
        vehicle_year: 2015,
        vehicle_running: true,
        container_size: null,
        destination: 'dakar',
        desired_date: '2026-12-15',
        message: 'Avec quelques colis dans le coffre.',
        locale: 'fr',
      },
    });
  });

  it('signale chaque champ obligatoire manquant', () => {
    const result = validateQuote({}, options);
    expect(result).toEqual({
      ok: false,
      errors: {
        full_name: 'required',
        phone: 'required',
        email: 'required',
        shipment_type: 'shipment_type',
        destination: 'destination',
        consent: 'consent',
      },
    });
  });

  it('exige les détails du véhicule seulement pour un véhicule', () => {
    const missing = validateQuote({ ...vehicle, vehicle_make: '', vehicle_year: '15', vehicle_running: undefined }, options);
    expect(missing).toMatchObject({
      ok: false,
      errors: { vehicle_make: 'required', vehicle_year: 'vehicle_year', vehicle_running: 'vehicle_running' },
    });

    const groupage = validateQuote({ ...vehicle, shipment_type: 'groupage', vehicle_make: 'ignoré' }, options);
    expect(groupage).toMatchObject({ ok: true, data: { vehicle_make: null, vehicle_year: null, vehicle_running: null } });
  });

  it('exige la taille pour un conteneur complet', () => {
    const base = { ...vehicle, shipment_type: 'full_container' };
    expect(validateQuote(base, options)).toMatchObject({ ok: false, errors: { container_size: 'container_size' } });
    expect(validateQuote({ ...base, container_size: '30' }, options)).toMatchObject({ ok: false });
    expect(validateQuote({ ...base, container_size: '40' }, options)).toMatchObject({ ok: true, data: { container_size: '40' } });
  });

  it('refuse sans consentement explicite (Loi 25)', () => {
    expect(validateQuote({ ...vehicle, consent: false }, options)).toMatchObject({ ok: false, errors: { consent: 'consent' } });
    expect(validateQuote({ ...vehicle, consent: 'false' }, options)).toMatchObject({ ok: false, errors: { consent: 'consent' } });
  });

  it('refuse les téléphones, courriels et dates invalides', () => {
    expect(validateQuote({ ...vehicle, phone: '12345' }, options)).toMatchObject({ errors: { phone: 'phone' } });
    expect(validateQuote({ ...vehicle, phone: 'appelez-moi' }, options)).toMatchObject({ errors: { phone: 'phone' } });
    expect(validateQuote({ ...vehicle, email: 'awa@example' }, options)).toMatchObject({ errors: { email: 'email' } });
    expect(validateQuote({ ...vehicle, desired_date: '2026-11-23' }, options)).toMatchObject({ errors: { desired_date: 'desired_date' } });
    expect(validateQuote({ ...vehicle, desired_date: '2026-02-31' }, options)).toMatchObject({ errors: { desired_date: 'desired_date' } });
    expect(validateQuote({ ...vehicle, vehicle_year: '2028' }, options)).toMatchObject({ errors: { vehicle_year: 'vehicle_year' } });
    expect(validateQuote({ ...vehicle, message: 'x'.repeat(2001) }, options)).toMatchObject({ errors: { message: 'too_long' } });
  });

  it("n'accepte que les destinations de la config, et « autre » si activé", () => {
    expect(validateQuote({ ...vehicle, destination: 'paris' }, options)).toMatchObject({ errors: { destination: 'destination' } });
    expect(validateQuote({ ...vehicle, destination: 'other' }, options)).toMatchObject({ ok: true });
    expect(validateQuote({ ...vehicle, destination: 'other' }, { ...options, allowOtherDestination: false })).toMatchObject({
      errors: { destination: 'destination' },
    });
  });

  it('retombe sur la langue par défaut si la langue est inconnue', () => {
    expect(validateQuote({ ...vehicle, locale: 'xx' }, options)).toMatchObject({ ok: true, data: { locale: 'fr' } });
    expect(validateQuote({ ...vehicle, desired_date: '', message: '  ' }, options)).toMatchObject({
      ok: true,
      data: { desired_date: null, message: null },
    });
  });
});
