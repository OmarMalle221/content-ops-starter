import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpReferencePayoutProvider,
  PartnerCallError,
  SandboxPayoutProvider,
  signReferenceWebhook,
  type PayoutRequest,
} from '../src';
import { startMockPartner, type MockHandler, type MockPartner } from './helpers/mock-partner';

const API_KEY = 'ref_payout_key_0123456789';
const CALLBACK_SECRET = 'whsec_reference_payout_0123456789';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const REQUEST: PayoutRequest = {
  payoutId: 'trf_0001',
  idempotencyKey: 'payout-trf_0001-attempt-1',
  amountMinor: 43_340n,
  currencyCode: 'XOF',
  destinationCountry: 'SN',
  beneficiary: { name: 'Moussa Ndiaye', method: 'MOBILE_MONEY', accountToken: 'tok_benef_123' },
  reference: 'DFN-TRF-0001',
};

let partner: MockPartner | undefined;
afterEach(async () => {
  await partner?.close();
  partner = undefined;
});

/** Partner that stores payouts by Idempotency-Key, like a real idempotent API would. */
function idempotentPartner(): MockHandler {
  const byKey = new Map<string, { payload: string; payout: Record<string, unknown> }>();
  let n = 0;
  return (req) => {
    if (req.method === 'POST' && req.path === '/v1/payouts') {
      const key = String(req.headers['idempotency-key']);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.payload !== req.rawBody) return { status: 409, body: { message: 'key reused' } };
        return { status: 200, body: existing.payout };
      }
      n += 1;
      const payout = {
        id: `po_${n}`,
        clientReference: req.json.clientReference,
        status: 'ACCEPTED',
        amount: req.json.amount,
        createdAt: NOW.toISOString(),
      };
      byKey.set(key, { payload: req.rawBody, payout });
      return { status: 201, body: payout };
    }
    if (req.method === 'GET' && req.path === '/v1/payouts/po_1') {
      return {
        status: 200,
        body: {
          id: 'po_1',
          clientReference: 'trf_0001',
          status: 'COMPLETED',
          amount: { minor: '43340', currency: 'XOF' },
          createdAt: NOW.toISOString(),
        },
      };
    }
    return { status: 404, body: {} };
  };
}

async function reference(handler: MockHandler, overrides: Record<string, unknown> = {}) {
  partner = await startMockPartner(handler);
  const provider = new HttpReferencePayoutProvider({
    baseUrl: partner.baseUrl,
    apiKey: API_KEY,
    callbackSecret: CALLBACK_SECRET,
    timeoutMs: 1_000,
    maxRetries: 2,
    sleep: async () => undefined,
    now: () => NOW,
    ...overrides,
  });
  return { provider, partner };
}

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PartnerCallError);
  expect((err as PartnerCallError).code).toBe(code);
  return err as PartnerCallError;
}

