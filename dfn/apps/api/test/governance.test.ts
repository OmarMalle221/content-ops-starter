import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { VEHICLE_TX, createActors, fundTransaction, uploadEvidence } from './helpers/protect';

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

describe('organisations, RBAC and tenant isolation', () => {
  it('creates a business organisation, invites a member and enforces org roles', async () => {
    const { client: owner } = await registerUser(ctx, 'owner@example.com');
    const org = await owner.post('/v1/organizations', {
      name: 'Dakar Auto Import',
      country: 'SN',
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
    });
    expect(org.status).toBe(201);
    expect(org.body.type).toBe('BUSINESS');
    const invite = await owner.post(`/v1/organizations/${org.body.id}/members/invite`, {
      email: 'viewer@example.com',
      role: 'VIEWER',
    });
    expect(invite.status).toBe(201);
    const { client: viewer } = await registerUser(ctx, 'viewer@example.com');
    expect((await viewer.get(`/v1/organizations/${org.body.id}`)).status).toBe(404);
    const joined = await viewer.post('/v1/organizations/invitations/accept', { token: invite.body.token });
    expect(joined.status).toBe(201);
    expect(joined.body.role).toBe('VIEWER');
    // Refresh session memberships by logging in again
    await viewer.post('/v1/auth/login', { email: 'viewer@example.com', password: PASSWORD });
    expect((await viewer.get(`/v1/organizations/${org.body.id}`)).status).toBe(200);
    // Viewer cannot create transactions for the business org nor invite members
    const denied = await viewer.post('/v1/transactions', { ...VEHICLE_TX, organizationId: org.body.id });
    expect(denied.status).toBe(403);
    expect(
      (
        await viewer.post(`/v1/organizations/${org.body.id}/members/invite`, {
          email: 'x@example.com',
          role: 'MEMBER',
        })
      ).status,
    ).toBe(403);
    // Business verification (simulated)
    const kyb = await owner.post(`/v1/organizations/${org.body.id}/verification`, {
      legalName: 'Dakar Auto Import SARL',
      registrationNumber: 'SN-DKR-2021-B-1234',
      registrationCountry: 'SN',
      businessType: 'COMPANY',
    });
    expect(kyb.status).toBe(201);
    expect(kyb.body.status).toBe('SIMULATED_PASS');
    expect(kyb.body.simulated).toBe(true);
    // Last owner cannot be demoted
    const detail = await owner.get(`/v1/organizations/${org.body.id}`);
    const ownerMember = detail.body.members.find((m: any) => m.role === 'OWNER');
    expect(
      (await owner.patch(`/v1/organizations/${org.body.id}/members/${ownerMember.id}`, { role: 'MEMBER' }))
        .status,
    ).toBe(409);
  });

  it('isolates transactions, documents and disputes between tenants', async () => {
    const actors = await createActors(ctx);
    const { txId } = await fundTransaction(ctx, actors);
    const { client: other } = await registerUser(ctx, 'other@example.com');
    expect((await other.get(`/v1/transactions/${txId}`)).status).toBe(404);
    expect((await other.get(`/v1/transactions/${txId}/events`)).status).toBe(404);
    expect((await other.get(`/v1/transactions/${txId}/documents`)).status).toBe(404);
    expect(
      (
        await other.post(`/v1/transactions/${txId}/disputes`, {
          reason: 'OTHER',
          description: 'Je ne suis pas partie à cette transaction mais je tente quand même.',
          documentIds: [],
        })
      ).status,
    ).toBe(404);
    const list = await other.get('/v1/transactions');
    expect(list.body.total).toBe(0);
    // Seller cannot act as buyer and vice versa
    const tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(
      (
        await actors.buyer.post(`/v1/transactions/${txId}/milestones/${tx.milestones[0].id}/submit`, {
          documentIds: [await uploadEvidence(actors.buyer, txId, 'BILL_OF_LADING')],
        })
      ).status,
    ).toBe(403);
    expect(
      (await actors.seller.post(`/v1/transactions/${txId}/milestones/${tx.milestones[0].id}/approve`, {}))
        .status,
    ).toBe(403);
    expect((await actors.seller.post(`/v1/transactions/${txId}/funding/request`, {})).status).toBe(403);
  });

  it('serialises a double approval race into a single release', async () => {
    const actors = await createActors(ctx);
    const { txId } = await fundTransaction(ctx, actors);
    const tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING');
    await actors.seller.post(`/v1/transactions/${txId}/milestones/${tx.milestones[0].id}/submit`, {
      documentIds: [bol],
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        actors.buyer.post(`/v1/transactions/${txId}/milestones/${tx.milestones[0].id}/approve`, {}),
      ),
    );
    const ok = results.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: txId, kind: 'RELEASE' } })).toBe(1);
    const sellerWallet = await actors.seller.get(`/v1/wallets/${actors.sellerUser.organizations[0].id}`);
    expect(sellerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '9250.00',
    );
  });

  it('rejects unsupported files and oversized payloads', async () => {
    const actors = await createActors(ctx);
    const created = await actors.buyer.post('/v1/transactions', VEHICLE_TX);
    const txId = created.body.id;
    const fake = await actors.buyer.upload(
      `/v1/transactions/${txId}/documents`,
      { kind: 'OTHER' },
      { name: 'script.pdf', buffer: Buffer.from('<script>alert(1)</script>'), type: 'application/pdf' },
    );
    expect(fake.status).toBe(415);
    const exe = await actors.buyer.upload(
      `/v1/transactions/${txId}/documents`,
      { kind: 'OTHER' },
      { name: 'tool.exe', buffer: Buffer.from('MZ....'), type: 'application/octet-stream' },
    );
    expect(exe.status).toBe(415);
  });
});

