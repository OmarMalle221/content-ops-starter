import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode, ProviderNotActivatableError } from '@dfn/shared';
import {
  HttpReferenceKycProvider,
  HttpReferenceSanctionsProvider,
  PartnerCallError,
  SandboxKycProvider,
  SandboxSanctionsProvider,
  createKycProvider,
  createSanctionsProvider,
  mapKycDecision,
  signReferenceWebhook,
} from '../src';
import { startMockPartner, type MockHandler, type MockPartner } from './helpers/mock-partner';

const API_KEY = 'ref_test_key_0123456789';
const WEBHOOK_SECRET = 'whsec_reference_kyc_0123456789';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const PERSON = {
  userId: '9b2f6a10-0000-4000-8000-000000000001',
  firstName: 'Awa',
  lastName: 'Diop',
  country: 'SN',
  documentType: 'PASSPORT' as const,
  issuingCountry: 'SN',
  dateOfBirth: '1990-04-12',
  documentId: 'doc-123',
  sandboxOutcome: 'FAIL' as const,
};

let partner: MockPartner | undefined;
afterEach(async () => {
  await partner?.close();
  partner = undefined;
});

/** Happy-path partner: create applicant → submit check → decision. */
function kycHandler(decision = 'APPROVED', extra: Record<string, unknown> = {}): MockHandler {
  return (req) => {
    if (req.method === 'POST' && req.path === '/v1/applicants') return { status: 201, body: { id: 'app_1' } };
    if (req.method === 'POST' && req.path === '/v1/applicants/app_1/checks') {
      return { status: 202, body: { checkId: 'chk_1', status: 'SUBMITTED' } };
    }
    if (req.method === 'GET' && req.path === '/v1/applicants/app_1/decision') {
      return {
        status: 200,
        body: { applicantId: 'app_1', decision, reasons: ['document readable'], decidedAt: null, ...extra },
      };
    }
    return { status: 404, body: { message: 'no route' } };
  };
}

async function kycProvider(handler: MockHandler, overrides: Record<string, unknown> = {}) {
  partner = await startMockPartner(handler);
  const delays: number[] = [];
  const provider = new HttpReferenceKycProvider({
    baseUrl: partner.baseUrl,
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    timeoutMs: 1_000,
    maxRetries: 2,
    sleep: async (ms) => {
      delays.push(ms);
    },
    now: () => NOW,
    ...overrides,
  });
  return { provider, delays, partner };
}

async function expectPartnerError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PartnerCallError);
  expect((err as PartnerCallError).code).toBe(code);
  return err as PartnerCallError;
}

