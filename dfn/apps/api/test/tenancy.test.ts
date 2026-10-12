import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/config/env';
import {
  assertSafeWebhookUrl,
  isHostAllowed,
  unsafeDestinationReason,
} from '../src/modules/api-platform/ssrf';
import { CounterpartiesService } from '../src/modules/organizations/counterparties.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import {
  Client,
  PASSWORD,
  bootTestApp,
  promote,
  registerUser,
  resetDatabase,
  type TestContext,
} from './helpers/app';
import { VEHICLE_TX } from './helpers/protect';
import { createWalletActors, selfDeposit, type WalletActors } from './helpers/wallet';

/**
 * Phase 6 — tenancy hardening: staff are read-only inside organisations they do not belong to,
 * counterparty links need the consent of the target organisation, invoices / quotes persist their
 * tax rate, and webhook destinations can be restricted to an egress allowlist.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await bootTestApp();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  await ctx.app.get(ReferenceDataService).ensure();
});
afterAll(async () => {
  await ctx.close();
});

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const SUPPORT_REASON = 'Ticket SUP-1042: client locked out, invoice correction requested';

function invoiceInput(organizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    customerName: 'Boutique Teranga',
    currencyCode: 'CAD',
    dueDate: inDays(30),
    taxBps: 1800,
    lines: [{ description: 'Conseil export', quantity: 2, unitPrice: '125.50' }],
    ...overrides,
  };
}

async function staffClient(email: string, role: 'ADMIN' | 'COMPLIANCE') {
  await registerUser(ctx, email);
  await promote(ctx, email, role);
  const client = new Client(ctx);
  const login = await client.post('/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  return client;
}

/** Request with the client's session cookie and an optional support reason header. */
function raw(
  client: Client,
  method: 'post' | 'patch' | 'delete',
  url: string,
  body?: unknown,
  reason: string | null = SUPPORT_REASON,
) {
  const cookie = (client as unknown as { cookie: string }).cookie;
  let r = ctx.http()[method](url);
  if (cookie) r = r.set('Cookie', cookie);
  if (reason !== null) r = r.set('X-Support-Reason', reason);
  return method === 'delete' ? r : r.send(body ?? {});
}

// ───────────────────────────── Staff access ─────────────────────────────────

