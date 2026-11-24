import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, OTHER_TENANT, TEST_TENANT } from './helpers/fake-supabase';

vi.mock('../netlify/lib/supabase', () => import('./helpers/fake-supabase'));

import quote from '../netlify/functions/quote';
import track from '../netlify/functions/track';
import adminAuth from '../netlify/functions/admin-auth';
import adminShipments from '../netlify/functions/admin-shipments';
import { createSessionToken, verifySessionToken } from '../netlify/lib/session';
import { siteConfig } from '../src/config/site.config';

const SITE = 'https://site.test';
const context = { ip: '203.0.113.7' } as any;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SITE, Host: 'site.test', ...headers },
    body: JSON.stringify(body),
  });
}

const validQuote = {
  full_name: 'Awa Diop',
  phone: '+15145550199',
  email: 'awa@example.com',
  shipment_type: 'vehicle',
  vehicle_make: 'Toyota',
  vehicle_model: 'Corolla',
  vehicle_year: '2015',
  vehicle_running: 'no',
  destination: 'dakar',
  consent: true,
  locale: 'en',
};

beforeEach(() => {
  resetDb();
  // Les tests couvrent le site complet, quel que soit le réglage du client.
  siteConfig.features.tracking = true;
  process.env.ADMIN_SESSION_SECRET = 'un-secret-de-test-de-plus-de-32-caracteres';
  process.env.RATE_LIMIT_SALT = 'sel';
  delete process.env.RESEND_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/quote', () => {
  it('enregistre la demande avec le tenant et la preuve de consentement', async () => {
    const response = await quote(post('/api/quote', validQuote), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, reference: 'DV-26-01001' });

    expect(db.tables.quote_requests).toHaveLength(1);
    expect(db.tables.quote_requests[0]).toMatchObject({
      tenant_id: TEST_TENANT,
      full_name: 'Awa Diop',
      vehicle_running: false,
      vehicle_year: 2015,
      consent_given: true,
      consent_policy_version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      locale: 'en',
    });
  });

  it('renvoie les erreurs de champ sans rien enregistrer', async () => {
    const response = await quote(post('/api/quote', { ...validQuote, email: 'pas-un-courriel', consent: false }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'validation', fields: { email: 'email', consent: 'consent' } });
    expect(db.tables.quote_requests).toHaveLength(0);
  });

  it('ignore en silence les robots qui remplissent le champ piège', async () => {
    const response = await quote(post('/api/quote', { ...validQuote, website: 'https://spam.example' }), context);
    expect(response.status).toBe(201);
    expect((await response.json()).ok).toBe(true);
    expect(db.tables.quote_requests).toHaveLength(0);
  });

  it('bloque après 5 demandes de la même adresse IP', async () => {
    for (let i = 0; i < 5; i++) expect((await quote(post('/api/quote', validQuote), context)).status).toBe(201);
    const blocked = await quote(post('/api/quote', validQuote), context);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ ok: false, error: 'rate_limited' });
    // Une autre adresse n'est pas touchée.
    expect((await quote(post('/api/quote', validQuote), { ip: '198.51.100.9' } as any)).status).toBe(201);
    expect(db.tables.quote_requests).toHaveLength(6);
  });

  it('refuse les requêtes venues d’un autre site et les autres méthodes', async () => {
    expect((await quote(post('/api/quote', validQuote, { Origin: 'https://evil.example' }), context)).status).toBe(403);
    expect((await quote(new Request(`${SITE}/api/quote`), context)).status).toBe(405);
    expect(db.tables.quote_requests).toHaveLength(0);
  });

  it("prévient l'exportateur par courriel, avec réponse directe au demandeur", async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.QUOTE_NOTIFY_EMAIL = 'devis@exportateur.test';
    process.env.QUOTE_FROM_EMAIL = 'site@exportateur.test';
    const fetchMock = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await quote(post('/api/quote', { ...validQuote, message: '<b>Bonjour</b>' }), context);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    const mail = JSON.parse(init.body as string);
    expect(mail).toMatchObject({ to: ['devis@exportateur.test'], reply_to: 'awa@example.com' });
    expect(mail.subject).toContain('DV-26-01001');
    expect(mail.text).toContain('Toyota');
    expect(mail.html).not.toContain('<b>Bonjour</b>');
  });

  it('garde la demande même si le courriel échoue', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.QUOTE_NOTIFY_EMAIL = 'devis@exportateur.test';
    process.env.QUOTE_FROM_EMAIL = 'site@exportateur.test';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    const response = await quote(post('/api/quote', validQuote), context);
    expect(response.status).toBe(201);
    expect(db.tables.quote_requests).toHaveLength(1);
  });
});