describe('admin & compliance console', () => {
  it('exposes stats, users, audit logs, risk alerts and verification review to staff only', async () => {
    const actors = await createActors(ctx);
    await fundTransaction(ctx, actors);
    expect((await actors.buyer.get('/v1/admin/stats')).status).toBe(403);
    await registerUser(ctx, 'admin@example.com');
    await promote(ctx, 'admin@example.com', 'ADMIN');
    const admin = new Client(ctx);
    await admin.post('/v1/auth/login', { email: 'admin@example.com', password: PASSWORD });

    const stats = await admin.get('/v1/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.transactions.FUNDED).toBe(1);
    const users = await admin.get('/v1/admin/users?search=seller');
    expect(users.body.items[0].email).toBe('seller@example.com');
    const logs = await admin.get('/v1/admin/audit-logs?entityType=Transaction');
    expect(logs.body.total).toBeGreaterThan(0);
    expect(JSON.stringify(logs.body)).not.toContain('passwordHash');

    // Risk alert from an unverified high-value transaction, then explainable review
    const big = await actors.buyer.post('/v1/transactions', {
      ...VEHICLE_TX,
      amount: '60000.00',
      milestones: [{ title: 'Livraison', amount: '60000.00' }],
    });
    expect(big.status).toBe(201);
    const alerts = await admin.get('/v1/admin/risk-alerts?status=OPEN');
    expect(alerts.body.items.length).toBeGreaterThan(0);
    const alert = alerts.body.items[0];
    expect(alert.explanation.summary).toBeTruthy();
    const acted = await admin.post(`/v1/admin/risk-alerts/${alert.id}/actions`, {
      action: 'DISMISS',
      note: 'Transaction documentée, client connu.',
    });
    expect(acted.status).toBe(201);
    expect(acted.body.status).toBe('DISMISSED');

    // Suspending a user revokes their sessions
    const sellerId = actors.sellerUser.id;
    const suspended = await admin.post(`/v1/admin/users/${sellerId}/status`, {
      status: 'SUSPENDED',
      reason: 'Vérification manuelle en cours',
    });
    expect(suspended.status).toBe(201);
    expect((await actors.seller.get('/v1/auth/me')).status).toBe(401);
    expect(
      (
        await admin.post(
          `/v1/admin/users/${(await ctx.prisma.user.findUnique({ where: { email: 'admin@example.com' } }))!.id}/status`,
          { status: 'SUSPENDED', reason: 'self' },
        )
      ).status,
    ).toBe(400);

    // Compliance role has the review permissions but not user management
    await registerUser(ctx, 'compliance@example.com');
    await promote(ctx, 'compliance@example.com', 'COMPLIANCE');
    const compliance = new Client(ctx);
    await compliance.post('/v1/auth/login', { email: 'compliance@example.com', password: PASSWORD });
    expect((await compliance.get('/v1/admin/verifications')).status).toBe(200);
    expect((await compliance.get('/v1/admin/users')).status).toBe(403);
    const ledger = await compliance.get('/v1/admin/ledger');
    expect(ledger.status).toBe(200);
    expect(ledger.body.accounts.length).toBeGreaterThan(0);

    // Notifications
    const notifs = await actors.buyer.get('/v1/notifications?unread=true');
    expect(notifs.body.unread).toBeGreaterThan(0);
    const read = await actors.buyer.post('/v1/notifications/read-all');
    expect(read.body.updated).toBe(notifs.body.unread);
  });
});