describe('Tenancy — staff are read-only by default', () => {
  let a: WalletActors;
  beforeEach(async () => {
    a = await createWalletActors(ctx, '-ten');
  });

  it('gives COMPLIANCE read access only inside a tenant (writes → 403, even with a support reason)', async () => {
    const inv = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId));
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await a.owner.post(`/v1/invoices/${inv.body.id}/send`)).status).toBe(200);
    const quote = await a.owner.post('/v1/quotes', {
      ...invoiceInput(a.businessOrgId),
      validUntil: inDays(10),
    });
    expect(quote.status).toBe(201);
    const compliance = await staffClient('compliance-ten@example.com', 'COMPLIANCE');
    const biz = a.businessOrgId;

    // Reads
    const org = await compliance.get(`/v1/organizations/${biz}`);
    expect(org.status).toBe(200);
    expect((await compliance.get(`/v1/organizations/${biz}/counterparties`)).status).toBe(200);
    const list = await compliance.get(`/v1/invoices?organizationId=${biz}`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    const detail = await compliance.get(`/v1/invoices/${inv.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.myRole).toBe('STAFF');
    expect(detail.body.nextActions).toEqual(['VIEW_DOCUMENT']);
    const qDetail = await compliance.get(`/v1/quotes/${quote.body.id}`);
    expect(qDetail.body.nextActions).toEqual(['VIEW_DOCUMENT']);
    expect((await compliance.get(`/v1/invoices.csv?organizationId=${biz}`)).status).toBe(200);
    expect((await compliance.get(`/v1/organizations/${biz}/reports/summary`)).status).toBe(200);
    expect((await compliance.get(`/v1/organizations/${biz}/link-requests`)).status).toBe(200);

    // Writes — refused with 403 whatever the support reason
    const ownerMember = org.body.members.find((m: any) => m.role === 'OWNER');
    const writes: Array<() => PromiseLike<any>> = [
      () => raw(compliance, 'post', '/v1/invoices', invoiceInput(biz)),
      () => raw(compliance, 'patch', `/v1/invoices/${inv.body.id}`, { notes: 'x' }),
      () => raw(compliance, 'post', `/v1/invoices/${inv.body.id}/send`),
      () => raw(compliance, 'post', `/v1/invoices/${inv.body.id}/cancel`, { reason: 'x' }),
      () => raw(compliance, 'post', '/v1/quotes', { ...invoiceInput(biz), validUntil: inDays(10) }),
      () => raw(compliance, 'post', `/v1/quotes/${quote.body.id}/send`),
      () => raw(compliance, 'post', `/v1/organizations/${biz}/counterparties`, { name: 'Client' }),
      () =>
        raw(compliance, 'post', `/v1/organizations/${biz}/members/invite`, {
          email: 'new-member@example.com',
          role: 'MEMBER',
        }),
      () => raw(compliance, 'patch', `/v1/organizations/${biz}/members/${ownerMember.id}`, { role: 'ADMIN' }),
      () => raw(compliance, 'delete', `/v1/organizations/${biz}/members/${ownerMember.id}`),
      () =>
        raw(compliance, 'post', `/v1/organizations/${biz}/verification`, {
          legalName: 'Teranga Import SARL',
          registrationNumber: 'SN-DKR-2022-B-4567',
          registrationCountry: 'SN',
          businessType: 'COMPANY',
        }),
      () =>
        compliance.post(`/v1/invoices/${inv.body.id}/payments`, {
          amount: '1.00',
          method: 'EXTERNAL_RECORDED',
        }),
    ];
    for (const write of writes) {
      const res = await write();
      expect(res.status, `${res.req.method} ${res.req.path} → ${JSON.stringify(res.body)}`).toBe(403);
    }
    // Protect transactions: staff never cancel on behalf of a party (read-only, no support write).
    const protect = await a.owner.post('/v1/transactions', VEHICLE_TX);
    expect(protect.status, JSON.stringify(protect.body)).toBe(201);
    const admin = await staffClient('admin-cancel-ten@example.com', 'ADMIN');
    for (const staff of [compliance, admin]) {
      const cancel = await raw(staff, 'post', `/v1/transactions/${protect.body.id}/cancel`, {
        reason: 'Annulation par le support',
      });
      expect(cancel.status, JSON.stringify(cancel.body)).toBe(403);
    }
    expect(
      (await ctx.prisma.transaction.findUniqueOrThrow({ where: { id: protect.body.id } })).status,
    ).not.toBe('CANCELLED');

    // Nothing changed, no support access was recorded
    const row = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: inv.body.id } });
    expect(row.status).toBe('SENT');
    expect(row.paidMinor).toBe(0n);
    expect(row.notes).toBeNull();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'support.write' } })).toBe(0);
    expect(await ctx.prisma.organizationMember.count({ where: { organizationId: biz } })).toBe(2);
  });

  it('lets an ADMIN write for support only with ADMIN_SUPPORT_WRITE and a reason, audited as support', async () => {
    const inv = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId));
    const admin = await staffClient('admin-ten@example.com', 'ADMIN');
    const adminUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email: 'admin-ten@example.com' } });
    const biz = a.businessOrgId;

    // Reads need no reason; the default representation stays read-only
    const detail = await admin.get(`/v1/invoices/${inv.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.nextActions).toEqual(['VIEW_DOCUMENT']);

    // A write without (or with a too short) reason is refused
    const noReason = await raw(admin, 'post', `/v1/invoices/${inv.body.id}/send`, {}, null);
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('VALIDATION_FAILED');
    expect(noReason.body.details).toEqual({ header: 'x-support-reason' });
    expect((await raw(admin, 'post', `/v1/invoices/${inv.body.id}/send`, {}, 'short')).status).toBe(400);
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: inv.body.id } })).status).toBe('DRAFT');

    // With a reason (URI-encoded, non-ASCII) the support write goes through and is audited first
    const frenchReason = 'Demande du client — facture bloquée (ticket SUP-7)';
    const sent = await raw(
      admin,
      'post',
      `/v1/invoices/${inv.body.id}/send`,
      {},
      encodeURIComponent(frenchReason),
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe('SENT');
    const created = await raw(admin, 'post', '/v1/invoices', invoiceInput(biz));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.organizationId).toBe(biz);
    const cp = await raw(admin, 'post', `/v1/organizations/${biz}/counterparties`, {
      name: 'Client support',
    });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);

    const support = await ctx.prisma.auditLog.findMany({
      where: { action: 'support.write' },
      orderBy: { createdAt: 'asc' },
    });
    expect(support).toHaveLength(3);
    for (const entry of support) {
      expect(entry.actorUserId).toBe(adminUser.id);
      expect(entry.organizationId).toBe(biz);
      expect((entry.metadata as any).support).toBe(true);
    }
    expect((support[0]!.metadata as any).reason).toBe(frenchReason);
    expect((support[0]!.metadata as any).permission).toBe('invoice:manage');
    expect((support[0]!.metadata as any).path).toBe(`/v1/invoices/${inv.body.id}/send`);
    expect((support[1]!.metadata as any).reason).toBe(SUPPORT_REASON);
    expect((support[2]!.metadata as any).permission).toBe('transaction:create');
    const createdAudit = await ctx.prisma.auditLog.findFirst({
      where: { action: 'invoice.created', entityId: created.body.id },
    });
    expect((createdAudit!.metadata as any).support).toBe(true);

    // Support never covers consent, money movement or partner credentials
    const pending = await a.owner.post(`/v1/organizations/${biz}/counterparties`, {
      name: 'Jean',
      email: 'wallet-outsider-ten@example.com',
    });
    expect(
      (
        await raw(
          admin,
          'post',
          `/v1/organizations/${a.outsiderOrgId}/link-requests/${pending.body.id}/accept`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await raw(admin, 'post', '/v1/api-credentials', {
          organizationId: biz,
          name: 'Clé support',
          scopes: ['transactions:read'],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await raw(admin, 'post', '/v1/sandbox/wallets/self-deposit', {
          organizationId: biz,
          currencyCode: 'CAD',
          amount: '10.00',
        })
      ).status,
    ).toBe(404);

    // Support never turns staff into a tenant member, nor grants OWNER / ADMIN, nor touches owners.
    const invite = (email: string, role: string) =>
      raw(admin, 'post', `/v1/organizations/${biz}/members/invite`, { email, role });
    expect((await invite('admin-ten@example.com', 'VIEWER')).status).toBe(403);
    expect((await invite('ADMIN-TEN@example.com', 'MEMBER')).status).toBe(403);
    await staffClient('compliance-peer-ten@example.com', 'COMPLIANCE');
    expect((await invite('compliance-peer-ten@example.com', 'VIEWER')).status).toBe(403);
    expect((await invite('new-colleague-ten@example.com', 'ADMIN')).status).toBe(403);
    const supportInvite = await invite('new-colleague-ten@example.com', 'MEMBER');
    expect(supportInvite.status, JSON.stringify(supportInvite.body)).toBe(201);
    expect(supportInvite.body).toMatchObject({ token: null, acceptUrl: null });
    const members = (await a.owner.get(`/v1/organizations/${biz}`)).body.members as Array<{
      id: string;
      role: string;
    }>;
    const owner = members.find((m) => m.role === 'OWNER')!;
    const other = members.find((m) => m.role !== 'OWNER')!;
    expect(
      (await raw(admin, 'patch', `/v1/organizations/${biz}/members/${other.id}`, { role: 'ADMIN' })).status,
    ).toBe(403);
    expect(
      (await raw(admin, 'patch', `/v1/organizations/${biz}/members/${owner.id}`, { role: 'VIEWER' })).status,
    ).toBe(403);
    expect((await raw(admin, 'delete', `/v1/organizations/${biz}/members/${owner.id}`)).status).toBe(403);
    expect(await ctx.prisma.organizationMember.count({ where: { organizationId: biz, role: 'OWNER' } })).toBe(
      1,
    );
  });

  it('keeps the organisation role of staff users who are real members', async () => {
    const inv = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId));
    // The VIEWER member becomes ADMIN staff: inside its organisation it stays a VIEWER
    await promote(ctx, 'wallet-viewer-ten@example.com', 'ADMIN');
    const asMember = await a.viewer.get(`/v1/invoices/${inv.body.id}`);
    expect(asMember.body.myRole).toBe('ISSUER');
    expect(asMember.body.nextActions).toEqual(['VIEW_DOCUMENT']);
    const viewerWrite = await raw(a.viewer, 'post', `/v1/invoices/${inv.body.id}/send`);
    expect(viewerWrite.status).toBe(403);
    // The OWNER becomes COMPLIANCE staff: it keeps full OWNER rights in its own organisations
    await promote(ctx, 'wallet-owner-ten@example.com', 'COMPLIANCE');
    const sent = await a.owner.post(`/v1/invoices/${inv.body.id}/send`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const created = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId));
    expect(created.status).toBe(201);
    expect((await a.owner.get(`/v1/invoices/${created.body.id}`)).body.nextActions).toContain('EDIT');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'support.write' } })).toBe(0);
  });
});