describe('GET /api/track', () => {
  const get = (q: string) => track(new Request(`${SITE}/api/track?q=${encodeURIComponent(q)}`), context);

  beforeEach(() => {
    db.tables.shipments.push(
      {
        id: 's1', tenant_id: TEST_TENANT, reference: 'OOL-26-0001', container_number: 'MSCU1234567',
        origin_port: 'Montréal', destination_port: 'Dakar', eta: '2026-12-20', current_status: 'on_board',
        internal_note: 'Client : Awa Diop, 514 555-0199, facturé 2 400 $', created_at: '2026-11-01T10:00:00Z',
      },
      {
        id: 's2', tenant_id: OTHER_TENANT, reference: 'AUTRE-0001', container_number: 'CMAU7654321',
        origin_port: 'Halifax', destination_port: 'Lagos', eta: null, current_status: 'received_at_warehouse',
        internal_note: null, created_at: '2026-11-02T10:00:00Z',
      },
    );
    db.tables.shipment_events.push(
      { id: 'e2', shipment_id: 's1', status: 'on_board', occurred_at: '2026-11-10T08:00:00Z', location: 'Quai 4', source: 'manual', raw_payload: { secret: 1 } },
      { id: 'e1', shipment_id: 's1', status: 'received_at_warehouse', occurred_at: '2026-11-02T08:00:00Z', location: 'Entrepôt', source: 'manual', raw_payload: null },
    );
  });

  it('renvoie uniquement les champs publics, étapes dans l’ordre', async () => {
    const response = await get('ool-26-0001');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      shipment: {
        status: 'on_board',
        origin_port: 'Montréal',
        destination_port: 'Dakar',
        eta: '2026-12-20',
        events: [
          { status: 'received_at_warehouse', occurred_at: '2026-11-02T08:00:00Z' },
          { status: 'on_board', occurred_at: '2026-11-10T08:00:00Z' },
        ],
      },
    });
    const raw = JSON.stringify(body);
    for (const leak of ['Awa', '514', '2 400', 'internal_note', 'tenant', 'raw_payload', 'Quai', 's1']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('trouve aussi par numéro de conteneur, espaces et tirets tolérés', async () => {
    expect((await get('mscu 123456-7')).status).toBe(200);
  });

  it('ne montre jamais les expéditions d’un autre tenant', async () => {
    const response = await get('AUTRE-0001');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
    expect((await get('CMAU7654321')).status).toBe(404);
  });

  it('refuse les numéros mal formés avant toute lecture', async () => {
    for (const bad of ['', 'abc', 'x'.repeat(31), 'OOL,reference.neq.x', 'a(b)c*']) {
      expect((await get(bad)).status).toBe(400);
    }
  });

  it('limite le nombre de recherches par adresse IP', async () => {
    for (let i = 0; i < 30; i++) await get('OOL-26-0001');
    expect((await get('OOL-26-0001')).status).toBe(429);
  });
});

describe('administration', () => {
  const ADMIN = 'patron@exportateur.test';
  const cookie = (email = ADMIN) => ({ Cookie: `admin_session=${createSessionToken(email)}` });
  const shipments = (body: unknown, headers: Record<string, string> = cookie()) =>
    adminShipments(post('/api/admin/shipments', body, headers));

  beforeEach(() => {
    db.tables.admin_users.push({ email: ADMIN, tenant_id: TEST_TENANT });
  });

  it('signe les sessions et rejette les jetons modifiés ou expirés', () => {
    const token = createSessionToken(ADMIN, 1_000_000);
    expect(verifySessionToken(token, 1_000_000)).toBe(ADMIN);
    expect(verifySessionToken(token, 1_000_000 + 8 * 86_400_000)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ email: 'pirate@evil.test', exp: 9_999_999_999 })).toString('base64url');
    expect(verifySessionToken(`${forged}.${token.split('.')[1]}`, 1_000_000)).toBeNull();
    expect(verifySessionToken('n-importe-quoi')).toBeNull();
  });

  it("n'envoie le lien qu'aux courriels autorisés, sans révéler la liste", async () => {
    const allowed = await adminAuth(post('/api/admin/auth', { action: 'request', email: ADMIN }), context);
    const unknown = await adminAuth(post('/api/admin/auth', { action: 'request', email: 'inconnu@evil.test' }), context);
    expect(await allowed.json()).toEqual({ ok: true });
    expect(await unknown.json()).toEqual({ ok: true });
    expect(db.sentOtps).toEqual([ADMIN]);
  });

  it('ouvre une session avec le bon code, pas avec un mauvais', async () => {
    const wrong = await adminAuth(post('/api/admin/auth', { action: 'verify', email: ADMIN, code: '000000' }), context);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();

    const right = await adminAuth(post('/api/admin/auth', { action: 'verify', email: ADMIN, code: '123456' }), context);
    expect(right.status).toBe(200);
    const setCookie = right.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^admin_session=.+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict; Secure$/);

    const session = await adminAuth(new Request(`${SITE}/api/admin/auth`, { headers: { Cookie: setCookie.split(';')[0] } }), context);
    expect(await session.json()).toEqual({ ok: true, authenticated: true, email: ADMIN });
  });

  it('refuse un compte Supabase valide qui n’est pas dans admin_users', async () => {
    const response = await adminAuth(
      post('/api/admin/auth', { action: 'session', access_token: 'valid-token:intrus@evil.test' }),
      context,
    );
    expect(response.status).toBe(401);
    const ok = await adminAuth(post('/api/admin/auth', { action: 'session', access_token: `valid-token:${ADMIN}` }), context);
    expect(ok.status).toBe(200);
  });

  it('ferme toutes les routes sans session valide', async () => {
    expect((await shipments({ action: 'create' }, {})).status).toBe(401);
    expect((await adminShipments(new Request(`${SITE}/api/admin/shipments`))).status).toBe(401);
    expect((await shipments({ action: 'create' }, cookie('intrus@evil.test'))).status).toBe(401);
    // Retirer le courriel de la liste coupe l'accès, même avec un témoin encore valide.
    db.tables.admin_users = [];
    expect((await shipments({ action: 'create' })).status).toBe(401);
  });

  it('crée une expédition, ajoute et retire des étapes, et le suivi public suit', async () => {
    const created = await shipments({
      action: 'create', reference: ' ool-26-0042 ', container_number: 'mscu 765432-1',
      origin_port: 'Port de Montréal', destination_port: 'Abidjan', eta: '2027-01-15', internal_note: 'Client Koné',
    });
    expect(created.status).toBe(201);
    const { shipment } = await created.json();
    expect(shipment).toMatchObject({
      reference: 'OOL-26-0042', container_number: 'MSCU7654321', current_status: 'received_at_warehouse',
      shipment_events: [{ status: 'received_at_warehouse', source: 'manual' }],
    });
    expect(db.tables.shipments[0].tenant_id).toBe(TEST_TENANT);

    expect((await shipments({ action: 'create', reference: 'OOL-26-0042', origin_port: 'A', destination_port: 'B' })).status).toBe(409);

    const added = await shipments({ action: 'add_event', shipment_id: shipment.id, status: 'loaded_in_container', location: 'Entrepôt' });
    expect(added.status).toBe(201);
    const afterAdd = (await added.json()).shipment;
    expect(afterAdd.current_status).toBe('loaded_in_container');
    expect(afterAdd.shipment_events).toHaveLength(2);

    const publicView = await (await track(new Request(`${SITE}/api/track?q=MSCU7654321`), context)).json();
    expect(publicView.shipment.status).toBe('loaded_in_container');
    expect(JSON.stringify(publicView)).not.toContain('Koné');

    const removed = await shipments({ action: 'delete_event', event_id: afterAdd.shipment_events[1].id });
    expect((await removed.json()).shipment.current_status).toBe('received_at_warehouse');

    const updated = await shipments({ action: 'update', id: shipment.id, eta: '', container_number: 'CMAU1111111' });
    expect((await updated.json()).shipment).toMatchObject({ eta: null, container_number: 'CMAU1111111' });

    const listed = await adminShipments(new Request(`${SITE}/api/admin/shipments?q=cmau`, { headers: cookie() }));
    expect((await listed.json()).shipments).toHaveLength(1);
  });

  it('valide les saisies et protège les expéditions des autres tenants', async () => {
    expect(await (await shipments({ action: 'create', reference: 'x', origin_port: 'A', destination_port: 'B' })).json())
      .toMatchObject({ error: 'reference_required' });
    expect(await (await shipments({ action: 'create', reference: 'OOL-1', origin_port: '', destination_port: 'B' })).json())
      .toMatchObject({ error: 'ports_required' });
    expect(await (await shipments({ action: 'create', reference: 'OOL-1', container_number: '!!', origin_port: 'A', destination_port: 'B' })).json())
      .toMatchObject({ error: 'container_invalid' });

    const foreign = '33333333-3333-4333-8333-333333333333';
    db.tables.shipments.push({ id: foreign, tenant_id: OTHER_TENANT, reference: 'AUTRE-1', current_status: 'on_board', created_at: '2026-01-01' });
    expect((await shipments({ action: 'add_event', shipment_id: foreign, status: 'on_board' })).status).toBe(404);
    expect((await shipments({ action: 'update', id: foreign, eta: '2027-01-01' })).status).toBe(404);
    expect((await shipments({ action: 'add_event', shipment_id: foreign, status: 'en_orbite' })).status).toBe(400);
    expect(db.tables.shipment_events).toHaveLength(0);
  });
});

