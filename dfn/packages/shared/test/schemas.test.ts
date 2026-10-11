import { describe, expect, it } from 'vitest';
import { createTransactionSchema, registerSchema } from '../src/schemas';

describe('schemas', () => {
  it('enforces password policy', () => {
    const base = {
      email: 'A@B.CO',
      firstName: 'A',
      lastName: 'B',
      country: 'CA',
      acceptTerms: true as const,
    };
    expect(registerSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    const ok = registerSchema.safeParse({ ...base, password: 'CorrectHorse42Battery' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBe('a@b.co');
  });

  it('rejects same-country transactions', () => {
    const r = createTransactionSchema.safeParse({
      title: 'Toyota Corolla 2018',
      description: 'Véhicule exporté depuis Montréal vers Dakar.',
      currencyCode: 'CAD',
      amount: '12500.00',
      originCountry: 'CA',
      destinationCountry: 'CA',
      seller: { email: 'seller@example.com' },
      milestones: [{ title: 'Livraison', amount: '12500.00' }],
    });
    expect(r.success).toBe(false);
  });
});