// ───────────────────────────── Link consent ─────────────────────────────────

/** Strips the values that legitimately differ between two counterparties (ids, names, dates). */
function linkShape(body: any) {
  return {
    ...body,
    id: '<id>',
    name: '<name>',
    email: '<email>',
    createdAt: '<date>',
    updatedAt: '<date>',
    link: { ...body.link, requestedAt: body.link.requestedAt ? '<date>' : null },
  };
}

describe('Tenancy — counterparty link consent', () => {
  let a: WalletActors;
  beforeEach(async () => {
    a = await createWalletActors(ctx, '-lnk');
  });

  it('answers identically whether or not the e-mail matches an account and notifies only the target', async () => {
    const base = `/v1/organizations/${a.businessOrgId}/counterparties`;
    const matched = await a.owner.post(base, {
      name: 'Jean Tremblay',
      email: 'wallet-outsider-lnk@example.com',
      country: 'CA',
    });
    const unknown = await a.owner.post(base, {
      name: 'Inconnu SARL',
      email: 'nobody-here@example.com',
      country: 'CA',
    });
    expect(matched.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(linkShape(matched.body)).toStrictEqual(linkShape(unknown.body));
    expect(matched.body.linkRequest).toBe('SENT_IF_ELIGIBLE');
    expect(matched.body.link.status).toBe('REQUESTED');
    expect(matched.body.link.nextActions).toEqual(['REVOKE_LINK']);
    expect(matched.body.linkedOrganizationId).toBeNull();
    const serialized = JSON.stringify(matched.body);
    expect(serialized).not.toContain(a.outsiderOrgId);
    expect(serialized).not.toContain('PENDING');
    expect(serialized).not.toContain('linkRequestedOrganizationId');
    // The listing is indistinguishable too
    const listed = await a.owner.get(base);
    const [l1, l2] = [
      listed.body.find((c: any) => c.id === matched.body.id),
      listed.body.find((c: any) => c.id === unknown.body.id),
    ];
    const { linkRequest: _m, ...matchedNoOutcome } = matched.body;
    void _m;
    expect(linkShape(l1)).toStrictEqual(linkShape(l2));
    expect(linkShape(l1)).toStrictEqual(linkShape(matchedNoOutcome));
    // Without e-mail nor organisation there is no request at all
    const plain = await a.owner.post(base, { name: 'Client comptoir' });
    expect(plain.body.linkRequest).toBe('NOT_REQUESTED');
    expect(plain.body.link.status).toBe('NONE');
    expect(plain.body.link.nextActions).toEqual([]);

    // Only the target organisation (its OWNER) is notified — after the response
    await ctx.app.get(CounterpartiesService).whenIdle();
    const notifs = await ctx.prisma.notification.findMany({ where: { type: 'counterparty.link_requested' } });
    expect(notifs.map((n) => n.userId)).toEqual([a.outsiderUser.id]);
    expect(notifs[0]!.title).toBe('Teranga Import-lnk souhaite vous relier comme client');
    expect((notifs[0]!.data as any).counterpartyId).toBe(matched.body.id);

    // Target side listing
    const requests = await a.outsider.get(`/v1/organizations/${a.outsiderOrgId}/link-requests`);
    expect(requests.status).toBe(200);
    expect(requests.body.items).toHaveLength(1);
    expect(requests.body.items[0]).toMatchObject({
      counterpartyId: matched.body.id,
      status: 'PENDING',
      requesterOrganization: { id: a.businessOrgId, name: 'Teranga Import-lnk' },
      counterpartyName: 'Jean Tremblay',
      nextActions: ['ACCEPT', 'DECLINE'],
    });
    expect(requests.body.items[0].requestedAt).toBeTruthy();
    // Nobody else can read or decide the target's requests
    expect((await a.owner.get(`/v1/organizations/${a.outsiderOrgId}/link-requests`)).status).toBe(404);
    expect((await a.viewer.get(`/v1/organizations/${a.businessOrgId}/link-requests`)).status).toBe(403);
    expect(
      (await a.owner.post(`/v1/organizations/${a.outsiderOrgId}/link-requests/${matched.body.id}/accept`))
        .status,
    ).toBe(404);
    // A request addressed to another organisation is invisible (404) from the target's side
    expect(
      (await a.outsider.post(`/v1/organizations/${a.outsiderOrgId}/link-requests/${unknown.body.id}/accept`))
        .status,
    ).toBe(404);
    // Staff may read, never decide on behalf of the tenant
    const compliance = await staffClient('compliance-lnk@example.com', 'COMPLIANCE');
    const staffView = await compliance.get(`/v1/organizations/${a.outsiderOrgId}/link-requests`);
    expect(staffView.status).toBe(200);
    expect(staffView.body.items[0].nextActions).toEqual([]);
    expect(
      (await compliance.post(`/v1/organizations/${a.outsiderOrgId}/link-requests/${matched.body.id}/accept`))
        .status,
    ).toBe(403);
  });

  it('hides invoices / quotes and blocks wallet payment until accepted, then decline, revoke and cooldown', async () => {
    const cp = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Jean Tremblay',
      email: 'wallet-outsider-lnk@example.com',
    });
    const inv = await a.owner.post(
      '/v1/invoices',
      invoiceInput(a.businessOrgId, {
        counterpartyId: cp.body.id,
        customerEmail: 'wallet-outsider-lnk@example.com',
        taxBps: 0,
        lines: [{ description: 'Service', quantity: 1, unitPrice: '100.00' }],
      }),
    );
    expect(inv.status).toBe(201);
    expect((await a.owner.post(`/v1/invoices/${inv.body.id}/send`)).status).toBe(200);
    const quote = await a.owner.post('/v1/quotes', {
      ...invoiceInput(a.businessOrgId, {
        counterpartyId: cp.body.id,
        customerEmail: 'wallet-outsider-lnk@example.com',
      }),
      validUntil: inDays(10),
    });
    expect((await a.owner.post(`/v1/quotes/${quote.body.id}/send`)).status).toBe(200);
    await selfDeposit(a.outsider, a.outsiderOrgId, 'CAD', '500.00');

    // PENDING: invisible, not notified, not payable
    const hidden = async () => {
      expect((await a.outsider.get(`/v1/invoices/${inv.body.id}`)).status).toBe(404);
      expect((await a.outsider.get(`/v1/quotes/${quote.body.id}`)).status).toBe(404);
      expect(
        (await a.outsider.get(`/v1/invoices?organizationId=${a.outsiderOrgId}&scope=RECEIVED`)).body.total,
      ).toBe(0);
      expect(
        (await a.outsider.get(`/v1/quotes?organizationId=${a.outsiderOrgId}&scope=RECEIVED`)).body.total,
      ).toBe(0);
      expect((await a.outsider.get('/v1/invoices?scope=RECEIVED')).body.total).toBe(0);
      const pay = await a.outsider.post(`/v1/invoices/${inv.body.id}/payments`, {
        amount: '100.00',
        method: 'WALLET_SIMULATED',
        organizationId: a.outsiderOrgId,
      });
      expect(pay.status).toBe(404);
    };
    await hidden();
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.outsiderUser.id, type: { in: ['invoice.sent', 'quote.sent'] } },
      }),
    ).toBe(0);
    // The issuer's view of the document does not leak the pending target either
    const issuerView = await a.owner.get(`/v1/invoices/${inv.body.id}`);
    expect(issuerView.body.counterparty.linkedOrganizationId).toBeNull();
    expect(JSON.stringify(issuerView.body)).not.toContain(a.outsiderOrgId);

    // Decline → still hidden, requester sees DECLINED, re-request blocked by the cooldown
    const declined = await a.outsider.post(
      `/v1/organizations/${a.outsiderOrgId}/link-requests/${cp.body.id}/decline`,
      { note: 'Je ne connais pas cette entreprise' },
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.status).toBe('DECLINED');
    await hidden();
    let mine = (await a.owner.get(`/v1/organizations/${a.businessOrgId}/counterparties`)).body[0];
    expect(mine.link.status).toBe('DECLINED');
    expect(mine.link.requestAgainAfter).toBeTruthy();
    expect(mine.link.nextActions).toEqual([]);
    const again = await a.outsider.post(
      `/v1/organizations/${a.outsiderOrgId}/link-requests/${cp.body.id}/accept`,
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LINK_NOT_PENDING');
    const tooSoon = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/request`,
    );
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('RATE_LIMITED');
    expect(tooSoon.body.details.retryAt).toBeTruthy();
    const revokeDeclined = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/revoke`,
    );
    expect(revokeDeclined.status).toBe(409);
    expect(revokeDeclined.body.code).toBe('LINK_NOT_PENDING');

    // After the cooldown the requester may ask again; the target then accepts
    await ctx.prisma.counterparty.update({
      where: { id: cp.body.id },
      data: { linkDecidedAt: new Date(Date.now() - 25 * 3_600_000) },
    });
    mine = (await a.owner.get(`/v1/organizations/${a.businessOrgId}/counterparties`)).body[0];
    expect(mine.link.nextActions).toEqual(['REQUEST_LINK']);
    const reRequest = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/request`,
    );
    expect(reRequest.status, JSON.stringify(reRequest.body)).toBe(200);
    expect(reRequest.body.link.status).toBe('REQUESTED');
    expect(reRequest.body.linkRequest).toBe('SENT_IF_ELIGIBLE');
    // A second request while one is in progress is a conflict
    expect(
      (await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/request`))
        .status,
    ).toBe(409);
    await ctx.app.get(CounterpartiesService).whenIdle();
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.outsiderUser.id, type: 'counterparty.link_requested' },
      }),
    ).toBe(2);
    const accepted = await a.outsider.post(
      `/v1/organizations/${a.outsiderOrgId}/link-requests/${cp.body.id}/accept`,
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.ownerUser.id, type: 'counterparty.link_accepted' },
      }),
    ).toBe(1);

    // ACCEPTED: visible, payable, notified
    const asCustomer = await a.outsider.get(`/v1/invoices/${inv.body.id}`);
    expect(asCustomer.status).toBe(200);
    expect(asCustomer.body.myRole).toBe('CUSTOMER');
    expect(asCustomer.body.nextActions).toEqual(['PAY_WALLET', 'VIEW_DOCUMENT']);
    expect((await a.outsider.get(`/v1/quotes/${quote.body.id}`)).status).toBe(200);
    expect(
      (await a.outsider.get(`/v1/invoices?organizationId=${a.outsiderOrgId}&scope=RECEIVED`)).body.total,
    ).toBe(1);
    mine = (await a.owner.get(`/v1/organizations/${a.businessOrgId}/counterparties`)).body[0];
    expect(mine.link.status).toBe('ACCEPTED');
    expect(mine.linkedOrganizationId).toBe(a.outsiderOrgId);
    expect(mine.link.linkedOrganization).toEqual({ id: a.outsiderOrgId, name: 'Jean Tremblay' });
    expect(mine.link.nextActions).toEqual(['REVOKE_LINK']);
    const paid = await a.outsider.post(`/v1/invoices/${inv.body.id}/payments`, {
      amount: '40.00',
      method: 'WALLET_SIMULATED',
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.status).toBe('PARTIALLY_PAID');
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.outsiderUser.id, type: 'invoice.payment_recorded' },
      }),
    ).toBe(1);

    // Revoke by the requester: the link is cleared and the customer loses access again
    const revoked = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/revoke`,
      { reason: 'Client parti' },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.link.status).toBe('REVOKED');
    expect(revoked.body.linkedOrganizationId).toBeNull();
    const row = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.body.id } });
    expect(row.linkStatus).toBe('REVOKED');
    expect(row.linkedOrganizationId).toBeNull();
    await hidden();
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.outsiderUser.id, type: 'counterparty.link_revoked' },
      }),
    ).toBe(1);
    expect(
      (await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/request`))
        .status,
    ).toBe(429);

    // Every step is audited
    const actions = (
      await ctx.prisma.auditLog.findMany({
        where: { entityId: cp.body.id, action: { startsWith: 'counterparty.' } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((x) => x.action);
    for (const action of [
      'counterparty.created',
      'counterparty.link_requested',
      'counterparty.link_declined',
      'counterparty.link_rerequested',
      'counterparty.link_accepted',
      'counterparty.link_revoked',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('supports an explicit link to another workspace of the caller, still subject to consent', async () => {
    const cp = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Mon espace personnel',
      linkedOrganizationId: a.personalOrgId,
    });
    expect(cp.status).toBe(201);
    expect(cp.body.linkedOrganizationId).toBeNull();
    expect(cp.body.link.status).toBe('REQUESTED');
    const accepted = await a.owner.post(
      `/v1/organizations/${a.personalOrgId}/link-requests/${cp.body.id}/accept`,
    );
    expect(accepted.status).toBe(200);
    const list = await a.owner.get(`/v1/organizations/${a.personalOrgId}/link-requests?status=ACCEPTED`);
    expect(list.body.items.map((i: any) => i.counterpartyId)).toEqual([cp.body.id]);
    // Withdrawing a request that matched no account behaves exactly like any other revocation
    const unknown = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Inconnu',
      email: 'ghost@example.com',
    });
    const withdrawn = await a.owner.post(
      `/v1/organizations/${a.businessOrgId}/counterparties/${unknown.body.id}/link/revoke`,
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.link.status).toBe('REVOKED');
    // The VIEWER cannot request / revoke links
    expect(
      (await a.viewer.post(`/v1/organizations/${a.businessOrgId}/counterparties/${cp.body.id}/link/revoke`))
        .status,
    ).toBe(403);
  });

  it('rate-limits link requests per organisation (every attempt counts, match or not)', async () => {
    const base = `/v1/organizations/${a.businessOrgId}/counterparties`;
    for (let i = 0; i < 20; i++) {
      const res = await a.owner.post(base, { name: `Prospect ${i}`, email: `prospect-${i}@example.com` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const unknown = await a.owner.post(base, { name: 'Prospect 21', email: 'prospect-21@example.com' });
    const matching = await a.owner.post(base, { name: 'Jean', email: 'wallet-outsider-lnk@example.com' });
    for (const res of [unknown, matching]) {
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(res.body.details.limit).toBe(20);
    }
    await ctx.app.get(CounterpartiesService).whenIdle();
    expect(await ctx.prisma.notification.count({ where: { type: 'counterparty.link_requested' } })).toBe(0);
    // Client records without a link request are not limited; other organisations are not affected
    expect((await a.owner.post(base, { name: 'Comptoir' })).status).toBe(201);
    expect(
      (
        await a.owner.post(`/v1/organizations/${a.personalOrgId}/counterparties`, {
          name: 'Jean',
          email: 'wallet-outsider-lnk@example.com',
        })
      ).status,
    ).toBe(201);
  });

  it('lets the target end a link, keeps a refusal across new client records, and asks consent for legacy links', async () => {
    const base = `/v1/organizations/${a.businessOrgId}/counterparties`;
    const target = `/v1/organizations/${a.outsiderOrgId}/link-requests`;
    const cp = await a.owner.post(base, { name: 'Jean', email: 'wallet-outsider-lnk@example.com' });
    expect((await a.outsider.post(`${target}/${cp.body.id}/accept`)).status).toBe(200);

    // The target withdraws its consent (server action REVOKE on accepted links).
    const accepted = await a.outsider.get(`${target}?status=ACCEPTED`);
    expect(accepted.body.items[0].nextActions).toEqual(['REVOKE']);
    const ended = await a.outsider.post(`${target}/${cp.body.id}/revoke`, { note: 'Plus client' });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ status: 'REVOKED', nextActions: [] });
    const row = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: cp.body.id } });
    expect(row).toMatchObject({ linkStatus: 'REVOKED', linkedOrganizationId: null });
    expect((await a.outsider.post(`${target}/${cp.body.id}/revoke`)).status).toBe(404);
    expect((await a.viewer.post(`${target}/${cp.body.id}/revoke`)).status).toBe(404);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.ownerUser.id, type: 'counterparty.link_revoked' },
      }),
    ).toBe(1);

    // A new client record with the same e-mail cannot reopen the decision during the cooldown:
    // same answer as for any e-mail, nothing sent to the target.
    const again = await a.owner.post(base, { name: 'Jean bis', email: 'wallet-outsider-lnk@example.com' });
    expect(again.status).toBe(201);
    expect(again.body.linkRequest).toBe('SENT_IF_ELIGIBLE');
    expect(await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: again.body.id } })).toMatchObject({
      linkStatus: 'NONE',
      linkRequestedOrganizationId: null,
    });
    await ctx.app.get(CounterpartiesService).whenIdle();
    expect(
      await ctx.prisma.notification.count({
        where: { userId: a.outsiderUser.id, type: 'counterparty.link_requested' },
      }),
    ).toBe(1);

    // Links made by e-mail matching before the consent workflow become requests to accept.
    const legacy = await ctx.prisma.counterparty.create({
      data: {
        organizationId: a.businessOrgId,
        name: 'Ancien client',
        email: 'wallet-outsider-lnk@example.com',
        linkStatus: 'ACCEPTED',
        linkedOrganizationId: a.outsiderOrgId,
        linkDecidedAt: new Date(),
      },
    });
    const consented = await ctx.prisma.counterparty.create({
      data: {
        organizationId: a.businessOrgId,
        name: 'Client consentant',
        linkStatus: 'ACCEPTED',
        linkedOrganizationId: a.outsiderOrgId,
        linkRequestedOrganizationId: a.outsiderOrgId,
        linkDecidedAt: new Date(),
        linkDecidedByUserId: a.outsiderUser.id,
      },
    });
    const sql = readFileSync(
      join(
        __dirname,
        '../../../packages/database/prisma/migrations/20261012040000_legacy_links_need_consent/migration.sql',
      ),
      'utf8',
    );
    await ctx.prisma.$executeRawUnsafe(sql);
    expect(await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
      linkStatus: 'PENDING',
      linkedOrganizationId: null,
      linkRequestedOrganizationId: a.outsiderOrgId,
      linkDecidedAt: null,
    });
    expect(
      (await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: consented.id } })).linkStatus,
    ).toBe('ACCEPTED');
    const pending = await a.outsider.get(`${target}?status=PENDING`);
    expect(pending.body.items.map((i: { counterpartyId: string }) => i.counterpartyId)).toContain(legacy.id);
  });
});

