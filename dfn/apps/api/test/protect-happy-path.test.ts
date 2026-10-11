import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { bootTestApp, resetDatabase, type TestContext } from './helpers/app';
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

describe('Scenario 1 — Diaspora Protect end-to-end (sandbox)', () => {
  it('creates buyer & seller, runs the full workflow and closes the transaction with balanced ledger entries', async () => {
    const actors = await createActors(ctx);

    // 3–4. Buyer creates the transaction and invites the seller
    const created = await actors.buyer.post('/v1/transactions', VEHICLE_TX);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING_ACCEPTANCE');
    expect(created.body.reference).toMatch(/^DFN-\d{4}-[A-Z0-9]{6}$/);
    expect(created.body.amount.decimal).toBe('18500.00');
    expect(created.body.fee.decimal).toBe('277.50'); // 1.5 %
    expect(created.body.totalToFund.decimal).toBe('18777.50');
    expect(created.body.contract.currentVersion.contentHash).toHaveLength(64);
    expect(created.body.contract.currentVersion.bodyText).toContain('Données fictives');
    expect(created.body.nextActions).toContain('RESEND_INVITATION');
    const txId = created.body.id;

    // The seller sees the invitation publicly (masked email) before signing in
    const invitation = await ctx.http().get(`/v1/invitations/${created.body.invitation.token}`);
    expect(invitation.status).toBe(200);
    expect(invitation.body.invitedEmail).toMatch(/^se\*\*\*@/);
    expect(invitation.body.requiresRegistration).toBe(false);

    // A stranger cannot see the transaction (404, not 403)
    const { client: stranger } = await (
      await import('./helpers/app')
    ).registerUser(ctx, 'stranger@example.com');
    expect((await stranger.get(`/v1/transactions/${txId}`)).status).toBe(404);
    expect(
      (await stranger.post('/v1/invitations/accept', { token: created.body.invitation.token })).status,
    ).toBe(403);

    // 5–9. Acceptance, terms, verification, funding, partner confirmation
    const { fundingReference } = await fundTransaction(ctx, actors, VEHICLE_TX, {
      txId,
      token: created.body.invitation.token,
    });

    // Replaying the partner confirmation must not double-fund the escrow
    const replay = await actors.buyer.post('/v1/sandbox/partner/funding-events', {
      fundingReference,
      outcome: 'CONFIRMED',
    });
    expect(replay.body.replayed).toBe(true);
    let tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx.escrowBalance.decimal).toBe('18500.00');

    // Seller cannot approve, buyer cannot submit
    const m1 = tx.milestones[0];
    const m2 = tx.milestones[1];
    expect(
      (await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, { documentIds: [] }))
        .status,
    ).toBe(400);

    // 10. Seller uploads proofs and submits milestone 1; missing evidence kind is rejected
    const wrongKind = await uploadEvidence(actors.seller, txId, 'PHOTO', 'photo.png');
    const missing = await actors.seller.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, {
      documentIds: [wrongKind],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.details.missing).toEqual(['BILL_OF_LADING']);
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING', 'bol.pdf');
    const submitted = await actors.seller.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, {
      documentIds: [bol, wrongKind],
      note: 'Navire MSC parti du port de Montréal',
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('IN_PROGRESS');
    expect(submitted.body.milestones[0].status).toBe('SUBMITTED');
    expect(submitted.body.milestones[0].evidences).toHaveLength(2);

    // Buyer asks for changes, seller resubmits, buyer approves → simulated release
    const changes = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m1.id}/request-changes`, {
      note: 'Le connaissement est illisible, merci de renvoyer.',
    });
    expect(changes.body.milestones[0].status).toBe('CHANGES_REQUESTED');
    const bol2 = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING', 'bol-v2.pdf');
    expect(
      (
        await actors.seller.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, {
          documentIds: [bol2],
        })
      ).status,
    ).toBe(200);
    const approved1 = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m1.id}/approve`, {
      note: 'OK',
    });
    expect(approved1.status, JSON.stringify(approved1.body)).toBe(200);
    expect(approved1.body.milestones[0].status).toBe('RELEASED');
    expect(approved1.body.escrowBalance.decimal).toBe('9250.00');
    expect(approved1.body.status).toBe('IN_PROGRESS');

    // Seller wallet reflects the release, derived from the ledger
    const sellerOrgId = actors.sellerUser.organizations[0].id;
    const wallet = await actors.seller.get(`/v1/wallets/${sellerOrgId}`);
    expect(wallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe('9250.00');
    // Buyer cannot read the seller wallet
    expect((await actors.buyer.get(`/v1/wallets/${sellerOrgId}`)).status).toBe(404);

    // Milestone 2
    const pos = await uploadEvidence(actors.seller, txId, 'PROOF_OF_SHIPMENT', 'delivery.pdf');
    expect(
      (
        await actors.seller.post(`/v1/transactions/${txId}/milestones/${m2.id}/submit`, {
          documentIds: [pos],
        })
      ).status,
    ).toBe(200);
    const approved2 = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m2.id}/approve`, {});
    expect(approved2.status).toBe(200);

    // 12. Transaction closed
    tx = approved2.body;
    expect(tx.status).toBe('SETTLED');
    expect(tx.settledAt).toBeTruthy();
    expect(tx.escrowBalance.decimal).toBe('0.00');
    expect(tx.releasedTotal.decimal).toBe('18500.00');
    expect(tx.nextActions).toEqual([]);

    // 11. Ledger entries: balanced, idempotent, fully traceable
    const ledgerTxs = await ctx.prisma.ledgerTransaction.findMany({
      where: { reference: txId },
      include: { entries: true },
    });
    expect(ledgerTxs.map((t) => t.kind).sort()).toEqual(['FUNDING', 'RELEASE', 'RELEASE']);
    for (const lt of ledgerTxs) {
      const debits = lt.entries
        .filter((e) => e.direction === 'DEBIT')
        .reduce((a, e) => a + e.amountMinor, 0n);
      const credits = lt.entries
        .filter((e) => e.direction === 'CREDIT')
        .reduce((a, e) => a + e.amountMinor, 0n);
      expect(debits).toBe(credits);
    }
    const fees = await ctx.prisma.ledgerAccount.findUnique({ where: { code: 'PLATFORM_FEES:CAD' } });
    const feeEntries = await ctx.prisma.ledgerEntry.aggregate({
      where: { accountId: fees!.id },
      _sum: { amountMinor: true },
    });
    expect(feeEntries._sum.amountMinor).toBe(27750n);
    const finalWallet = await actors.seller.get(`/v1/wallets/${sellerOrgId}`);
    expect(finalWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '18500.00',
    );
    const statement = await actors.seller.get(`/v1/wallets/${sellerOrgId}/CAD/statement.csv`);
    expect(statement.status).toBe(200);
    expect(statement.text).toContain('Aucun fonds réel');

    // History & notifications
    const events = await actors.seller.get(`/v1/transactions/${txId}/events`);
    const types = events.body.map((e: any) => e.type);
    for (const t of [
      'transaction.created',
      'contract.generated',
      'transaction.party_invited',
      'transaction.party_accepted',
      'contract.accepted',
      'funding.requested',
      'funding.confirmed',
      'milestone.submitted',
      'milestone.changes_requested',
      'milestone.approved',
      'milestone.released',
      'transaction.settled',
    ]) {
      expect(types, `missing event ${t}`).toContain(t);
    }
    const notifications = await actors.seller.get('/v1/notifications');
    expect(notifications.body.total).toBeGreaterThan(3);
    expect(notifications.body.items.some((n: any) => n.type === 'milestone.released')).toBe(true);
    const audits = await ctx.prisma.auditLog.count({ where: { entityType: 'Transaction', entityId: txId } });
    expect(audits).toBeGreaterThan(0);

    // Documents are encrypted at rest and downloadable by parties only
    const docs = await actors.buyer.get(`/v1/transactions/${txId}/documents`);
    expect(docs.body.length).toBe(4);
    const download = await actors.buyer.get(`/v1/documents/${bol2}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect((await stranger.get(`/v1/documents/${bol2}/download`)).status).toBe(404);
    const stored = await ctx.prisma.document.findUnique({ where: { id: bol2 } });
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(`${process.env.STORAGE_DIR}/${stored!.storageKey}`);
    expect(raw.subarray(28).toString('latin1')).not.toContain('%PDF');

    // Reconciliation is clean
    await (await import('./helpers/app')).promote(ctx, 'buyer@example.com', 'ADMIN');
    const admin = actors.buyer;
    await admin.post('/v1/auth/logout');
    await admin.post('/v1/auth/login', {
      email: 'buyer@example.com',
      password: (await import('./helpers/app')).PASSWORD,
    });
    const recon = await admin.post('/v1/admin/ledger/reconcile');
    expect(recon.status).toBe(200);
    expect(recon.body.differences).toEqual([]);
    expect(recon.body.unbalancedTransactions).toEqual([]);
    expect(recon.body.globalDebitsMinor.CAD).toBe(recon.body.globalCreditsMinor.CAD);
  });

  it('rejects inconsistent milestone sums and self-invitations', async () => {
    const actors = await createActors(ctx);
    const bad = await actors.buyer.post('/v1/transactions', {
      ...VEHICLE_TX,
      milestones: [{ title: 'x', amount: '100.00' }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const self = await actors.buyer.post('/v1/transactions', {
      ...VEHICLE_TX,
      seller: { email: 'buyer@example.com' },
    });
    expect(self.status).toBe(400);
  });

  it('blocks funding until both identities are (sandbox) verified and the contract is accepted', async () => {
    const actors = await createActors(ctx);
    const created = await actors.buyer.post('/v1/transactions', VEHICLE_TX);
    const txId = created.body.id;
    const tooEarly = await actors.buyer.post(`/v1/transactions/${txId}/funding/request`, {
      method: 'BANK_TRANSFER_SIMULATED',
    });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.code).toBe('VERIFICATION_REQUIRED');
    expect(tooEarly.body.details.reasons).toContain('SELLER_NOT_ACCEPTED');
    expect(tooEarly.body.details.reasons).toContain('BUYER_IDENTITY_NOT_VERIFIED');
    // Simulated failure path exists and is explicit
    const failed = await actors.buyer.post('/v1/verifications/identity', {
      documentType: 'PASSPORT',
      issuingCountry: 'CA',
      sandboxOutcome: 'FAIL',
    });
    expect(failed.body.status).toBe('SIMULATED_FAIL');
  });

  it('lets a seller decline and cancels the transaction', async () => {
    const actors = await createActors(ctx);
    const created = await actors.buyer.post('/v1/transactions', VEHICLE_TX);
    const declined = await actors.seller.post('/v1/invitations/decline', {
      token: created.body.invitation.token,
    });
    expect(declined.status).toBe(200);
    const tx = await actors.buyer.get(`/v1/transactions/${created.body.id}`);
    expect(tx.body.status).toBe('CANCELLED');
    expect(tx.body.seller.status).toBe('DECLINED');
  });
});
