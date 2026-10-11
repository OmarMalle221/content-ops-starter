import { describe, expect, it } from 'vitest';
import { canonicalJson, renderProtectContract } from '../src';
import type { ProtectContractTerms } from '../src';

const terms: ProtectContractTerms = {
  transactionReference: 'DFN-2026-0001',
  title: 'Toyota Hilux 2019',
  description: 'Export Montréal → Dakar',
  category: 'VEHICLE',
  currencyCode: 'CAD',
  totalAmount: '18500.00',
  platformFee: '277.50',
  originCountry: 'CA',
  destinationCountry: 'SN',
  deliveryDeadlineDays: 60,
  inspectionWindowDays: 5,
  governingLaw: 'Canada (Québec)',
  parties: [
    { role: 'BUYER', displayName: 'Moussa Ndiaye', email: 'buyer@example.com', country: 'CA' },
    { role: 'SELLER', displayName: 'Dakar Auto Import', email: 'seller@example.com', country: 'SN' },
  ],
  milestones: [
    { sequence: 1, title: 'Embarquement', amount: '9250.00', requiredEvidence: ['BILL_OF_LADING'] },
    {
      sequence: 2,
      title: 'Livraison au port de Dakar',
      amount: '9250.00',
      requiredEvidence: ['PROOF_OF_SHIPMENT'],
    },
  ],
};

describe('Protect contract template', () => {
  it('renders deterministic content with a stable hash', () => {
    const a = renderProtectContract(terms, 'fr');
    const b = renderProtectContract({ ...terms }, 'fr');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.bodyText).toContain('18500.00 CAD');
    expect(a.bodyText).toContain('Données fictives');
    expect(renderProtectContract(terms, 'en').bodyText).toContain('No real funds');
  });

  it('changes the hash when terms change', () => {
    const a = renderProtectContract(terms, 'fr');
    const b = renderProtectContract({ ...terms, totalAmount: '18500.01' }, 'fr');
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('canonicalises key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