// ───────────────────────────── Persisted tax rate ───────────────────────────

describe('Tenancy — persisted tax rate', () => {
  let a: WalletActors;
  beforeEach(async () => {
    a = await createWalletActors(ctx, '-tax');
  });

  const taxOf = (subtotalMinor: bigint, bps: bigint) => (subtotalMinor * bps + 5_000n) / 10_000n;

  it('stores taxBps on invoices and keeps it exactly when lines are edited without it (1333 bps)', async () => {
    const created = await a.owner.post(
      '/v1/invoices',
      invoiceInput(a.businessOrgId, {
        taxBps: 1333,
        lines: [{ description: 'Petit forfait', quantity: 1, unitPrice: '1.00' }],
      }),
    );
    expect(created.status).toBe(201);
    // 1.00 × 13.33 % = 0.1333 → 0.13; deriving the rate back from those amounts would give 1300
    expect(created.body.tax.decimal).toBe('0.13');
    expect(created.body.taxBps).toBe(1333);
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: created.body.id } })).taxBps).toBe(
      1333,
    );

    const edited = await a.owner.patch(`/v1/invoices/${created.body.id}`, {
      lines: [{ description: 'Gros contrat', quantity: 3, unitPrice: '987654.32' }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.taxBps).toBe(1333);
    expect(edited.body.subtotal.minor).toBe('296296296');
    expect(edited.body.tax.minor).toBe(taxOf(296296296n, 1333n).toString());
    expect(edited.body.tax.minor).not.toBe(taxOf(296296296n, 1300n).toString());
    expect(edited.body.total.minor).toBe((296296296n + taxOf(296296296n, 1333n)).toString());

    // Back to a small amount, then a notes-only edit: the rate never drifts
    const small = await a.owner.patch(`/v1/invoices/${created.body.id}`, {
      lines: [{ description: 'x', quantity: 1, unitPrice: '0.75' }],
    });
    expect(small.body.taxBps).toBe(1333);
    expect(small.body.tax.minor).toBe(taxOf(75n, 1333n).toString());
    const notes = await a.owner.patch(`/v1/invoices/${created.body.id}`, { notes: 'Remarque' });
    expect(notes.body.taxBps).toBe(1333);
    expect(notes.body.tax.minor).toBe(small.body.tax.minor);
    // An explicit new rate replaces the stored one
    const changed = await a.owner.patch(`/v1/invoices/${created.body.id}`, { taxBps: 1800 });
    expect(changed.body.taxBps).toBe(1800);
    expect((await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: created.body.id } })).taxBps).toBe(
      1800,
    );
    const doc = await a.owner.get(`/v1/invoices/${created.body.id}/document`);
    expect(doc.body.totals.taxBps).toBe(1800);
  });

  it('stores taxBps on quotes, keeps it on edit and copies it to the converted invoice', async () => {
    const quote = await a.owner.post('/v1/quotes', {
      ...invoiceInput(a.businessOrgId, {
        taxBps: 1333,
        lines: [{ description: 'Petit devis', quantity: 1, unitPrice: '1.00' }],
      }),
      validUntil: inDays(10),
    });
    expect(quote.status).toBe(201);
    expect(quote.body.taxBps).toBe(1333);
    const edited = await a.owner.patch(`/v1/quotes/${quote.body.id}`, {
      lines: [{ description: 'Gros devis', quantity: 2, unitPrice: '5000000.01' }],
    });
    expect(edited.body.taxBps).toBe(1333);
    expect(edited.body.tax.minor).toBe(taxOf(1000000002n, 1333n).toString());
    await a.owner.post(`/v1/quotes/${quote.body.id}/send`);
    await a.owner.post(`/v1/quotes/${quote.body.id}/accept`);
    const converted = await a.owner.post(`/v1/quotes/${quote.body.id}/convert`, { target: 'INVOICE' });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.invoice.taxBps).toBe(1333);
    expect(converted.body.invoice.tax.minor).toBe(edited.body.tax.minor);
    const row = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: converted.body.invoice.id } });
    expect(row.taxBps).toBe(1333);
    // Editing the converted draft without a rate keeps the inherited one
    const invEdit = await a.owner.patch(`/v1/invoices/${row.id}`, {
      lines: [{ description: 'x', quantity: 1, unitPrice: '1.00' }],
    });
    expect(invEdit.body.taxBps).toBe(1333);
  });

  it('falls back to the derived rate for legacy rows only (taxBps = 0 with a tax amount)', async () => {
    const inv = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId, { taxBps: 1800 }));
    await ctx.prisma.invoice.update({ where: { id: inv.body.id }, data: { taxBps: 0 } });
    expect((await a.owner.get(`/v1/invoices/${inv.body.id}`)).body.taxBps).toBe(1800);
    const zero = await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId, { taxBps: 0 }));
    expect(zero.body.taxBps).toBe(0);
    expect(zero.body.tax.minor).toBe('0');
  });
});