describe('HttpReferenceKycProvider — request contract', () => {
  it('creates the applicant, submits the check and fetches the decision with auth and idempotency headers', async () => {
    const { provider, partner } = await kycProvider(kycHandler('PENDING'));
    const result = await provider.startIdentityCheck(PERSON);

    expect(partner.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/applicants',
      'POST /v1/applicants/app_1/checks',
      'GET /v1/applicants/app_1/decision',
    ]);
    for (const r of partner.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(r.headers.accept).toBe('application/json');
      expect(String(r.headers['user-agent'])).toMatch(/^dfn-reference-adapter\//);
    }
    const [create, submit, decision] = partner.requests;
    expect(create.headers['content-type']).toBe('application/json');
    expect(create.json).toEqual({
      externalId: PERSON.userId,
      kind: 'PERSON',
      firstName: 'Awa',
      lastName: 'Diop',
      country: 'SN',
      dateOfBirth: '1990-04-12',
    });
    // The sandbox-only knob never leaves the platform.
    expect(create.rawBody).not.toContain('sandboxOutcome');
    expect(submit.json).toEqual({
      checkType: 'IDENTITY_DOCUMENT',
      documentType: 'PASSPORT',
      issuingCountry: 'SN',
      documentRef: 'doc-123',
    });
    expect(String(create.headers['idempotency-key'])).toMatch(/^dfn-kyc-person-applicant-[0-9a-f]{40}$/);
    expect(String(submit.headers['idempotency-key'])).toMatch(/^dfn-kyc-person-check-[0-9a-f]{40}$/);
    expect(decision.headers['idempotency-key']).toBeUndefined();

    expect(result).toMatchObject({
      provider: 'reference',
      providerRef: 'app_1',
      status: 'PENDING',
      simulated: false,
      providerDecision: 'PENDING',
      requiresManualReview: true,
      checkedAt: NOW.toISOString(),
      raw: { applicantId: 'app_1', checkId: 'chk_1', decision: 'PENDING' },
    });
  });

  it('derives the same idempotency key for the same payload (replays are safe)', async () => {
    const { provider, partner } = await kycProvider(kycHandler('PENDING'));
    await provider.startIdentityCheck(PERSON);
    await provider.startIdentityCheck(PERSON);
    const keys = partner.requests
      .filter((r) => r.path === '/v1/applicants')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('maps a provider APPROVED decision to PENDING + manual review (never a pass)', async () => {
    const { provider } = await kycProvider(kycHandler('APPROVED'));
    const r = await provider.startIdentityCheck(PERSON);
    expect(r.status).toBe('PENDING');
    expect(r.providerDecision).toBe('APPROVED');
    expect(r.requiresManualReview).toBe(true);
    expect(r.simulated).toBe(false);
    expect(['SIMULATED_PASS', 'SIMULATED_FAIL']).not.toContain(r.status);
    expect(mapKycDecision('APPROVED')).toBe('PENDING');
    expect(mapKycDecision('NEEDS_REVIEW')).toBe('PENDING');
    expect(mapKycDecision('REJECTED')).toBe('REJECTED');
  });

  it('maps REJECTED to REJECTED with the provider reasons', async () => {
    const { provider } = await kycProvider(kycHandler('REJECTED', { reasons: ['expired document'] }));
    const r = await provider.startIdentityCheck(PERSON);
    expect(r.status).toBe('REJECTED');
    expect(r.reasons).toEqual(['expired document']);
    expect(r.requiresManualReview).toBe(true);
  });

  it('sends the business applicant and registry check', async () => {
    const { provider, partner } = await kycProvider(kycHandler('NEEDS_REVIEW'));
    const r = await provider.startBusinessCheck({
      organizationId: 'org-1',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
      registrationCountry: 'SN',
      businessType: 'SARL',
      registrationDocumentId: 'doc-9',
    });
    expect(partner.requests[0].json).toEqual({
      externalId: 'org-1',
      kind: 'BUSINESS',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
      registrationCountry: 'SN',
      businessType: 'SARL',
    });
    expect(partner.requests[1].json).toEqual({ checkType: 'BUSINESS_REGISTRY', documentRef: 'doc-9' });
    expect(String(partner.requests[0].headers['idempotency-key'])).toMatch(/^dfn-kyc-business-applicant-/);
    expect(r.status).toBe('PENDING');
    expect(r.providerDecision).toBe('NEEDS_REVIEW');
  });

  it('refuses decisions for another applicant or with an unknown decision', async () => {
    const other = await kycProvider(() => ({
      status: 200,
      body: { applicantId: 'app_2', decision: 'APPROVED' },
    }));
    await expectPartnerError(other.provider.fetchDecision('app_1'), 'BAD_RESPONSE');
    await other.partner.close();
    partner = undefined;
    const unknown = await kycProvider(() => ({
      status: 200,
      body: { applicantId: 'app_1', decision: 'VERIFIED' },
    }));
    await expectPartnerError(unknown.provider.fetchDecision('app_1'), 'BAD_RESPONSE');
  });
});

describe('HttpReferenceKycProvider — errors, timeouts and retries', () => {
  it('retries 5xx with the SAME idempotency key and exponential back-off', async () => {
    const { provider, partner, delays } = await kycProvider((req, i) =>
      i < 2 ? { status: 503, body: { message: 'maintenance' } } : kycHandler('PENDING')(req, i),
    );
    const r = await provider.startIdentityCheck(PERSON);
    expect(r.status).toBe('PENDING');
    const creates = partner.requests.filter((x) => x.path === '/v1/applicants');
    expect(creates).toHaveLength(3);
    expect(new Set(creates.map((x) => x.headers['idempotency-key'])).size).toBe(1);
    expect(delays).toEqual([200, 400]);
  });

  it('gives up after maxRetries with UNAVAILABLE and the attempt count', async () => {
    const { provider, partner } = await kycProvider(() => ({ status: 500, body: {} }));
    const err = await expectPartnerError(provider.startIdentityCheck(PERSON), 'UNAVAILABLE');
    expect(err.attempts).toBe(3);
    expect(err.httpStatus).toBe(500);
    expect(partner.requests).toHaveLength(3);
  });

  it('honours Retry-After on 429 (capped by maxRetryDelayMs)', async () => {
    const { provider, delays } = await kycProvider(
      (req, i) =>
        i === 0 ? { status: 429, headers: { 'Retry-After': '30' }, body: {} } : kycHandler('PENDING')(req, i),
      { maxRetryDelayMs: 1_500 },
    );
    await provider.startIdentityCheck(PERSON);
    expect(delays).toEqual([1_500]);
  });

  it('times out slow partners and retries the idempotent call', async () => {
    const { provider, partner } = await kycProvider(
      () => ({ status: 201, body: { id: 'app_1' }, delayMs: 400 }),
      {
        timeoutMs: 50,
        maxRetries: 1,
      },
    );
    const err = await expectPartnerError(provider.startIdentityCheck(PERSON), 'TIMEOUT');
    expect(err.attempts).toBe(2);
    expect(partner.requests).toHaveLength(2);
    expect(partner.requests[0].headers['idempotency-key']).toBe(
      partner.requests[1].headers['idempotency-key'],
    );
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [422, 'INVALID_REQUEST'],
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
  ])('maps HTTP %i to %s without retrying', async (status, code) => {
    const { provider, partner } = await kycProvider(() => ({ status, body: { message: 'nope' } }));
    const err = await expectPartnerError(provider.startIdentityCheck(PERSON), code);
    expect(err.retryable).toBe(false);
    expect(err.attempts).toBe(1);
    expect(partner.requests).toHaveLength(1);
  });

  it('refuses non-JSON and malformed bodies', async () => {
    const { provider } = await kycProvider(() => ({ status: 201, raw: '<html>oops</html>' }));
    await expectPartnerError(provider.startIdentityCheck(PERSON), 'BAD_RESPONSE');
    await partner!.close();
    const missingId = await kycProvider(() => ({ status: 201, body: { applicant: 'x' } }));
    await expectPartnerError(missingId.provider.startIdentityCheck(PERSON), 'BAD_RESPONSE');
  });

  it('reports unreachable partners as NETWORK errors', async () => {
    const { provider, partner } = await kycProvider(kycHandler());
    await partner.close();
    const err = await expectPartnerError(provider.startIdentityCheck(PERSON), 'NETWORK');
    expect(err.attempts).toBe(3);
  });

  it('validates its configuration', () => {
    const base = { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET };
    expect(() => new HttpReferenceKycProvider({ ...base, baseUrl: 'http://partner.example.com' })).toThrow(
      /https/,
    );
    expect(() => new HttpReferenceKycProvider({ ...base, baseUrl: 'not a url' })).toThrow(PartnerCallError);
    expect(
      () =>
        new HttpReferenceKycProvider({ ...base, baseUrl: 'https://partner.example.com', apiKey: 'short' }),
    ).toThrow(/API key/);
    expect(
      () =>
        new HttpReferenceKycProvider({ ...base, baseUrl: 'https://partner.example.com', webhookSecret: 'x' }),
    ).toThrow(/secret/);
    expect(
      new HttpReferenceKycProvider({ ...base, baseUrl: 'https://partner.example.com/api' }).simulated,
    ).toBe(false);
  });
});

describe('HttpReferenceKycProvider — signed decision webhooks', () => {
  const provider = new HttpReferenceKycProvider({
    baseUrl: 'https://partner.example.com',
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
    now: () => NOW,
  });
  const body = JSON.stringify({
    eventId: 'evt_1',
    type: 'applicant.decision',
    applicantId: 'app_1',
    decision: 'APPROVED',
    reasons: ['all checks passed'],
    occurredAt: '2026-10-11T11:59:00Z',
  });
  const signed = (rawBody: string, ts = NOW_S, secret = WEBHOOK_SECRET) => ({
    rawBody,
    timestamp: String(ts),
    signature: signReferenceWebhook(secret, String(ts), rawBody),
  });

  it('accepts a valid signature and maps the decision to manual review', () => {
    const d = provider.parseDecisionWebhook(signed(body));
    expect(d).toMatchObject({
      providerRef: 'app_1',
      eventId: 'evt_1',
      status: 'PENDING',
      providerDecision: 'APPROVED',
      requiresManualReview: true,
      simulated: false,
      decidedAt: '2026-10-11T11:59:00.000Z',
    });
  });

  it('accepts any valid signature among several (secret rotation)', () => {
    const w = signed(body);
    const old = signReferenceWebhook('whsec_previous_secret_000000', w.timestamp, body);
    expect(provider.parseDecisionWebhook({ ...w, signature: `${old}, ${w.signature}` }).eventId).toBe(
      'evt_1',
    );
  });

  it('rejects a tampered body, a wrong secret and malformed signatures', () => {
    const w = signed(body);
    const tampered = body.replace('APPROVED', 'REJECTED');
    const attempts = [
      { ...w, rawBody: tampered },
      signed(body, NOW_S, 'whsec_attacker_secret_00000000'),
      { ...w, signature: w.signature.slice(3) },
      { ...w, signature: 'v1=zz' },
      { ...w, signature: '' },
      { ...w, timestamp: 'yesterday' },
    ];
    for (const attempt of attempts) {
      try {
        provider.parseDecisionWebhook(attempt);
        expect.unreachable('webhook should have been refused');
      } catch (e) {
        expect((e as PartnerCallError).code).toBe('SIGNATURE_INVALID');
      }
    }
  });

  it('rejects correctly signed but expired or future-dated webhooks (replay protection)', () => {
    for (const ts of [NOW_S - 301, NOW_S + 301]) {
      expect(() => provider.parseDecisionWebhook(signed(body, ts))).toThrow(
        expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }),
      );
    }
    expect(provider.parseDecisionWebhook(signed(body, NOW_S - 299)).eventId).toBe('evt_1');
  });

  it('rejects unsupported event types', () => {
    const other = JSON.stringify({ eventId: 'e', type: 'applicant.deleted', applicantId: 'a' });
    expect(() => provider.parseDecisionWebhook(signed(other))).toThrow(
      expect.objectContaining({ code: 'BAD_RESPONSE' }),
    );
  });
});

