import { expect } from 'vitest';
import { Client, PDF_BYTES, PNG_BYTES, registerUser, type TestContext } from './app';

export interface Actors {
  buyer: Client;
  seller: Client;
  buyerUser: any;
  sellerUser: any;
}

export async function createActors(ctx: TestContext, suffix = ''): Promise<Actors> {
  const b = await registerUser(ctx, `buyer${suffix}@example.com`, {
    firstName: 'Moussa',
    lastName: 'Ndiaye',
    country: 'CA',
  });
  const s = await registerUser(ctx, `seller${suffix}@example.com`, {
    firstName: 'Awa',
    lastName: 'Diop',
    country: 'SN',
  });
  return { buyer: b.client, seller: s.client, buyerUser: b.user, sellerUser: s.user };
}

export const VEHICLE_TX = {
  title: 'Toyota Hilux 2019 — export Montréal → Dakar',
  description:
    'Pick-up double cabine, 85 000 km, inspection avant embarquement et livraison au port de Dakar.',
  category: 'VEHICLE',
  currencyCode: 'CAD',
  amount: '18500.00',
  originCountry: 'CA',
  destinationCountry: 'SN',
  seller: { email: 'seller@example.com', name: 'Dakar Auto Import' },
  milestones: [
    { title: 'Embarquement confirmé', amount: '9250.00', requiredEvidence: ['BILL_OF_LADING'] },
    { title: 'Livraison au port de Dakar', amount: '9250.00', requiredEvidence: ['PROOF_OF_SHIPMENT'] },
  ],
  terms: { deliveryDeadlineDays: 60, inspectionWindowDays: 5 },
};

/** Walks a transaction to FUNDED: create → invite → accept → both accept terms → verify → fund → partner confirms. */
export async function fundTransaction(
  ctx: TestContext,
  a: Actors,
  input: Record<string, unknown> = VEHICLE_TX,
  existing?: { txId: string; token: string },
) {
  let txId: string;
  let token: string;
  if (existing) {
    ({ txId, token } = existing);
  } else {
    const created = await a.buyer.post('/v1/transactions', input);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    txId = created.body.id as string;
    token = created.body.invitation.token as string;
  }

  const accepted = await a.seller.post('/v1/invitations/accept', { token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  const versionId = accepted.body.contract.currentVersion.id;

  expect(
    (
      await a.buyer.post(`/v1/transactions/${txId}/accept-terms`, {
        contractVersionId: versionId,
        accept: true,
      })
    ).status,
  ).toBe(200);
  const afterSeller = await a.seller.post(`/v1/transactions/${txId}/accept-terms`, {
    contractVersionId: versionId,
    accept: true,
  });
  expect(afterSeller.status).toBe(200);
  expect(afterSeller.body.contract.status).toBe('ACCEPTED');

  for (const c of [a.buyer, a.seller]) {
    const v = await c.post('/v1/verifications/identity', { documentType: 'PASSPORT', issuingCountry: 'CA' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    expect(v.body.status).toBe('SIMULATED_PASS');
    expect(v.body.simulated).toBe(true);
  }

  const funding = await a.buyer.post(`/v1/transactions/${txId}/funding/request`, {
    method: 'BANK_TRANSFER_SIMULATED',
  });
  expect(funding.status, JSON.stringify(funding.body)).toBe(200);
  expect(funding.body.status).toBe('AWAITING_FUNDING');
  const fundingReference = funding.body.funding.reference as string;

  const confirmed = await a.buyer.post('/v1/sandbox/partner/funding-events', {
    fundingReference,
    outcome: 'CONFIRMED',
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(confirmed.body.outcome).toBe('CONFIRMED');

  const tx = await a.buyer.get(`/v1/transactions/${txId}`);
  expect(tx.body.status).toBe('FUNDED');
  return { txId, fundingReference, tx: tx.body };
}

export async function uploadEvidence(client: Client, txId: string, kind: string, name = 'proof.pdf') {
  const res = await client.upload(
    `/v1/transactions/${txId}/documents`,
    { kind, title: `${kind} ${name}` },
    {
      name,
      buffer: name.endsWith('.png') ? PNG_BYTES : PDF_BYTES,
      type: name.endsWith('.png') ? 'image/png' : 'application/pdf',
    },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}