// ───────────────────────────── Webhook egress allowlist ─────────────────────

describe('Tenancy — webhook egress allowlist', () => {
  it('matches exact hosts and *.suffix entries, in every environment', async () => {
    const list = 'hooks.partner.example, *.trusted.example';
    expect(isHostAllowed('hooks.partner.example', list)).toBe(true);
    expect(isHostAllowed('HOOKS.Partner.Example.', list)).toBe(true);
    expect(isHostAllowed('api.trusted.example', list)).toBe(true);
    expect(isHostAllowed('a.b.trusted.example', list)).toBe(true);
    expect(isHostAllowed('trusted.example', list)).toBe(false);
    expect(isHostAllowed('eviltrusted.example', list)).toBe(false);
    expect(isHostAllowed('partner.example', list)).toBe(false);
    expect(isHostAllowed('anything.example', undefined)).toBe(true);
    expect(isHostAllowed('anything.example', ' , ')).toBe(true);

    // Subscription-time check (NODE_ENV=test does not bypass the allowlist)
    expect(assertSafeWebhookUrl('https://hooks.partner.example/dfn', 'test', list).hostname).toBe(
      'hooks.partner.example',
    );
    expect(() => assertSafeWebhookUrl('https://evil.example/dfn', 'test', list)).toThrow(
      /allowed destinations/,
    );
    expect(() => assertSafeWebhookUrl('https://trusted.example/dfn', 'production', list)).toThrow(
      /allowed destinations/,
    );
    // Private-address logic is unchanged and not relaxed by the allowlist
    expect(() => assertSafeWebhookUrl('http://127.0.0.1:9/hook', 'production', '127.0.0.1')).toThrow(
      /public host/,
    );
    expect(assertSafeWebhookUrl('http://127.0.0.1:9/hook', 'test').hostname).toBe('127.0.0.1');

    // Dispatch-time check
    expect(await unsafeDestinationReason('https://evil.example/x', 'test', list)).toBe(
      'host evil.example is not in the webhook allowlist',
    );
    expect(await unsafeDestinationReason('https://api.trusted.example/x', 'test', list)).toBeNull();
    expect(await unsafeDestinationReason('http://127.0.0.1:9/x', 'test')).toBeNull();
    expect(await unsafeDestinationReason('https://10.0.0.1/x', 'production', '10.0.0.1')).toBe(
      'private host 10.0.0.1',
    );
  });

  it('refuses subscriptions (create and update) towards hosts outside WEBHOOK_ALLOWED_HOSTS', async () => {
    const env = ctx.app.get<Env>(ENV);
    const previous = env.WEBHOOK_ALLOWED_HOSTS;
    env.WEBHOOK_ALLOWED_HOSTS = 'hooks.partner.example,*.trusted.example';
    try {
      const { client } = await registerUser(ctx, 'webhook-ten@example.com');
      const events = ['transaction.created'];
      const ok = await client.post('/v1/webhooks', { url: 'https://hooks.partner.example/dfn', events });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const sub = await client.post('/v1/webhooks', { url: 'https://erp.trusted.example/dfn', events });
      expect(sub.status).toBe(201);
      for (const url of ['https://evil.example/dfn', 'https://trusted.example/dfn']) {
        const refused = await client.post('/v1/webhooks', { url, events });
        expect(refused.status).toBe(422);
        expect(refused.body.code).toBe('WEBHOOK_URL_FORBIDDEN');
      }
      const moved = await client.patch(`/v1/webhooks/${ok.body.webhook.id}`, {
        url: 'https://evil.example/x',
      });
      expect(moved.status).toBe(422);
      expect(moved.body.code).toBe('WEBHOOK_URL_FORBIDDEN');
      const allowedMove = await client.patch(`/v1/webhooks/${ok.body.webhook.id}`, {
        url: 'https://hooks2.trusted.example/x',
      });
      expect(allowedMove.status, JSON.stringify(allowedMove.body)).toBe(200);
    } finally {
      env.WEBHOOK_ALLOWED_HOSTS = previous;
    }
  });
});
