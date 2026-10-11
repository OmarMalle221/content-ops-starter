import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceService } from '../src/modules/jobs/maintenance.service';
import { ReferenceDataService } from '../src/modules/reference/reference-data.service';
import { Client, bootTestApp, registerUser, resetDatabase, type TestContext } from './helpers/app';
import { createActors, fundTransaction, uploadEvidence } from './helpers/protect';
import { createWalletActors, selfDeposit, type WalletActors } from './helpers/wallet';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function invoiceInput(organizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    customerName: 'Boutique Teranga',
    customerEmail: 'client@example.com',
    currencyCode: 'CAD',
    dueDate: inDays(30),
    taxBps: 1800,
    lines: [
      { description: 'Conseil export — forfait', quantity: 2, unitPrice: '125.50' },
      { description: 'Frais de dossier', quantity: 1, unitPrice: '49.99' },
    ],
    notes: 'Paiement à 30 jours.',
    ...overrides,
  };
}

async function createInvoice(
  client: Client,
  organizationId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await client.post('/v1/invoices', invoiceInput(organizationId, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('Diaspora Business — invoices', () => {
  let a: WalletActors;
  beforeEach(async () => {
    a = await createWalletActors(ctx, '-biz');
  });

  it('numbers invoices per organisation and computes integer totals with half-up tax rounding', async () => {
    const first = await createInvoice(a.owner, a.businessOrgId);
    const year = new Date().getUTCFullYear();
    expect(first.number).toBe(`INV-${year}-0001`);
    expect(first.status).toBe('DRAFT');
    expect(first.sandbox).toBe(true);
    expect(first.disclaimer).toBe('Données fictives — Aucun fonds réel');
    // 2 × 125.50 + 49.99 = 300.99 ; tax 18 % = 54.1782 → 54.18 (half-up) ; total 355.17
    expect(first.lines).toHaveLength(2);
    expect(first.lines[0].total.decimal).toBe('251.00');
    expect(first.subtotal.decimal).toBe('300.99');
    expect(first.tax.decimal).toBe('54.18');
    expect(first.total.decimal).toBe('355.17');
    expect(first.taxBps).toBe(1800);
    expect(first.balanceDue.decimal).toBe('355.17');
    expect(first.nextActions).toEqual(expect.arrayContaining(['EDIT', 'SEND', 'CANCEL', 'VIEW_DOCUMENT']));

    const second = await createInvoice(a.owner, a.businessOrgId);
    expect(second.number).toBe(`INV-${year}-0002`);
    // Another organisation starts its own sequence
    const personal = await createInvoice(a.owner, a.personalOrgId);
    expect(personal.number).toBe(`INV-${year}-0001`);
    expect(personal.organizationId).toBe(a.personalOrgId);

    // Half-up rounding on a .5 case: 1.00 × 1 at 5 bps → 0.0005 → 0.01? no: 0.05 % of 1.00 = 0.0005 → rounds to 0.00;
    // 10.00 at 25 bps → 0.025 → 0.03 (half-up)
    const rounding = await createInvoice(a.owner, a.businessOrgId, {
      taxBps: 25,
      lines: [{ description: 'x', quantity: 1, unitPrice: '10.00' }],
    });
    expect(rounding.tax.decimal).toBe('0.03');
    expect(rounding.total.decimal).toBe('10.03');

    // Zero-decimal currency (XOF)
    const xof = await createInvoice(a.owner, a.businessOrgId, {
      currencyCode: 'XOF',
      taxBps: 1800,
      lines: [{ description: 'Transport', quantity: 3, unitPrice: '15000' }],
    });
    expect(xof.subtotal.decimal).toBe('45000');
    expect(xof.tax.decimal).toBe('8100');
    expect(xof.total.decimal).toBe('53100');
    // Invalid decimals for XOF are rejected
    const bad = await a.owner.post(
      '/v1/invoices',
      invoiceInput(a.businessOrgId, {
        currencyCode: 'XOF',
        lines: [{ description: 'x', quantity: 1, unitPrice: '10.50' }],
      }),
    );
    expect(bad.status).toBe(400);
  });

  it('walks the lifecycle DRAFT → SENT → PARTIALLY_PAID → PAID with manual payments', async () => {
    const inv = await createInvoice(a.owner, a.businessOrgId);
    // Payment on a draft is an invalid transition
    const early = await a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: '10.00' });
    expect(early.status).toBe(409);

    // Draft edit recomputes totals
    const edited = await a.owner.patch(`/v1/invoices/${inv.id}`, {
      lines: [{ description: 'Forfait révisé', quantity: 1, unitPrice: '200.00' }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.subtotal.decimal).toBe('200.00');
    expect(edited.body.tax.decimal).toBe('36.00');
    expect(edited.body.total.decimal).toBe('236.00');
    expect(edited.body.lines).toHaveLength(1);

    const sent = await a.owner.post(`/v1/invoices/${inv.id}/send`);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe('SENT');
    expect(sent.body.sentAt).toBeTruthy();
    expect(sent.body.nextActions).toEqual(expect.arrayContaining(['RECORD_PAYMENT', 'CANCEL']));
    expect(sent.body.nextActions).not.toContain('EDIT');
    // Sent invoices cannot be edited or re-sent
    expect((await a.owner.patch(`/v1/invoices/${inv.id}`, { notes: 'x' })).status).toBe(409);
    expect((await a.owner.post(`/v1/invoices/${inv.id}/send`)).status).toBe(409);

    // Overpayment is rejected
    const tooMuch = await a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: '500.00' });
    expect(tooMuch.status).toBe(400);

    const partial = await a.owner.post(`/v1/invoices/${inv.id}/payments`, {
      amount: '100.00',
      method: 'EXTERNAL_RECORDED',
      reference: 'VIR-2026-001',
    });
    expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    expect(partial.body.status).toBe('PARTIALLY_PAID');
    expect(partial.body.paid.decimal).toBe('100.00');
    expect(partial.body.balanceDue.decimal).toBe('136.00');
    expect(partial.body.payments).toHaveLength(1);
    expect(partial.body.payments[0].method).toBe('EXTERNAL_RECORDED');
    expect(partial.body.payments[0].reference).toBe('VIR-2026-001');

    const paid = await a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: '136.00' });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.paidAt).toBeTruthy();
    expect(paid.body.balanceDue.decimal).toBe('0.00');
    expect(paid.body.nextActions).toEqual(['VIEW_DOCUMENT']);

    // Paid invoices cannot be cancelled nor paid again
    expect((await a.owner.post(`/v1/invoices/${inv.id}/cancel`, { reason: 'test' })).status).toBe(409);
    expect((await a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: '1.00' })).status).toBe(409);

    // Audit trail and notifications
    const audits = await ctx.prisma.auditLog.findMany({
      where: { organizationId: a.businessOrgId, action: { startsWith: 'invoice.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((x) => x.action)).toEqual([
      'invoice.created',
      'invoice.updated',
      'invoice.sent',
      'invoice.payment_recorded',
      'invoice.payment_recorded',
    ]);
    const notifications = await ctx.prisma.notification.findMany({
      where: { userId: a.ownerUser.id, type: { in: ['invoice.paid', 'invoice.payment_recorded'] } },
    });
    expect(notifications.map((n) => n.type).sort()).toEqual(['invoice.paid', 'invoice.payment_recorded']);

    // Printable document
    const doc = await a.owner.get(`/v1/invoices/${inv.id}/document`);
    expect(doc.status).toBe(200);
    expect(doc.body.kind).toBe('INVOICE');
    expect(doc.body.text).toContain('Données fictives — Aucun fonds réel');
    expect(doc.body.text).toContain(inv.number);
    expect(doc.body.totals.total.decimal).toBe('236.00');
  });

  it('cancels drafts and sent invoices, keeps the number and rejects invalid transitions', async () => {
    const draft = await createInvoice(a.owner, a.businessOrgId);
    const cancelled = await a.owner.post(`/v1/invoices/${draft.id}/cancel`, { reason: 'Erreur de saisie' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledAt).toBeTruthy();
    expect((await a.owner.post(`/v1/invoices/${draft.id}/send`)).status).toBe(409);
    expect((await a.owner.post(`/v1/invoices/${draft.id}/cancel`)).status).toBe(409);
    // The next invoice keeps the sequence going (numbers are never reused)
    const next = await createInvoice(a.owner, a.businessOrgId);
    expect(next.number.endsWith('-0002')).toBe(true);
    await a.owner.post(`/v1/invoices/${next.id}/send`);
    expect((await a.owner.post(`/v1/invoices/${next.id}/cancel`, {})).body.status).toBe('CANCELLED');
    // PROTECT_RELEASE cannot be recorded manually
    const third = await createInvoice(a.owner, a.businessOrgId);
    await a.owner.post(`/v1/invoices/${third.id}/send`);
    const manual = await a.owner.post(`/v1/invoices/${third.id}/payments`, {
      amount: '1.00',
      method: 'PROTECT_RELEASE',
    });
    expect(manual.status).toBe(400);
  });

  it('lists, filters and exports invoices as CSV with the sandbox disclaimer', async () => {
    const one = await createInvoice(a.owner, a.businessOrgId, { customerName: 'Alpha SARL' });
    await createInvoice(a.owner, a.businessOrgId, { customerName: 'Beta Inc' });
    await a.owner.post(`/v1/invoices/${one.id}/send`);
    const all = await a.owner.get(`/v1/invoices?organizationId=${a.businessOrgId}`);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    const sentOnly = await a.owner.get(`/v1/invoices?organizationId=${a.businessOrgId}&status=SENT`);
    expect(sentOnly.body.items.map((i: any) => i.id)).toEqual([one.id]);
    const search = await a.owner.get(`/v1/invoices?organizationId=${a.businessOrgId}&search=beta`);
    expect(search.body.total).toBe(1);
    expect((await a.owner.get(`/v1/invoices?organizationId=${a.businessOrgId}&status=NOPE`)).status).toBe(
      400,
    );
    // Default scope = every organisation of the caller
    const mine = await a.owner.get('/v1/invoices');
    expect(mine.body.total).toBe(2);

    const csv = await a.owner.get(`/v1/invoices.csv?organizationId=${a.businessOrgId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.split('\n');
    expect(lines[0]).toContain('SANDBOX');
    expect(lines[0]).toContain('Données fictives — Aucun fonds réel');
    expect(lines[1]).toBe(
      'number,status,customer_name,customer_email,currency,issue_date,due_date,subtotal,tax,total,paid,balance_due,transaction_reference,quote_number,sent_at,paid_at,cancelled_at',
    );
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('INV-');
    expect(lines[2]).toContain('Alpha SARL');
  });

  it('marks overdue invoices through the INVOICE_OVERDUE job and notifies the issuer', async () => {
    const inv = await createInvoice(a.owner, a.businessOrgId);
    await a.owner.post(`/v1/invoices/${inv.id}/send`);
    const draft = await createInvoice(a.owner, a.businessOrgId);
    const future = await createInvoice(a.owner, a.businessOrgId);
    await a.owner.post(`/v1/invoices/${future.id}/send`);
    // Backdate the due date of the sent invoice and the draft (the draft must stay untouched)
    const past = new Date(Date.now() - 5 * 86_400_000);
    await ctx.prisma.invoice.updateMany({
      where: { id: { in: [inv.id, draft.id] } },
      data: { dueDate: past },
    });

    const run = await ctx.app.get(MaintenanceService).run('INVOICE_OVERDUE', 'test');
    expect(run.status).toBe('COMPLETED');
    expect((run.summary as any).overdue).toBe(1);
    expect((run.summary as any).invoiceIds).toEqual([inv.id]);

    const after = await a.owner.get(`/v1/invoices/${inv.id}`);
    expect(after.body.status).toBe('OVERDUE');
    expect((await a.owner.get(`/v1/invoices/${draft.id}`)).body.status).toBe('DRAFT');
    expect((await a.owner.get(`/v1/invoices/${future.id}`)).body.status).toBe('SENT');
    const notified = await ctx.prisma.notification.findMany({ where: { type: 'invoice.overdue' } });
    expect(notified.map((n) => n.userId)).toEqual([a.ownerUser.id]); // VIEWER is not notified
    // Overdue invoices still accept payments and become PAID
    const paid = await a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: after.body.total.decimal });
    expect(paid.status).toBe(201);
    expect(paid.body.status).toBe('PAID');
    // Second run is a no-op
    const again = await ctx.app.get(MaintenanceService).run('INVOICE_OVERDUE', 'test');
    expect((again.summary as any).overdue).toBe(0);
  });

  it('enforces tenant isolation (404) and org roles (403)', async () => {
    const inv = await createInvoice(a.owner, a.businessOrgId);
    // Outsider: cannot see, list, edit or export
    expect((await a.outsider.get(`/v1/invoices/${inv.id}`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/invoices/${inv.id}/document`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/invoices?organizationId=${a.businessOrgId}`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/invoices.csv?organizationId=${a.businessOrgId}`)).status).toBe(404);
    expect((await a.outsider.post(`/v1/invoices/${inv.id}/send`)).status).toBe(404);
    expect((await a.outsider.patch(`/v1/invoices/${inv.id}`, { notes: 'x' })).status).toBe(404);
    expect((await a.outsider.post(`/v1/invoices/${inv.id}/payments`, { amount: '1.00' })).status).toBe(404);
    expect((await a.outsider.post('/v1/invoices', invoiceInput(a.businessOrgId))).status).toBe(404);
    expect((await a.outsider.get(`/v1/organizations/${a.businessOrgId}/reports/summary`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/organizations/${a.businessOrgId}/reports/commissions`)).status).toBe(
      404,
    );
    expect((await a.outsider.get('/v1/invoices')).body.total).toBe(0);

    // Viewer: can read but not write
    expect((await a.viewer.get(`/v1/invoices/${inv.id}`)).status).toBe(200);
    expect((await a.viewer.get(`/v1/invoices?organizationId=${a.businessOrgId}`)).body.total).toBe(1);
    expect((await a.viewer.get(`/v1/invoices/${inv.id}`)).body.nextActions).toEqual(['VIEW_DOCUMENT']);
    expect((await a.viewer.post('/v1/invoices', invoiceInput(a.businessOrgId))).status).toBe(403);
    expect((await a.viewer.post(`/v1/invoices/${inv.id}/send`)).status).toBe(403);
    expect((await a.viewer.patch(`/v1/invoices/${inv.id}`, { notes: 'x' })).status).toBe(403);
    expect((await a.viewer.post(`/v1/invoices/${inv.id}/cancel`)).status).toBe(403);
    expect(
      (await a.viewer.post('/v1/quotes', { ...invoiceInput(a.businessOrgId), validUntil: inDays(10) }))
        .status,
    ).toBe(403);
    // Reports need ORG_VIEW_REPORTS (VIEWER has it)
    expect((await a.viewer.get(`/v1/organizations/${a.businessOrgId}/reports/summary`)).status).toBe(200);
    // Counterparty of another organisation is rejected
    const foreignCp = await ctx.prisma.counterparty.create({
      data: { organizationId: a.outsiderOrgId, name: 'X' },
    });
    expect(
      (await a.owner.post('/v1/invoices', invoiceInput(a.businessOrgId, { counterpartyId: foreignCp.id })))
        .status,
    ).toBe(400);
  });

  it('requests (never auto-creates) a link to the personal workspace of a DFN user with the same email', async () => {
    const linked = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Outsider Inc',
      email: 'wallet-outsider-biz@example.com',
      country: 'CA',
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    // Consent workflow: nothing is linked until the target accepts, and the requester is not told
    // whether the e-mail matched an account.
    expect(linked.body.linkedOrganizationId).toBeNull();
    expect(linked.body.linkRequest).toBe('SENT_IF_ELIGIBLE');
    expect(linked.body.link.status).toBe('REQUESTED');
    expect(JSON.stringify(linked.body)).not.toContain(a.outsiderOrgId);
    const row = await ctx.prisma.counterparty.findUniqueOrThrow({ where: { id: linked.body.id } });
    expect(row.linkStatus).toBe('PENDING');
    expect(row.linkRequestedOrganizationId).toBe(a.outsiderOrgId);
    expect(row.linkedOrganizationId).toBeNull();
    const explicit = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Self link attempt',
      linkedOrganizationId: a.businessOrgId,
    });
    expect(explicit.status).toBe(400);
    // An explicit link towards an organisation the caller does not belong to is refused: it would
    // let anyone probe organisation ids and push invoices into a tenant that never opted in.
    const foreign = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Foreign link attempt',
      linkedOrganizationId: a.outsiderOrgId,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('VALIDATION_FAILED');
  });

  it('never over-pays an invoice under concurrent partial payments', async () => {
    const inv = await createInvoice(a.owner, a.businessOrgId, {
      lines: [{ description: 'Service', quantity: 1, unitPrice: '100.00' }],
      taxBps: 0,
    });
    expect((await a.owner.post(`/v1/invoices/${inv.id}/send`)).status).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        a.owner.post(`/v1/invoices/${inv.id}/payments`, { amount: '60.00', method: 'EXTERNAL_RECORDED' }),
      ),
    );
    const accepted = results.filter((r) => r.status === 201 || r.status === 200);
    expect(accepted).toHaveLength(1);
    const row = await ctx.prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.paidMinor).toBe(6000n);
    expect(row.status).toBe('PARTIALLY_PAID');
    for (const r of results.filter((x) => x.status !== 201 && x.status !== 200)) {
      expect([400, 409]).toContain(r.status);
    }
  });

  it('lets a linked customer pay from its wallet (balanced ledger posting) and rejects unlinked payers', async () => {
    // Business org issues an invoice to a counterparty whose e-mail belongs to the outsider: a link
    // request is sent to the outsider's personal workspace, nothing is linked before consent.
    const cp = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Jean Tremblay',
      email: 'wallet-outsider-biz@example.com',
      country: 'CA',
    });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    expect(cp.body.linkedOrganizationId).toBeNull();
    const inv = await createInvoice(a.owner, a.businessOrgId, {
      counterpartyId: cp.body.id,
      customerEmail: 'wallet-outsider-biz@example.com',
      taxBps: 0,
      lines: [{ description: 'Service', quantity: 1, unitPrice: '150.00' }],
    });
    await a.owner.post(`/v1/invoices/${inv.id}/send`);
    // Not accepted yet → no invoice notification reaches the customer, who can neither see nor pay it
    const sentNotif = await ctx.prisma.notification.findMany({
      where: { userId: a.outsiderUser.id, type: 'invoice.sent' },
    });
    expect(sentNotif).toHaveLength(0);
    expect((await a.outsider.get(`/v1/invoices/${inv.id}`)).status).toBe(404);
    expect(
      (
        await a.outsider.post(`/v1/invoices/${inv.id}/payments`, {
          amount: '1.00',
          method: 'WALLET_SIMULATED',
        })
      ).status,
    ).toBe(404);

    // The outsider accepts the link request addressed to its personal workspace
    const accepted = await a.outsider.post(
      `/v1/organizations/${a.outsiderOrgId}/link-requests/${cp.body.id}/accept`,
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    const asCustomer = await a.outsider.get(`/v1/invoices/${inv.id}`);
    expect(asCustomer.status).toBe(200);
    expect(asCustomer.body.myRole).toBe('CUSTOMER');
    expect(asCustomer.body.nextActions).toEqual(['PAY_WALLET', 'VIEW_DOCUMENT']);
    const received = await a.outsider.get(`/v1/invoices?organizationId=${a.outsiderOrgId}&scope=RECEIVED`);
    expect(received.body.total).toBe(1);
    // The customer cannot do issuer things
    expect((await a.outsider.post(`/v1/invoices/${inv.id}/cancel`)).status).toBe(403);
    expect((await a.outsider.post(`/v1/invoices/${inv.id}/payments`, { amount: '1.00' })).status).toBe(403);
    // The issuer cannot pay its own invoice from a wallet
    const self = await a.owner.post(`/v1/invoices/${inv.id}/payments`, {
      amount: '10.00',
      method: 'WALLET_SIMULATED',
      organizationId: a.businessOrgId,
    });
    expect(self.status).toBe(409);

    // Insufficient fictitious funds → 409 from the ledger
    const broke = await a.outsider.post(`/v1/invoices/${inv.id}/payments`, {
      amount: '150.00',
      method: 'WALLET_SIMULATED',
    });
    expect(broke.status).toBe(409);

    const deposit = await selfDeposit(a.outsider, a.outsiderOrgId, 'CAD', '500.00');
    expect(deposit.status, JSON.stringify(deposit.body)).toBe(200);
    const payment = await a.outsider.post(`/v1/invoices/${inv.id}/payments`, {
      amount: '150.00',
      method: 'WALLET_SIMULATED',
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(payment.body.status).toBe('PAID');
    expect(payment.body.payments[0].method).toBe('WALLET_SIMULATED');
    expect(payment.body.payments[0].ledgerTransactionId).toBeTruthy();
    // Once linked, the customer organisation receives the invoice notifications
    expect(
      await ctx.prisma.notification.count({ where: { userId: a.outsiderUser.id, type: 'invoice.paid' } }),
    ).toBe(1);

    const payerWallet = await a.outsider.get(`/v1/wallets/${a.outsiderOrgId}`);
    expect(payerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '350.00',
    );
    const issuerWallet = await a.owner.get(`/v1/wallets/${a.businessOrgId}`);
    expect(issuerWallet.body.wallets.find((w: any) => w.currencyCode === 'CAD').balance.decimal).toBe(
      '150.00',
    );
    const posting = await ctx.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: `invoice-payment:${payment.body.payments[0].id}` },
      include: { entries: true },
    });
    expect(posting?.entries).toHaveLength(2);
    const audit = await ctx.prisma.auditLog.findFirst({ where: { action: 'invoice.paid_from_wallet' } });
    expect(audit?.organizationId).toBe(a.outsiderOrgId);
  });
});

describe('Diaspora Business — quotes', () => {
  let a: WalletActors;
  beforeEach(async () => {
    a = await createWalletActors(ctx, '-quo');
  });

  function quoteInput(overrides: Record<string, unknown> = {}) {
    return {
      organizationId: a.businessOrgId,
      customerName: 'Dakar Auto Import',
      customerEmail: 'wallet-outsider-quo@example.com',
      currencyCode: 'CAD',
      validUntil: inDays(15),
      taxBps: 500,
      lines: [
        { description: 'Inspection véhicule', quantity: 1, unitPrice: '300.00' },
        { description: 'Transport maritime', quantity: 2, unitPrice: '1250.00' },
      ],
      ...overrides,
    };
  }

  it('numbers quotes, sends, accepts and converts them into a draft invoice copying the lines', async () => {
    // The customer accepted the link requested by the issuer: it is notified of the quotes it receives.
    const cp = await a.owner.post(`/v1/organizations/${a.businessOrgId}/counterparties`, {
      name: 'Dakar Auto Import',
      email: 'wallet-outsider-quo@example.com',
    });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    expect(
      (await a.outsider.post(`/v1/organizations/${a.outsiderOrgId}/link-requests/${cp.body.id}/accept`))
        .status,
    ).toBe(200);
    const created = await a.owner.post('/v1/quotes', quoteInput({ counterpartyId: cp.body.id }));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const year = new Date().getUTCFullYear();
    expect(created.body.number).toBe(`QUO-${year}-0001`);
    expect(created.body.subtotal.decimal).toBe('2800.00');
    expect(created.body.tax.decimal).toBe('140.00');
    expect(created.body.total.decimal).toBe('2940.00');
    expect(created.body.nextActions).toEqual(expect.arrayContaining(['EDIT', 'SEND', 'DECLINE']));
    const id = created.body.id as string;
    // Not accepted yet → cannot convert
    expect((await a.owner.post(`/v1/quotes/${id}/convert`, { target: 'INVOICE' })).status).toBe(409);
    expect((await a.owner.post(`/v1/quotes/${id}/accept`)).status).toBe(409);

    const sent = await a.owner.post(`/v1/quotes/${id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('SENT');
    expect(
      (await ctx.prisma.notification.findMany({ where: { userId: a.outsiderUser.id, type: 'quote.sent' } }))
        .length,
    ).toBe(1);
    expect((await a.owner.patch(`/v1/quotes/${id}`, { notes: 'x' })).status).toBe(409);

    const accepted = await a.owner.post(`/v1/quotes/${id}/accept`, { note: 'Accord verbal du client' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect(accepted.body.acceptedAt).toBeTruthy();
    expect(accepted.body.nextActions).toEqual(['CONVERT_INVOICE', 'VIEW_DOCUMENT']);

    // Protect conversion is not available (needs seller-initiated transactions)
    const protect = await a.owner.post(`/v1/quotes/${id}/convert`, { target: 'PROTECT_TRANSACTION' });
    expect(protect.status).toBe(400);
    expect(protect.body.code).toBe('NOT_AVAILABLE');

    const converted = await a.owner.post(`/v1/quotes/${id}/convert`, {
      target: 'INVOICE',
      dueDate: inDays(45),
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(201);
    expect(converted.body.quote.status).toBe('CONVERTED');
    const invoice = converted.body.invoice;
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.number).toBe(`INV-${year}-0001`);
    expect(invoice.quoteId).toBe(id);
    expect(invoice.lines).toHaveLength(2);
    expect(
      invoice.lines.map((l: any) => [l.description, l.quantity, l.unitPrice.decimal, l.total.decimal]),
    ).toEqual([
      ['Inspection véhicule', 1, '300.00', '300.00'],
      ['Transport maritime', 2, '1250.00', '2500.00'],
    ]);
    expect(invoice.total.decimal).toBe('2940.00');
    expect(invoice.customerName).toBe('Dakar Auto Import');
    expect(invoice.dueDate.slice(0, 10)).toBe(inDays(45));
    // A converted quote is terminal; the invoice links back
    expect((await a.owner.post(`/v1/quotes/${id}/convert`, { target: 'INVOICE' })).status).toBe(409);
    expect((await a.owner.get(`/v1/quotes/${id}`)).body.invoice.number).toBe(invoice.number);
    expect((await a.owner.get(`/v1/invoices/${invoice.id}`)).body.quote.number).toBe(`QUO-${year}-0001`);
    const doc = await a.owner.get(`/v1/quotes/${id}/document`);
    expect(doc.body.kind).toBe('QUOTE');
    expect(doc.body.text).toContain('Données fictives');
  });

  it('declines, expires lazily and isolates tenants', async () => {
    const declined = await a.owner.post('/v1/quotes', quoteInput());
    expect(
      (await a.owner.post(`/v1/quotes/${declined.body.id}/decline`, { reason: 'Trop cher' })).body.status,
    ).toBe('DECLINED');
    expect((await a.owner.post(`/v1/quotes/${declined.body.id}/send`)).status).toBe(409);

    const stale = await a.owner.post('/v1/quotes', quoteInput());
    await a.owner.post(`/v1/quotes/${stale.body.id}/send`);
    await ctx.prisma.quote.update({
      where: { id: stale.body.id },
      data: { validUntil: new Date(Date.now() - 3 * 86_400_000) },
    });
    const expired = await a.owner.get(`/v1/quotes/${stale.body.id}`);
    expect(expired.body.status).toBe('EXPIRED');
    expect((await a.owner.post(`/v1/quotes/${stale.body.id}/accept`)).status).toBe(409);
    expect((await a.owner.post('/v1/quotes', quoteInput({ validUntil: '2020-01-01' }))).status).toBe(400);

    const list = await a.owner.get(`/v1/quotes?organizationId=${a.businessOrgId}&status=EXPIRED,DECLINED`);
    expect(list.body.total).toBe(2);
    expect((await a.outsider.get(`/v1/quotes/${stale.body.id}`)).status).toBe(404);
    expect((await a.outsider.get(`/v1/quotes?organizationId=${a.businessOrgId}`)).status).toBe(404);
    expect((await a.outsider.post(`/v1/quotes/${stale.body.id}/send`)).status).toBe(404);
    expect((await a.viewer.post(`/v1/quotes/${declined.body.id}/send`)).status).toBe(403);
    expect((await a.viewer.get(`/v1/quotes/${declined.body.id}`)).status).toBe(200);
  });
});

describe('Diaspora Business — Protect integration and reports', () => {
  it('applies released milestones as PROTECT_RELEASE payments and reports volumes, fees, aging and commissions', async () => {
    const actors = await createActors(ctx, '-biz');
    const buyerOrgId = actors.buyerUser.organizations[0].id as string;
    const sellerOrgId = actors.sellerUser.organizations[0].id as string;
    const { txId, tx } = await fundTransaction(ctx, actors, {
      title: 'Toyota Hilux 2019 — export Montréal → Dakar',
      description: 'Pick-up double cabine, 85 000 km, inspection avant embarquement et livraison au port.',
      category: 'VEHICLE',
      currencyCode: 'CAD',
      amount: '18500.00',
      originCountry: 'CA',
      destinationCountry: 'SN',
      seller: { email: 'seller-biz@example.com', name: 'Dakar Auto Import' },
      milestones: [
        { title: 'Embarquement confirmé', amount: '9250.00', requiredEvidence: ['BILL_OF_LADING'] },
        { title: 'Livraison au port de Dakar', amount: '9250.00', requiredEvidence: ['PROOF_OF_SHIPMENT'] },
      ],
      terms: { deliveryDeadlineDays: 60, inspectionWindowDays: 5 },
    });
    // The buyer cannot link a seller-side invoice to a transaction in another currency
    const wrongCcy = await actors.seller.post('/v1/invoices', {
      organizationId: sellerOrgId,
      customerName: 'Moussa Ndiaye',
      currencyCode: 'XOF',
      dueDate: inDays(20),
      transactionId: txId,
      lines: [{ description: 'x', quantity: 1, unitPrice: '100' }],
    });
    expect(wrongCcy.status).toBe(400);
    // An unrelated organisation cannot link the transaction
    const outsider = await registerUser(ctx, 'stranger-biz@example.com');
    const foreign = await outsider.client.post('/v1/invoices', {
      customerName: 'x',
      currencyCode: 'CAD',
      dueDate: inDays(20),
      transactionId: txId,
      lines: [{ description: 'x', quantity: 1, unitPrice: '100.00' }],
    });
    expect(foreign.status).toBe(400);

    // Seller invoices the buyer for the whole transaction, linked to it
    const inv = await actors.seller.post('/v1/invoices', {
      organizationId: sellerOrgId,
      customerName: 'Moussa Ndiaye',
      customerEmail: 'buyer-biz@example.com',
      currencyCode: 'CAD',
      dueDate: inDays(20),
      transactionId: txId,
      taxBps: 0,
      lines: [{ description: 'Toyota Hilux 2019 — vente export', quantity: 1, unitPrice: '18500.00' }],
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.transaction.reference).toBe(tx.reference);
    await actors.seller.post(`/v1/invoices/${inv.body.id}/send`);
    // A second, overdue invoice for the aging report (not linked)
    const aged = await actors.seller.post('/v1/invoices', {
      organizationId: sellerOrgId,
      customerName: 'Client retardataire',
      currencyCode: 'CAD',
      dueDate: inDays(5),
      lines: [{ description: 'Pièces détachées', quantity: 4, unitPrice: '100.00' }],
    });
    await actors.seller.post(`/v1/invoices/${aged.body.id}/send`);
    await ctx.prisma.invoice.update({
      where: { id: aged.body.id },
      data: { dueDate: new Date(Date.now() - 45 * 86_400_000) },
    });
    await ctx.app.get(MaintenanceService).run('INVOICE_OVERDUE', 'test');
    // Quotes pipeline
    const quote = await actors.seller.post('/v1/quotes', {
      organizationId: sellerOrgId,
      customerName: 'Prospect',
      currencyCode: 'CAD',
      validUntil: inDays(10),
      lines: [{ description: 'Devis', quantity: 1, unitPrice: '999.00' }],
    });
    await actors.seller.post(`/v1/quotes/${quote.body.id}/send`);

    // Milestone 1 released → PROTECT_RELEASE payment recorded automatically (bus is async)
    const m1 = tx.milestones[0];
    const bol = await uploadEvidence(actors.seller, txId, 'BILL_OF_LADING', 'bol.pdf');
    const submitted = await actors.seller.post(`/v1/transactions/${txId}/milestones/${m1.id}/submit`, {
      documentIds: [bol],
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const approved = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m1.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.milestones[0].status).toBe('RELEASED');
    await sleep(400);
    const afterRelease = await actors.seller.get(`/v1/invoices/${inv.body.id}`);
    expect(afterRelease.body.status).toBe('PARTIALLY_PAID');
    expect(afterRelease.body.paid.decimal).toBe('9250.00');
    expect(afterRelease.body.payments).toHaveLength(1);
    expect(afterRelease.body.payments[0].method).toBe('PROTECT_RELEASE');
    expect(afterRelease.body.payments[0].ledgerTransactionId).toBe(
      approved.body.milestones[0].ledgerTransactionId,
    );
    expect(afterRelease.body.payments[0].reference).toBe(approved.body.milestones[0].ledgerTransactionId);

    // Reports — seller side
    const sellerReport = await actors.seller.get(`/v1/organizations/${sellerOrgId}/reports/summary`);
    expect(sellerReport.status, JSON.stringify(sellerReport.body)).toBe(200);
    expect(sellerReport.body.sandbox).toBe(true);
    expect(sellerReport.body.disclaimer).toBe('Données fictives — Aucun fonds réel');
    const cad = sellerReport.body.currencies.find((c: any) => c.currencyCode === 'CAD');
    expect(cad.protect.asSeller.count).toBe(1);
    expect(cad.protect.asSeller.amount.decimal).toBe('18500.00');
    expect(cad.protect.asSeller.byStatus.IN_PROGRESS.count).toBe(1);
    expect(cad.protect.asBuyer.count).toBe(0);
    expect(cad.protect.receivedAsSeller.decimal).toBe('9250.00');
    expect(cad.protect.feesPaid.decimal).toBe('0.00');
    expect(cad.receivables.count).toBe(2);
    expect(cad.receivables.outstanding.decimal).toBe('9650.00'); // 9250 + 400
    expect(cad.receivables.outstandingCount).toBe(2);
    expect(cad.receivables.overdueCount).toBe(1);
    expect(cad.receivables.collected.decimal).toBe('9250.00');
    expect(cad.receivables.invoiced.decimal).toBe('18900.00');
    expect(cad.receivables.aging['0-30'].amount.decimal).toBe('9250.00');
    expect(cad.receivables.aging['31-60'].amount.decimal).toBe('400.00');
    expect(cad.receivables.aging['31-60'].count).toBe(1);
    expect(cad.receivables.aging['61-90'].amount.decimal).toBe('0.00');
    expect(cad.receivables.aging['90+'].count).toBe(0);
    expect(cad.receivables.byStatus.OVERDUE.count).toBe(1);
    expect(cad.quotes.pipeline.SENT.count).toBe(1);
    expect(cad.quotes.openValue.decimal).toBe('999.00');
    expect(cad.wallet.balance.decimal).toBe('9250.00');
    expect(sellerReport.body.quotesPipeline).toEqual({ SENT: 1 });

    // Reports — buyer side: fees paid at funding (150 bps of 18 500 = 277.50)
    const buyerReport = await actors.buyer.get(
      `/v1/organizations/${buyerOrgId}/reports/summary?currencyCode=CAD`,
    );
    const bcad = buyerReport.body.currencies.find((c: any) => c.currencyCode === 'CAD');
    expect(bcad.protect.asBuyer.count).toBe(1);
    expect(bcad.protect.feesPaid.decimal).toBe('277.50');
    expect(bcad.protect.feesCount).toBe(1);
    expect(bcad.protect.releasedAsBuyer.decimal).toBe('9250.00');
    expect(bcad.receivables.count).toBe(0);
    // Period filter excluding everything
    const empty = await actors.buyer.get(
      `/v1/organizations/${buyerOrgId}/reports/summary?from=2000-01-01&to=2000-01-31`,
    );
    expect(empty.body.counts.transactions).toBe(0);
    expect(
      (
        await actors.buyer.get(
          `/v1/organizations/${buyerOrgId}/reports/summary?from=2030-01-01&to=2020-01-01`,
        )
      ).status,
    ).toBe(400);

    const commissions = await actors.buyer.get(`/v1/organizations/${buyerOrgId}/reports/commissions`);
    expect(commissions.status).toBe(200);
    expect(commissions.body.items).toHaveLength(1);
    expect(commissions.body.items[0].reference).toBe(tx.reference);
    expect(commissions.body.items[0].fee.decimal).toBe('277.50');
    expect(commissions.body.items[0].feeBps).toBe(150);
    expect(commissions.body.items[0].ledgerTransactionId).toBeTruthy();
    expect(commissions.body.currencies).toEqual([
      { currencyCode: 'CAD', count: 1, totalFees: { minor: '27750', decimal: '277.50', currency: 'CAD' } },
    ]);
    expect(
      (await actors.seller.get(`/v1/organizations/${sellerOrgId}/reports/commissions`)).body.items,
    ).toHaveLength(0);

    // CSV exports
    const txCsv = await actors.seller.get(`/v1/organizations/${sellerOrgId}/reports/transactions.csv`);
    expect(txCsv.status).toBe(200);
    expect(txCsv.headers['content-type']).toContain('text/csv');
    const txLines = txCsv.text.split('\n');
    expect(txLines[0]).toContain('Données fictives — Aucun fonds réel');
    expect(txLines[1]).toBe(
      'reference,title,role,status,currency,amount,fee,fee_bps,released,refunded,counterpart,origin_country,destination_country,created_at,funded_at,settled_at',
    );
    expect(txLines[2]).toContain(`${tx.reference},`);
    expect(txLines[2]).toContain(',SELLER,IN_PROGRESS,CAD,18500.00,0,150,9250.00,0.00,');
    const invCsv = await actors.seller.get(`/v1/organizations/${sellerOrgId}/reports/invoices.csv`);
    expect(invCsv.status).toBe(200);
    expect(invCsv.text.split('\n')[1].startsWith('number,status,customer_name')).toBe(true);
    expect(invCsv.text.split('\n')).toHaveLength(4);

    // Milestone 2 released → invoice fully PAID and an invoice.paid notification reaches the seller
    const m2 = tx.milestones[1];
    const pos = await uploadEvidence(actors.seller, txId, 'PROOF_OF_SHIPMENT', 'delivery.pdf');
    await actors.seller.post(`/v1/transactions/${txId}/milestones/${m2.id}/submit`, { documentIds: [pos] });
    const approved2 = await actors.buyer.post(`/v1/transactions/${txId}/milestones/${m2.id}/approve`, {});
    expect(approved2.status).toBe(200);
    expect(approved2.body.status).toBe('SETTLED');
    await sleep(400);
    const final = await actors.seller.get(`/v1/invoices/${inv.body.id}`);
    expect(final.body.status).toBe('PAID');
    expect(final.body.paid.decimal).toBe('18500.00');
    expect(final.body.payments).toHaveLength(2);
    const paidNotif = await ctx.prisma.notification.findMany({
      where: { userId: actors.sellerUser.id, type: 'invoice.paid' },
    });
    expect(paidNotif).toHaveLength(1);
    const settledReport = await actors.seller.get(
      `/v1/organizations/${sellerOrgId}/reports/summary?currencyCode=CAD`,
    );
    const scad = settledReport.body.currencies.find((c: any) => c.currencyCode === 'CAD');
    expect(scad.protect.asSeller.byStatus.SETTLED.count).toBe(1);
    expect(scad.protect.receivedAsSeller.decimal).toBe('18500.00');
    expect(scad.receivables.outstanding.decimal).toBe('400.00');
  });
});