describe('HttpReferencePayoutProvider — contract', () => {
  it('posts the payout with auth + Idempotency-Key and amounts as integer strings', async () => {
    const { provider, partner } = await reference(idempotentPartner());
    const result = await provider.createPayout(REQUEST);
    const [req] = partner.requests;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/payouts');
    expect(req.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(req.headers['idempotency-key']).toBe(REQUEST.idempotencyKey);
    expect(req.json).toEqual({
      clientReference: 'trf_0001',
      amount: { minor: '43340', currency: 'XOF' },
      destinationCountry: 'SN',
      beneficiary: { name: 'Moussa Ndiaye', method: 'MOBILE_MONEY', accountToken: 'tok_benef_123' },
      reference: 'DFN-TRF-0001',
    });
    expect(result).toMatchObject({
      providerCode: 'reference',
      mode: 'LIVE',
      simulated: false,
      payoutId: 'trf_0001',
      externalRef: 'po_1',
      status: 'ACCEPTED',
      amountMinor: 43_340n,
      currencyCode: 'XOF',
    });
  });

  it('is idempotent: a replay returns the same payout, a reused key with other content conflicts', async () => {
    const { provider } = await reference(idempotentPartner());
    const a = await provider.createPayout(REQUEST);
    const b = await provider.createPayout(REQUEST);
    expect(b.externalRef).toBe(a.externalRef);
    await expectCode(provider.createPayout({ ...REQUEST, amountMinor: 50_000n }), 'CONFLICT');
  });

  it('retries a 503 / timeout with the same Idempotency-Key, creating a single payout', async () => {
    const inner = idempotentPartner();
    const { provider, partner } = await reference(
      (req, i) =>
        i === 0 ? { status: 503, body: {} } : i === 1 ? { ...inner(req, i), delayMs: 300 } : inner(req, i),
      { timeoutMs: 100 },
    );
    const result = await provider.createPayout(REQUEST);
    expect(partner.requests).toHaveLength(3);
    expect(new Set(partner.requests.map((r) => r.headers['idempotency-key']))).toEqual(
      new Set([REQUEST.idempotencyKey]),
    );
    // The timed-out attempt was stored by the partner: the retry got the same payout back.
    expect(result.externalRef).toBe('po_1');
  });

  it('refuses a partner echo that does not match the request', async () => {
    const { provider } = await reference(() => ({
      status: 201,
      body: {
        id: 'po_9',
        clientReference: 'trf_other',
        status: 'ACCEPTED',
        amount: { minor: '43340', currency: 'XOF' },
        createdAt: NOW.toISOString(),
      },
    }));
    await expectCode(provider.createPayout(REQUEST), 'BAD_RESPONSE');
  });

  it.each([
    {
      id: 'po_1',
      clientReference: 'trf_0001',
      status: 'DONE',
      amount: { minor: '43340', currency: 'XOF' },
      createdAt: '2026-10-11T12:00:00Z',
    },
    {
      id: 'po_1',
      clientReference: 'trf_0001',
      status: 'ACCEPTED',
      amount: { minor: 43340, currency: 'XOF' },
      createdAt: '2026-10-11T12:00:00Z',
    },
    {
      id: 'po_1',
      clientReference: 'trf_0001',
      status: 'ACCEPTED',
      amount: { minor: '43340', currency: 'XOF' },
    },
  ])('refuses malformed payouts (%o)', async (body) => {
    const { provider } = await reference(() => ({ status: 201, body }));
    await expectCode(provider.createPayout(REQUEST), 'BAD_RESPONSE');
  });

  it('fetches a payout status', async () => {
    const { provider, partner } = await reference(idempotentPartner());
    const r = await provider.getPayout('po_1');
    expect(partner.requests[0].method).toBe('GET');
    expect(partner.requests[0].path).toBe('/v1/payouts/po_1');
    expect(r.status).toBe('COMPLETED');
    await expectCode(provider.getPayout('po_404'), 'NOT_FOUND');
  });

  it('validates requests before any call', async () => {
    const { provider, partner } = await reference(idempotentPartner());
    await expectCode(provider.createPayout({ ...REQUEST, amountMinor: 0n }), 'INVALID_REQUEST');
    await expectCode(provider.createPayout({ ...REQUEST, amountMinor: -5n }), 'INVALID_REQUEST');
    await expectCode(provider.createPayout({ ...REQUEST, idempotencyKey: 'x' }), 'INVALID_REQUEST');
    await expectCode(provider.createPayout({ ...REQUEST, currencyCode: 'xof' }), 'INVALID_REQUEST');
    expect(partner.requests).toHaveLength(0);
  });
});

describe('payout status callbacks', () => {
  const provider = new HttpReferencePayoutProvider({
    baseUrl: 'https://payouts.example.com',
    apiKey: API_KEY,
    callbackSecret: CALLBACK_SECRET,
    now: () => NOW,
  });
  const body = JSON.stringify({
    eventId: 'evt_42',
    type: 'payout.status',
    payoutId: 'trf_0001',
    externalRef: 'po_1',
    status: 'COMPLETED',
    occurredAt: '2026-10-11T11:59:30Z',
  });
  const signed = (rawBody: string, ts = NOW_S, secret = CALLBACK_SECRET) => ({
    rawBody,
    timestamp: String(ts),
    signature: signReferenceWebhook(secret, String(ts), rawBody),
  });

  it('accepts a valid signed callback with a stable idempotency key', () => {
    const e = provider.parseStatusCallback(signed(body));
    expect(e).toMatchObject({
      providerCode: 'reference',
      eventId: 'evt_42',
      idempotencyKey: 'reference:evt_42',
      payoutId: 'trf_0001',
      externalRef: 'po_1',
      status: 'COMPLETED',
      simulated: false,
    });
  });

  it('rejects tampered, wrongly signed and expired callbacks', () => {
    const w = signed(body);
    expect(() =>
      provider.parseStatusCallback({ ...w, rawBody: body.replace('COMPLETED', 'FAILED') }),
    ).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
    expect(() => provider.parseStatusCallback(signed(body, NOW_S, 'whsec_wrong_secret_0000000000'))).toThrow(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );
    expect(() => provider.parseStatusCallback(signed(body, NOW_S - 3_600))).toThrow(
      expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }),
    );
  });

  it('rejects unknown statuses even when correctly signed', () => {
    expect(() => provider.parseStatusCallback(signed(body.replace('COMPLETED', 'PAID_OUT')))).toThrow(
      expect.objectContaining({ code: 'BAD_RESPONSE' }),
    );
  });
});

describe('SandboxPayoutProvider', () => {
  it('simulates an idempotent partner without any network call', async () => {
    const sbx = new SandboxPayoutProvider({ now: () => NOW });
    const a = await sbx.createPayout(REQUEST);
    const b = await sbx.createPayout(REQUEST);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ mode: 'SANDBOX', simulated: true, status: 'ACCEPTED' });
    expect(a.externalRef).toMatch(/^sbx_po_[0-9a-f]{16}$/);
    await expect(sbx.createPayout({ ...REQUEST, amountMinor: 1n })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(sbx.getPayout('sbx_po_unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('produces signed status callbacks that its own verifier accepts, and rejects tampering', async () => {
    const sbx = new SandboxPayoutProvider({ now: () => NOW });
    const { externalRef } = await sbx.createPayout(REQUEST);
    const callback = sbx.simulateStatusCallback(externalRef, 'FAILED', 'SANDBOX: simulated wallet closed');
    const event = sbx.parseStatusCallback(callback);
    expect(event).toMatchObject({
      status: 'FAILED',
      simulated: true,
      mode: 'SANDBOX',
      payoutId: 'trf_0001',
      failureReason: 'SANDBOX: simulated wallet closed',
    });
    expect(event.idempotencyKey).toBe(`SANDBOX_PAYOUT:${event.eventId}`);
    expect((await sbx.getPayout(externalRef)).status).toBe('FAILED');
    expect(() =>
      sbx.parseStatusCallback({ ...callback, rawBody: callback.rawBody.replace('FAILED', 'COMPLETED') }),
    ).toThrow(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });
});