describe('suivi désactivé dans la config', () => {
  beforeEach(() => {
    siteConfig.features.tracking = false;
    db.tables.admin_users.push({ email: 'patron@exportateur.test', tenant_id: TEST_TENANT });
    db.tables.shipments.push({
      id: 's1', tenant_id: TEST_TENANT, reference: 'OOL-26-0001', container_number: null,
      origin_port: 'Montréal', destination_port: 'Dakar', eta: null, current_status: 'on_board', created_at: '2026-11-01T10:00:00Z',
    });
  });

  it('ferme le suivi public et l’administration', async () => {
    const cookie = { Cookie: `admin_session=${createSessionToken('patron@exportateur.test')}` };
    const responses = [
      await track(new Request(`${SITE}/api/track?q=OOL-26-0001`), context),
      await adminAuth(new Request(`${SITE}/api/admin/auth`, { headers: cookie }), context),
      await adminAuth(post('/api/admin/auth', { action: 'request', email: 'patron@exportateur.test' }), context),
      await adminShipments(new Request(`${SITE}/api/admin/shipments`, { headers: cookie })),
      await adminShipments(post('/api/admin/shipments', { action: 'create', reference: 'OOL-1', origin_port: 'A', destination_port: 'B' }, cookie)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: 'not_found' });
    }
    expect(db.sentOtps).toEqual([]);
    expect(db.tables.shipments).toHaveLength(1);
  });

  it('laisse le devis fonctionner', async () => {
    const response = await quote(post('/api/quote', validQuote), context);
    expect(response.status).toBe(201);
    expect(db.tables.quote_requests).toHaveLength(1);
  });
});
