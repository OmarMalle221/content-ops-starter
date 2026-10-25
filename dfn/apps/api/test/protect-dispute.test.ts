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
import { createActors, fundTransaction, uploadEvidence } from './helpers/protect';

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

async function staff(ctx: TestContext, email = 'compliance@example.com') {
  await registerUser(ctx, email, { firstName: 'Fatou', lastName: 'Sow' });
  await promote(ctx, email, 'COMPLIANCE');
  const c = new Client(ctx);
  await c.post('/v1/auth/login', { email, password: PASSWORD });
  return c;
}

describe('Scenario 2 — dispute freezes releases', () => {
  it('opens a dispute, blocks releases, and executes a reasoned SPLIT decision through the ledger', async () => {
    const actors = await createActors(ctx);
    const { txId } = await fundTransaction(ctx, actors);
    let tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    const [m1, m2] = tx.milestones;

    // Seller submits milestone 1, then the buyer opens a dispute (goods not as described)
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING');
    expect(
      (
        await actors.seller.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, {
          documentIds: [bol],
        })
      ).status,
    ).toBe(200);
    const photo = await uploadEvidence(actors.buyer, txId, 'PHOTO', 'damage.png');
    const opened = await actors.buyer.post(`/v1/transactions/${txId}/disputes`, {
      reason: 'NOT_AS_DESCRIBED',
      description:
        'Le véhicule présenté sur le connaissement ne correspond pas au numéro de châssis convenu dans le contrat.',
      documentIds: [photo],
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body.status).toBe('OPEN');
    expect(opened.body.evidences).toHaveLength(1);
    // Evidence carries the antivirus verdict and a download link (never one for an INFECTED file).
    expect(opened.body.evidences[0].document).toMatchObject({
      id: photo,
      scan: { status: 'CLEAN', engine: 'sandbox-eicar' },
      downloadUrl: `/v1/documents/${photo}/download`,
    });
    const disputeId = opened.body.id;

    tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx.status).toBe('DISPUTED');
    expect(tx.releaseFrozen).toBe(true);
    expect(tx.nextActions).not.toContain('APPROVE_MILESTONE');
    expect(tx.nextActions).toContain('VIEW_DISPUTE');

    // Release is frozen: approval is refused and the ledger is untouched
    const frozen = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m1.id}/approve`, {});
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('RELEASE_FROZEN');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { reference: txId, kind: 'RELEASE' } })).toBe(0);
    // A second dispute cannot be opened
    expect(
      (
        await actors.seller.post(`/v1/transactions/${txId}/disputes`, {
          reason: 'OTHER',
          description: 'Une deuxième contestation ne doit pas être possible ici.',
          documentIds: [],
        })
      ).status,
    ).toBe(409);

    // Parties exchange messages and evidence; staff takes the review
    const sellerMsg = await actors.seller.post(`/v1/disputes/${disputeId}/messages`, {
      body: "Le châssis correspond, voici le rapport d'inspection.",
      documentId: bol,
    });
    expect(sellerMsg.status).toBe(201);
    expect(
      (await actors.seller.post(`/v1/disputes/${disputeId}/messages`, { body: 'note', internal: true }))
        .status,
    ).toBe(403);
    expect((await actors.buyer.post(`/v1/disputes/${disputeId}/review`)).status).toBe(403);

    const compliance = await staff(ctx);
    const review = await compliance.post(`/v1/disputes/${disputeId}/review`);
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('UNDER_REVIEW');
    await compliance.post(`/v1/disputes/${disputeId}/messages`, {
      body: 'Note interne: demander la photo du châssis.',
      internal: true,
    });
    const partyView = await actors.buyer.get(`/v1/disputes/${disputeId}`);
    expect(partyView.body.messages.some((m: any) => m.internal)).toBe(false);
    const staffView = await compliance.get(`/v1/disputes/${disputeId}`);
    expect(staffView.body.messages.some((m: any) => m.internal)).toBe(true);

    // Non-final decision opens an appeal window; the seller appeals
    const first = await compliance.post(`/v1/disputes/${disputeId}/decide`, {
      outcome: 'REFUND_TO_BUYER',
      rationale: "Les preuves fournies ne permettent pas d'établir la conformité du véhicule livré.",
      isFinal: false,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.status).toBe('DECIDED');
    expect(first.body.appealDeadline).toBeTruthy();
    expect(first.body.decisions[0].executedAt).toBeNull();
    tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx.status).toBe('DISPUTED');
    expect(tx.escrowBalance.decimal).toBe('18500.00');

    const appeal = await actors.seller.post(`/v1/disputes/${disputeId}/appeal`, {
      grounds: "Le rapport d'inspection indépendant joint confirme la conformité du châssis livré.",
    });
    expect(appeal.status).toBe(200);
    expect(appeal.body.status).toBe('APPEALED');

    // Final SPLIT decision must match the remaining escrow exactly
    const badSplit = await compliance.post(`/v1/disputes/${disputeId}/decide`, {
      outcome: 'SPLIT',
      rationale: 'Partage des responsabilités entre les deux parties.',
      sellerAmount: '1.00',
      buyerAmount: '1.00',
    });
    expect(badSplit.status).toBe(400);
    const final = await compliance.post(`/v1/disputes/${disputeId}/decide`, {
      outcome: 'SPLIT',
      rationale:
        'Conformité partielle : le vendeur a livré mais avec un retard et des dommages documentés. Partage 60/40.',
      sellerAmount: '11100.00',
      buyerAmount: '7400.00',
    });
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    expect(final.body.status).toBe('CLOSED');
    expect(final.body.decisions[1].isFinal).toBe(true);
    expect(final.body.decisions[1].executedAt).toBeTruthy();

    // Ledger: escrow emptied into seller and buyer wallets; transaction settled; releases unfrozen
    tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx.status).toBe('SETTLED');
    expect(tx.releaseFrozen).toBe(false);
    expect(tx.escrowBalance.decimal).toBe('0.00');
    expect(tx.milestones.every((m: any) => ['RELEASED', 'REFUNDED'].includes(m.status))).toBe(true);
    const sellerWallet = await actors.seller.get(`/v1/wallets/${actors.sellerUser.organizations[0].id}`);
    expect(sellerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '11100.00',
    );
    const buyerWallet = await actors.buyer.get(`/v1/wallets/${actors.buyerUser.organizations[0].id}`);
    expect(buyerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '7400.00',
    );
    const kinds = (await ctx.prisma.ledgerTransaction.findMany({ where: { reference: txId } }))
      .map((t) => t.kind)
      .sort();
    expect(kinds).toEqual(['FUNDING', 'REFUND', 'RELEASE']);

    const events = (await actors.buyer.get(`/v1/transactions/${txId}/events`)).body.map((e: any) => e.type);
    for (const t of [
      'dispute.opened',
      'release.frozen',
      'dispute.under_review',
      'dispute.decided',
      'dispute.appealed',
      'release.unfrozen',
      'dispute.closed',
      'transaction.settled',
    ]) {
      expect(events, `missing ${t}`).toContain(t);
    }
    const alerts = await compliance.get('/v1/admin/risk-alerts');
    expect(alerts.status).toBe(200);
    expect(Array.isArray(alerts.body.rules)).toBe(true);
    void m2;
  });

  it('REFUND_TO_BUYER final decision refunds the escrow and marks the transaction REFUNDED', async () => {
    const actors = await createActors(ctx, '2');
    const { txId } = await fundTransaction(ctx, actors, {
      ...(await import('./helpers/protect')).VEHICLE_TX,
      seller: { email: 'seller2@example.com' },
    });
    const opened = await actors.buyer.post(`/v1/transactions/${txId}/refund-request`, {
      reason: "Le vendeur ne répond plus depuis trois semaines et aucun embarquement n'a eu lieu.",
    });
    expect(opened.status).toBe(201);
    const compliance = await staff(ctx, 'compliance2@example.com');
    await compliance.post(`/v1/disputes/${opened.body.id}/review`);
    const decided = await compliance.post(`/v1/disputes/${opened.body.id}/decide`, {
      outcome: 'REFUND_TO_BUYER',
      rationale: 'Absence totale de preuve de livraison après le délai contractuel de 60 jours.',
      isFinal: true,
    });
    expect(decided.status).toBe(200);
    const tx = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx.status).toBe('REFUNDED');
    expect(tx.refundedTotal.decimal).toBe('18500.00');
    expect(tx.escrowBalance.decimal).toBe('0.00');
    const buyerWallet = await actors.buyer.get(`/v1/wallets/${actors.buyerUser.organizations[0].id}`);
    expect(buyerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '18500.00',
    );
  });

  it('DISMISSED decision unfreezes releases and lets the buyer approve again', async () => {
    const actors = await createActors(ctx, '3');
    const { txId } = await fundTransaction(ctx, actors, {
      ...(await import('./helpers/protect')).VEHICLE_TX,
      seller: { email: 'seller3@example.com' },
    });
    const tx0 = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING');
    await actors.seller.post(`/v1/transactions/${txId}/milestones/${tx0.milestones[0].id}/submit`, {
      documentIds: [bol],
    });
    const opened = await actors.seller.post(`/v1/transactions/${txId}/disputes`, {
      reason: 'PAYMENT_ISSUE',
      description: "L'acheteur refuse de valider un jalon pourtant documenté conformément au contrat.",
      documentIds: [],
    });
    expect(opened.status).toBe(201);
    const compliance = await staff(ctx, 'compliance3@example.com');
    await compliance.post(`/v1/disputes/${opened.body.id}/review`);
    const dismissed = await compliance.post(`/v1/disputes/${opened.body.id}/decide`, {
      outcome: 'DISMISSED',
      rationale: 'Les parties ont trouvé un accord amiable, aucune intervention nécessaire.',
      isFinal: true,
    });
    expect(dismissed.body.status).toBe('CLOSED');
    const tx1 = (await actors.buyer.get(`/v1/transactions/${txId}`)).body;
    expect(tx1.status).toBe('IN_PROGRESS');
    expect(tx1.releaseFrozen).toBe(false);
    const approved = await actors.buyer.post(
      `/v1/transactions/${txId}/milestones/${tx0.milestones[0].id}/approve`,
      {},
    );
    expect(approved.status).toBe(200);
    expect(approved.body.milestones[0].status).toBe('RELEASED');
  });
});