describe('HttpReferenceSanctionsProvider', () => {
  async function sanctions(handler: MockHandler) {
    partner = await startMockPartner(handler);
    return {
      provider: new HttpReferenceSanctionsProvider({
        baseUrl: partner.baseUrl,
        apiKey: API_KEY,
        sleep: async () => undefined,
        now: () => NOW,
      }),
      partner,
    };
  }

  it('posts the screening and maps a clear result', async () => {
    const { provider, partner } = await sanctions(() => ({
      status: 200,
      body: { screeningId: 'scr_1', status: 'CLEAR', matches: [] },
    }));
    const r = await provider.screen({ fullName: 'Awa Diop', country: 'SN', dateOfBirth: '1990-04-12' });
    expect(partner.requests[0].method).toBe('POST');
    expect(partner.requests[0].path).toBe('/v1/screenings');
    expect(partner.requests[0].json).toEqual({
      fullName: 'Awa Diop',
      country: 'SN',
      dateOfBirth: '1990-04-12',
    });
    expect(partner.requests[0].headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(String(partner.requests[0].headers['idempotency-key'])).toMatch(/^dfn-sanctions-screening-/);
    expect(r).toEqual({
      provider: 'reference',
      simulated: false,
      status: 'CLEAR',
      matches: [],
      screenedAt: NOW.toISOString(),
      providerRef: 'scr_1',
      requiresManualReview: false,
    });
  });

  it('flags potential matches for manual review', async () => {
    const { provider } = await sanctions(() => ({
      status: 200,
      body: {
        screeningId: 'scr_2',
        status: 'POTENTIAL_MATCH',
        matches: [{ list: 'REFERENCE_LIST', name: 'A. Diop', score: 0.87 }],
      },
    }));
    const r = await provider.screen({ fullName: 'Awa Diop' });
    expect(r.status).toBe('POTENTIAL_MATCH');
    expect(r.requiresManualReview).toBe(true);
    expect(r.matches).toEqual([{ list: 'REFERENCE_LIST', name: 'A. Diop', score: 0.87 }]);
  });

  it.each([
    { screeningId: 's', status: 'CLEAR_SIMULATED', matches: [] },
    { screeningId: 's', status: 'POTENTIAL_MATCH', matches: [] },
    { screeningId: 's', status: 'POTENTIAL_MATCH', matches: [{ list: 'L', name: 'N', score: 7 }] },
    { screeningId: 's', status: 'CLEAR' },
  ])('refuses inconsistent screening responses (%o)', async (body) => {
    const { provider } = await sanctions(() => ({ status: 200, body }));
    await expectPartnerError(provider.screen({ fullName: 'Awa Diop' }), 'BAD_RESPONSE');
  });
});

describe('factories stay sandbox-only', () => {
  it.each(['reference', 'acme-kyc', 'live', 'REFERENCE'])('refuses KYC / sanctions code %s', (code) => {
    for (const factory of [createKycProvider, createSanctionsProvider]) {
      try {
        factory(code);
        expect.unreachable('factory must refuse non-sandbox codes');
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderNotActivatableError);
        const err = e as ProviderNotActivatableError;
        expect(err.code).toBe(ErrorCode.PROVIDER_NOT_ACTIVATABLE);
        expect(err.requiredGates).toEqual(['R1', 'R2', 'R7', 'R8']);
        expect(err.message).toMatch(/sandbox-only/);
      }
    }
  });

  it('builds the sandbox providers for sandbox / unset codes', () => {
    for (const code of ['sandbox', ' SANDBOX ', undefined, '']) {
      expect(createKycProvider(code)).toBeInstanceOf(SandboxKycProvider);
      expect(createSanctionsProvider(code)).toBeInstanceOf(SandboxSanctionsProvider);
    }
  });
});
