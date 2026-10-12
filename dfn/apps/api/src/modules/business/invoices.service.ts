import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { InvoiceStatus, Prisma, PrismaTransactionClient } from '@dfn/database';
import { LedgerService } from '@dfn/financial-ledger';
import {
  InvoiceStatus as InvoiceStatusEnum,
  Permission,
  invoiceMachine,
  minorToDecimalString,
  orgRoleHas,
  parseDecimalToMinor,
  type CancelDocumentInput,
  type CreateInvoiceInput,
  type LineItemInput,
  type ListBusinessDocumentsQuery,
  type RecordInvoicePaymentInput,
} from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { DomainEventsBus, type DomainEvent } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { moneyDto } from '../../common/serialize';
import { AuditService } from '../audit/audit.service';
import { JobRegistry, type JobResult } from '../jobs/job-registry';
import { LEDGER } from '../ledger/ledger.provider';
import { WalletsService } from '../ledger/wallets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  OPEN_INVOICE_STATUSES,
  acceptedLinkedOrganizationId,
  documentAccessFor,
  invoiceInclude,
  printableDocument,
  toInvoiceDto,
  type DocumentAccess,
  type InvoiceWithRelations,
} from './business.dto';
import {
  BUSINESS_DISCLAIMER_FR,
  allocateDocumentNumber,
  clampNonNegative,
  computeDocumentTotals,
  csvLine,
  linkedCustomerUserIds,
  parseDay,
  retryOnUniqueViolation,
  startOfUtcDay,
  storedTaxBps,
} from './business.utils';

const INVOICE_STATUSES = new Set<string>(Object.values(InvoiceStatusEnum));

/**
 * Diaspora Business — invoices. Numbering is per organisation (INV-<year>-<0001>), totals are
 * integer minor units, payments drive PARTIALLY_PAID / PAID, wallet payments are balanced ledger
 * postings, and Protect releases settle linked invoices automatically.
 */
@Injectable()
export class InvoicesService implements OnModuleInit {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrganizationsService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly bus: DomainEventsBus,
    private readonly registry: JobRegistry,
    private readonly risk: RiskService,
  ) {}

  onModuleInit() {
    this.bus.on((event) => this.onDomainEvent(event));
    this.registry.register('INVOICE_OVERDUE', () => this.markOverdue());
  }

  // ───────────────────────────── Loading & access ───────────────────────────

  async load(
    id: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<InvoiceWithRelations> {
    const invoice = await db.invoice.findUnique({ where: { id }, include: invoiceInclude });
    if (!invoice) throw DomainError.notFound('Invoice');
    return invoice;
  }

  /** Cross-tenant access yields 404 (no existence leak). */
  async loadFor(auth: AuthContext, id: string, db?: PrismaTransactionClient | PrismaService) {
    const invoice = await this.load(id, db);
    const access = documentAccessFor(auth, invoice);
    if (!access) throw DomainError.notFound('Invoice');
    return { invoice, access };
  }

  /**
   * Only the issuing organisation (INVOICE_MANAGE) may change a document. Non-member staff are
   * read-only; an ADMIN may act for support with a reason (audited — see authorizeWrite).
   */
  private async assertIssuerManage(
    auth: AuthContext,
    invoice: InvoiceWithRelations,
    access: DocumentAccess,
    req: Request,
  ) {
    if (access.role === 'CUSTOMER') throw DomainError.forbidden('Only the issuing organisation can do this');
    return this.orgs.authorizeWrite(auth, invoice.organizationId, Permission.INVOICE_MANAGE, req);
  }

  private async assertCounterparty(organizationId: string, counterpartyId: string | undefined) {
    if (!counterpartyId) return null;
    const cp = await this.prisma.counterparty.findFirst({ where: { id: counterpartyId, organizationId } });
    if (!cp) throw DomainError.validation('Counterparty does not belong to this organisation');
    return cp;
  }

  private async assertTransaction(organizationId: string, transactionId: string | undefined) {
    if (!transactionId) return null;
    const tx = await this.prisma.transaction.findFirst({
      where: {
        id: transactionId,
        OR: [{ buyerOrganizationId: organizationId }, { sellerOrganizationId: organizationId }],
      },
      select: { id: true, currencyCode: true },
    });
    if (!tx) throw DomainError.validation('Transaction not found for this organisation');
    return tx;
  }

  private async orgMemberUserIds(organizationId: string): Promise<string[]> {
    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN', 'MEMBER'] } },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  /** Customer-side recipients: members of the counterparty organisation, only once it ACCEPTED the link. */
  private customerRecipients(invoice: InvoiceWithRelations): Promise<string[]> {
    return linkedCustomerUserIds(this.prisma, invoice.counterparty);
  }

  // ───────────────────────────── CRUD ───────────────────────────────────────

  async create(auth: AuthContext, input: CreateInvoiceInput, req: Request) {
    const membership = await this.orgs.resolveActingOrganizationForWrite(
      auth,
      input.organizationId,
      Permission.INVOICE_MANAGE,
      req,
    );
    const organizationId = membership.organizationId;
    await this.assertCounterparty(organizationId, input.counterpartyId);
    const tx = await this.assertTransaction(organizationId, input.transactionId);
    if (tx && tx.currencyCode !== input.currencyCode) {
      throw DomainError.validation('The invoice currency must match the linked transaction currency');
    }
    const totals = computeDocumentTotals(input.lines, input.taxBps, input.currencyCode);
    const dueDate = parseDay(input.dueDate, 'dueDate');
    const meta = requestMeta(req);
    const created = await retryOnUniqueViolation(() =>
      this.prisma.$transaction(async (db) => {
        const number = await allocateDocumentNumber(db, 'invoice', organizationId);
        const invoice = await db.invoice.create({
          data: {
            organizationId,
            createdByUserId: auth.userId,
            counterpartyId: input.counterpartyId ?? null,
            transactionId: input.transactionId ?? null,
            number,
            customerName: input.customerName,
            customerEmail: input.customerEmail ?? null,
            currencyCode: input.currencyCode,
            dueDate,
            subtotalMinor: totals.subtotalMinor,
            taxBps: input.taxBps,
            taxMinor: totals.taxMinor,
            totalMinor: totals.totalMinor,
            notes: input.notes ?? null,
            lines: { create: totals.lines },
          },
        });
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId,
            action: 'invoice.created',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: {
              number,
              total: minorToDecimalString(totals.totalMinor, input.currencyCode),
              currency: input.currencyCode,
              taxBps: input.taxBps,
              transactionId: input.transactionId ?? null,
              support: membership.via === 'STAFF_SUPPORT',
            },
            ...meta,
          },
          db,
        );
        return invoice;
      }),
    );
    return this.get(auth, created.id);
  }

  async get(auth: AuthContext, id: string) {
    const { invoice, access } = await this.loadFor(auth, id);
    return toInvoiceDto(invoice, access);
  }

  private statusFilter(status: string | undefined): InvoiceStatus[] | undefined {
    if (!status) return undefined;
    const values = status.split(',').map((s) => s.trim().toUpperCase());
    const invalid = values.filter((v) => !INVOICE_STATUSES.has(v));
    if (invalid.length) throw DomainError.validation(`Unknown invoice status: ${invalid.join(', ')}`);
    return values as InvoiceStatus[];
  }

  async list(auth: AuthContext, query: ListBusinessDocumentsQuery) {
    const scope: Prisma.InvoiceWhereInput = {};
    if (query.organizationId) {
      this.orgs.assertMember(auth, query.organizationId, Permission.TRANSACTION_READ);
      // RECEIVED = addressed to the organisation through an ACCEPTED counterparty link only.
      if (query.scope === 'RECEIVED')
        scope.counterparty = { linkedOrganizationId: query.organizationId, linkStatus: 'ACCEPTED' };
      else scope.organizationId = query.organizationId;
    } else if (!isStaff(auth)) {
      const orgIds = auth.memberships.map((m) => m.organizationId);
      if (query.scope === 'RECEIVED')
        scope.counterparty = { linkedOrganizationId: { in: orgIds }, linkStatus: 'ACCEPTED' };
      else scope.organizationId = { in: orgIds };
    }
    const statuses = this.statusFilter(query.status);
    const where: Prisma.InvoiceWhereInput = {
      AND: [
        scope,
        statuses ? { status: { in: statuses } } : {},
        query.search
          ? {
              OR: [
                { number: { contains: query.search, mode: 'insensitive' } },
                { customerName: { contains: query.search, mode: 'insensitive' } },
                { customerEmail: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: invoiceInclude,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return {
      items: items.map((inv) => toInvoiceDto(inv, documentAccessFor(auth, inv) ?? { role: 'STAFF' })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      sandbox: true,
      disclaimer: BUSINESS_DISCLAIMER_FR,
    };
  }

  async update(auth: AuthContext, id: string, input: Partial<CreateInvoiceInput>, req: Request) {
    const { invoice, access } = await this.loadFor(auth, id);
    const actor = await this.assertIssuerManage(auth, invoice, access, req);
    if (invoice.status !== 'DRAFT') {
      throw DomainError.invalidTransition(`Only draft invoices can be edited (current: ${invoice.status})`);
    }
    if (input.counterpartyId !== undefined)
      await this.assertCounterparty(invoice.organizationId, input.counterpartyId);
    const currencyCode = input.currencyCode ?? invoice.currencyCode;
    const tx = await this.assertTransaction(invoice.organizationId, input.transactionId ?? undefined);
    if (tx && tx.currencyCode !== currencyCode) {
      throw DomainError.validation('The invoice currency must match the linked transaction currency');
    }
    const lines: LineItemInput[] =
      input.lines ??
      invoice.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: minorToDecimalString(l.unitPriceMinor, invoice.currencyCode),
      }));
    // The persisted rate is kept exactly when the edit does not resend it (never re-derived from
    // rounded amounts, except for legacy rows — see storedTaxBps).
    const taxBps = input.taxBps ?? storedTaxBps(invoice);
    const totals = computeDocumentTotals(lines, taxBps, currencyCode);
    const dueDate = input.dueDate ? parseDay(input.dueDate, 'dueDate') : undefined;
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await db.invoice.update({
        where: { id },
        data: {
          counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
          transactionId: input.transactionId !== undefined ? input.transactionId : undefined,
          customerName: input.customerName,
          customerEmail: input.customerEmail !== undefined ? input.customerEmail : undefined,
          currencyCode,
          dueDate,
          notes: input.notes !== undefined ? input.notes : undefined,
          subtotalMinor: totals.subtotalMinor,
          taxBps,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          lines: { create: totals.lines },
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: invoice.organizationId,
          action: 'invoice.updated',
          entityType: 'Invoice',
          entityId: id,
          metadata: { fields: Object.keys(input), taxBps, support: actor.via === 'STAFF_SUPPORT' },
          ...meta,
        },
        db,
      );
    });
    return this.get(auth, id);
  }

  // ───────────────────────────── Lifecycle ──────────────────────────────────

  async send(auth: AuthContext, id: string, req: Request) {
    const { invoice, access } = await this.loadFor(auth, id);
    await this.assertIssuerManage(auth, invoice, access, req);
    invoiceMachine.assertTransition(invoice.status, 'SENT');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.invoice.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: invoice.organizationId,
          action: 'invoice.sent',
          entityType: 'Invoice',
          entityId: id,
          metadata: { number: invoice.number, customerEmail: invoice.customerEmail },
          ...meta,
        },
        db,
      );
    });
    // Only a customer organisation that ACCEPTED the link is notified (consent).
    const customers = await this.customerRecipients(invoice);
    if (customers.length) {
      await this.notifications.notifyMany(customers, {
        type: 'invoice.sent',
        title: `Facture ${invoice.number} reçue (sandbox)`,
        body: `${invoice.organization.name} vous a adressé la facture ${invoice.number} de ${minorToDecimalString(invoice.totalMinor, invoice.currencyCode)} ${invoice.currencyCode} (fictifs). ${BUSINESS_DISCLAIMER_FR}.`,
        data: { invoiceId: id, organizationId: invoice.organizationId },
      });
    }
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string, input: CancelDocumentInput, req: Request) {
    const { invoice, access } = await this.loadFor(auth, id);
    await this.assertIssuerManage(auth, invoice, access, req);
    invoiceMachine.assertTransition(invoice.status, 'CANCELLED');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: invoice.organizationId,
          action: 'invoice.cancelled',
          entityType: 'Invoice',
          entityId: id,
          metadata: { number: invoice.number, from: invoice.status, reason: input.reason ?? null },
          ...meta,
        },
        db,
      );
    });
    if (invoice.status !== 'DRAFT') {
      const customers = await this.customerRecipients(invoice);
      if (customers.length) {
        await this.notifications.notifyMany(customers, {
          type: 'invoice.cancelled',
          title: `Facture ${invoice.number} annulée`,
          body: `${invoice.organization.name} a annulé la facture ${invoice.number} (sandbox).`,
          data: { invoiceId: id },
        });
      }
    }
    return this.get(auth, id);
  }

  // ───────────────────────────── Payments ───────────────────────────────────

  /**
   * Applies a payment inside the caller's transaction: creates the InvoicePayment row, recomputes
   * paidMinor and the status (PARTIALLY_PAID / PAID) through the invoice state machine.
   * The invoice row is locked to serialise concurrent payments.
   */
  private async applyPayment(
    db: PrismaTransactionClient,
    invoiceId: string,
    payment: {
      id: string;
      amountMinor: bigint;
      method: 'WALLET_SIMULATED' | 'PROTECT_RELEASE' | 'EXTERNAL_RECORDED';
      reference: string | null;
      ledgerTransactionId: string | null;
      paidAt: Date;
      recordedByUserId: string;
    },
  ) {
    const [locked] = await db.$queryRaw<
      Array<{ id: string; status: InvoiceStatus; paidMinor: bigint; totalMinor: bigint }>
    >`SELECT id, status, "paidMinor", "totalMinor" FROM "Invoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`;
    if (!locked) throw DomainError.notFound('Invoice');
    if (!OPEN_INVOICE_STATUSES.includes(locked.status)) {
      throw DomainError.invalidTransition(
        `Payments can only be recorded on sent invoices (current: ${locked.status})`,
      );
    }
    // Re-checked under the row lock: two concurrent partial payments could otherwise both pass the
    // pre-check and over-pay the invoice (and, for wallet payments, move more money than it is worth).
    const balanceDue = clampNonNegative(BigInt(locked.totalMinor) - BigInt(locked.paidMinor));
    if (payment.amountMinor > balanceDue) {
      throw DomainError.validation('Amount exceeds the balance due', {
        balanceDue: balanceDue.toString(),
        requested: payment.amountMinor.toString(),
      });
    }
    await db.invoicePayment.create({
      data: {
        id: payment.id,
        invoiceId,
        recordedByUserId: payment.recordedByUserId,
        amountMinor: payment.amountMinor,
        method: payment.method,
        reference: payment.reference,
        ledgerTransactionId: payment.ledgerTransactionId,
        paidAt: payment.paidAt,
      },
    });
    const paidMinor = BigInt(locked.paidMinor) + payment.amountMinor;
    const target: InvoiceStatus = paidMinor >= BigInt(locked.totalMinor) ? 'PAID' : 'PARTIALLY_PAID';
    if (target !== locked.status) invoiceMachine.assertTransition(locked.status, target);
    await db.invoice.update({
      where: { id: invoiceId },
      data: { paidMinor, status: target, paidAt: target === 'PAID' ? new Date() : null },
    });
    return { status: target, paidMinor, totalMinor: BigInt(locked.totalMinor), previous: locked.status };
  }

  /**
   * Post-commit effects of a payment (wallet, external or Protect release). The payment is already
   * booked, so this never throws: the `invoice.paid` domain event (partner webhooks) is emitted
   * first, and a notification failure is only logged — it can neither cancel the event nor turn
   * into an error for the caller (who would retry and book a second payment).
   */
  private async afterPayment(
    invoice: InvoiceWithRelations,
    result: { status: InvoiceStatus; paidMinor: bigint },
    payment: { id: string; amountMinor: bigint; method: string; ledgerTransactionId: string | null },
    actorUserId: string | null,
  ) {
    const ccy = invoice.currencyCode;
    if (result.status === 'PAID') {
      const organizationIds = [invoice.organizationId];
      const customerOrganizationId = acceptedLinkedOrganizationId(invoice.counterparty);
      if (customerOrganizationId) organizationIds.push(customerOrganizationId);
      this.bus.emit({
        type: 'invoice.paid',
        organizationIds,
        entityType: 'Invoice',
        entityId: invoice.id,
        payload: {
          invoiceId: invoice.id,
          number: invoice.number,
          organizationId: invoice.organizationId,
          total: minorToDecimalString(invoice.totalMinor, ccy),
          paid: minorToDecimalString(result.paidMinor, ccy),
          currency: ccy,
          transactionId: invoice.transactionId,
          lastPaymentId: payment.id,
          actorUserId,
          simulated: true,
        },
      });
    }
    try {
      const amount = minorToDecimalString(payment.amountMinor, ccy);
      const title =
        result.status === 'PAID'
          ? `Facture ${invoice.number} payée (fictif)`
          : `Paiement partiel sur ${invoice.number} (fictif)`;
      const body = `${amount} ${ccy} fictifs enregistrés (${payment.method}) sur la facture ${invoice.number}. Solde dû : ${minorToDecimalString(clampNonNegative(invoice.totalMinor - result.paidMinor), ccy)} ${ccy}. ${BUSINESS_DISCLAIMER_FR}.`;
      const recipients = await this.orgMemberUserIds(invoice.organizationId);
      recipients.push(...(await this.customerRecipients(invoice)));
      await this.notifications.notifyMany(recipients, {
        type: result.status === 'PAID' ? 'invoice.paid' : 'invoice.payment_recorded',
        title,
        body,
        data: { invoiceId: invoice.id, paymentId: payment.id, organizationId: invoice.organizationId },
      });
    } catch (err) {
      this.logger.error(
        `notifications after payment ${payment.id} (${payment.method}) on invoice ${invoice.id} failed: ${String(err)}`,
      );
    }
  }

  async recordPayment(auth: AuthContext, id: string, input: RecordInvoicePaymentInput, req: Request) {
    const { invoice, access } = await this.loadFor(auth, id);
    if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) {
      throw DomainError.invalidTransition(
        `Payments can only be recorded on sent invoices (current: ${invoice.status})`,
      );
    }
    const ccy = invoice.currencyCode;
    let amountMinor: bigint;
    try {
      amountMinor = parseDecimalToMinor(input.amount, ccy);
    } catch (err) {
      throw DomainError.validation(err instanceof Error ? err.message : 'Invalid amount');
    }
    if (amountMinor <= 0n) throw DomainError.validation('Amount must be greater than zero');
    const remaining = clampNonNegative(invoice.totalMinor - invoice.paidMinor);
    if (amountMinor > remaining) {
      throw DomainError.validation('Amount exceeds the balance due', {
        balanceDue: moneyDto(remaining, ccy),
        requested: moneyDto(amountMinor, ccy),
      });
    }
    const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const paymentId = randomUUID();
    const meta = requestMeta(req);

    if (input.method === 'PROTECT_RELEASE') {
      throw DomainError.validation(
        'PROTECT_RELEASE payments are recorded automatically when a linked Protect milestone is released',
      );
    }

    if (input.method === 'EXTERNAL_RECORDED') {
      const actor = await this.assertIssuerManage(auth, invoice, access, req);
      const result = await this.prisma.$transaction(async (db) => {
        const applied = await this.applyPayment(db, id, {
          id: paymentId,
          amountMinor,
          method: 'EXTERNAL_RECORDED',
          reference: input.reference ?? null,
          ledgerTransactionId: null,
          paidAt,
          recordedByUserId: auth.userId,
        });
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: invoice.organizationId,
            action: 'invoice.payment_recorded',
            entityType: 'InvoicePayment',
            entityId: paymentId,
            metadata: {
              invoiceId: id,
              method: 'EXTERNAL_RECORDED',
              amount: minorToDecimalString(amountMinor, ccy),
              currency: ccy,
              reference: input.reference ?? null,
              status: applied.status,
              support: actor.via === 'STAFF_SUPPORT',
            },
            ...meta,
          },
          db,
        );
        return applied;
      });
      await this.afterPayment(
        invoice,
        result,
        { id: paymentId, amountMinor, method: 'EXTERNAL_RECORDED', ledgerTransactionId: null },
        auth.userId,
      );
      return this.get(auth, id);
    }

    // WALLET_SIMULATED: the customer pays from the wallet of the organisation linked to the counterparty
    // — only once that organisation ACCEPTED the link (a pending request never enables a payment).
    const linked = acceptedLinkedOrganizationId(invoice.counterparty);
    const payerOrgId = input.organizationId ?? linked ?? undefined;
    const payerMembership = payerOrgId ? membershipFor(auth, payerOrgId) : undefined;
    if (!linked || !payerOrgId || payerOrgId !== linked || !payerMembership) {
      throw new DomainError(
        'WALLET_PAYMENT_NOT_AVAILABLE',
        'Wallet payment is only available when the invoice customer is linked to one of your organisations',
        HttpStatus.CONFLICT,
        { linkedOrganizationId: linked },
      );
    }
    if (!orgRoleHas(payerMembership.role, Permission.TRANSFER_CREATE)) {
      throw DomainError.forbidden(`Your role (${payerMembership.role}) does not allow wallet payments`);
    }
    if (payerOrgId === invoice.organizationId) {
      throw DomainError.conflict('An organisation cannot pay its own invoice from its wallet');
    }
    const idempotencyKey = `invoice-payment:${paymentId}`;
    const result = await this.prisma.$transaction(async (db) => {
      const payerWallet = await this.wallets.ensureWallet(payerOrgId, ccy, db);
      const issuerWallet = await this.wallets.ensureWallet(invoice.organizationId, ccy, db);
      const posted = await this.ledger.post(
        {
          idempotencyKey,
          kind: 'ADJUSTMENT',
          description: `Invoice ${invoice.number} paid from wallet by ${payerMembership.organizationName} (simulated — no real funds)`,
          reference: invoice.id,
          metadata: {
            purpose: 'INVOICE_PAYMENT',
            invoiceId: invoice.id,
            paymentId,
            payerOrganizationId: payerOrgId,
            issuerOrganizationId: invoice.organizationId,
            by: auth.userId,
            simulated: true,
          },
          entries: [
            { accountId: payerWallet.ledgerAccountId, direction: 'DEBIT', amountMinor, currencyCode: ccy },
            { accountId: issuerWallet.ledgerAccountId, direction: 'CREDIT', amountMinor, currencyCode: ccy },
          ],
        },
        db,
      );
      const applied = await this.applyPayment(db, id, {
        id: paymentId,
        amountMinor,
        method: 'WALLET_SIMULATED',
        reference: input.reference ?? posted.id,
        ledgerTransactionId: posted.id,
        paidAt,
        recordedByUserId: auth.userId,
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: payerOrgId,
          action: 'invoice.paid_from_wallet',
          entityType: 'InvoicePayment',
          entityId: paymentId,
          metadata: {
            invoiceId: id,
            issuerOrganizationId: invoice.organizationId,
            amount: minorToDecimalString(amountMinor, ccy),
            currency: ccy,
            ledgerTransactionId: posted.id,
            idempotencyKey,
            status: applied.status,
            simulated: true,
          },
          ...meta,
        },
        db,
      );
      return { ...applied, ledgerTransactionId: posted.id };
    });
    // The payment is committed: a notification failure is logged, never returned as an error
    // (the payer would retry and book a second payment).
    try {
      await this.notifications.notify({
        userId: auth.userId,
        type: 'invoice.wallet_payment_sent',
        title: `Paiement fictif envoyé — ${invoice.number}`,
        body: `${minorToDecimalString(amountMinor, ccy)} ${ccy} fictifs ont été débités du portefeuille ${payerMembership.organizationName} pour la facture ${invoice.number}. ${BUSINESS_DISCLAIMER_FR}.`,
        data: { invoiceId: id, paymentId, ledgerTransactionId: result.ledgerTransactionId },
      });
    } catch (err) {
      this.logger.error(`payer notification after wallet payment ${paymentId} failed: ${String(err)}`);
    }
    // Never throws: emits invoice.paid, then notifies (a notification failure is logged).
    await this.afterPayment(
      invoice,
      result,
      {
        id: paymentId,
        amountMinor,
        method: 'WALLET_SIMULATED',
        ledgerTransactionId: result.ledgerTransactionId,
      },
      auth.userId,
    );
    // Post-commit AML evaluation (structuring across wallet payments). The payment is already
    // booked: an evaluation failure is logged, never turned into an error for the payer.
    try {
      await this.risk.evaluateAndRecord({
        event: 'invoice.wallet_payment',
        userId: auth.userId,
        organizationId: payerOrgId,
        amountMinor,
        currencyCode: ccy,
        operationReference: paymentId,
      });
    } catch (err) {
      this.logger.error(`risk evaluation after wallet payment ${paymentId} failed: ${String(err)}`);
    }
    return this.get(auth, id);
  }

  // ───────────────────────────── Protect integration ────────────────────────

  private async onDomainEvent(event: DomainEvent) {
    if (event.type !== 'milestone.released') return;
    try {
      await this.recordProtectRelease(event.payload);
    } catch (err) {
      this.logger.error(
        `protect release → invoice payment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * A released Protect milestone pays the open invoice(s) linked to the transaction. Idempotent on
   * the ledger transaction id of the release (stored as the payment reference).
   */
  async recordProtectRelease(payload: Record<string, unknown>) {
    const transactionId = typeof payload.transactionId === 'string' ? payload.transactionId : null;
    const ledgerTransactionId =
      typeof payload.ledgerTransactionId === 'string' ? payload.ledgerTransactionId : null;
    const amount = typeof payload.amount === 'string' ? payload.amount : null;
    const currency = typeof payload.currency === 'string' ? payload.currency : null;
    const actorUserId = typeof payload.actorUserId === 'string' ? payload.actorUserId : null;
    if (!transactionId || !ledgerTransactionId || !amount || !currency) return { applied: 0 };
    const releasedMinor = parseDecimalToMinor(amount, currency);
    if (releasedMinor <= 0n) return { applied: 0 };

    const candidates = await this.prisma.invoice.findMany({
      where: { transactionId, status: { in: ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] }, currencyCode: currency },
      include: invoiceInclude,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    let remaining = releasedMinor;
    let applied = 0;
    for (const invoice of candidates) {
      if (remaining <= 0n) break;
      const balance = clampNonNegative(invoice.totalMinor - invoice.paidMinor);
      // Never over-record an invoice: the applied amount is capped at its balance due. Any excess of
      // the release stays on the seller's wallet (already credited by the ledger) and is reported
      // as `unapplied` in the audit trail instead of inflating receivables.
      const amountMinor = remaining < balance ? remaining : balance;
      if (amountMinor <= 0n) continue;
      const paymentId = randomUUID();
      const result = await this.prisma.$transaction(async (db) => {
        const existing = await db.invoicePayment.findFirst({
          where: { invoiceId: invoice.id, method: 'PROTECT_RELEASE', reference: ledgerTransactionId },
        });
        if (existing) return null;
        const appliedPayment = await this.applyPayment(db, invoice.id, {
          id: paymentId,
          amountMinor,
          method: 'PROTECT_RELEASE',
          reference: ledgerTransactionId,
          ledgerTransactionId,
          paidAt: new Date(),
          recordedByUserId: actorUserId ?? invoice.createdByUserId,
        });
        await this.audit.log(
          {
            actorUserId,
            organizationId: invoice.organizationId,
            action: 'invoice.protect_release_applied',
            entityType: 'InvoicePayment',
            entityId: paymentId,
            metadata: {
              invoiceId: invoice.id,
              transactionId,
              ledgerTransactionId,
              amount: minorToDecimalString(amountMinor, currency),
              currency,
              status: appliedPayment.status,
              simulated: true,
            },
          },
          db,
        );
        return appliedPayment;
      });
      if (!result) continue;
      applied++;
      remaining -= amountMinor;
      await this.afterPayment(
        invoice,
        result,
        { id: paymentId, amountMinor, method: 'PROTECT_RELEASE', ledgerTransactionId },
        actorUserId,
      );
    }
    if (applied > 0 && remaining > 0n) {
      await this.audit.log({
        actorUserId,
        organizationId: candidates[0]!.organizationId,
        action: 'invoice.protect_release_unapplied',
        entityType: 'Transaction',
        entityId: transactionId,
        metadata: {
          ledgerTransactionId,
          unapplied: minorToDecimalString(remaining, currency),
          currency,
          reason: 'Release exceeds the balance due of the open invoices; excess stays on the wallet',
          simulated: true,
        },
      });
    }
    return { applied, unappliedMinor: remaining };
  }

  // ───────────────────────────── Maintenance job ────────────────────────────

  /** SENT / PARTIALLY_PAID invoices whose due date has passed become OVERDUE; the issuer is notified. */
  async markOverdue(): Promise<JobResult> {
    const today = startOfUtcDay();
    const due = await this.prisma.invoice.findMany({
      where: { status: { in: ['SENT', 'PARTIALLY_PAID'] }, dueDate: { lt: today } },
      include: invoiceInclude,
      orderBy: { dueDate: 'asc' },
    });
    const overdueIds: string[] = [];
    for (const invoice of due) {
      invoiceMachine.assertTransition(invoice.status, 'OVERDUE');
      await this.prisma.$transaction(async (db) => {
        const r = await db.invoice.updateMany({
          where: { id: invoice.id, status: invoice.status },
          data: { status: 'OVERDUE' },
        });
        if (r.count === 0) return;
        overdueIds.push(invoice.id);
        await this.audit.log(
          {
            actorUserId: null,
            organizationId: invoice.organizationId,
            action: 'invoice.overdue',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: {
              number: invoice.number,
              from: invoice.status,
              dueDate: invoice.dueDate.toISOString(),
            },
          },
          db,
        );
      });
      if (!overdueIds.includes(invoice.id)) continue;
      await this.notifications.notifyMany(await this.orgMemberUserIds(invoice.organizationId), {
        type: 'invoice.overdue',
        title: `Facture ${invoice.number} en retard`,
        body: `La facture ${invoice.number} (${invoice.customerName}) était due le ${invoice.dueDate.toISOString().slice(0, 10)} et reste impayée : ${minorToDecimalString(clampNonNegative(invoice.totalMinor - invoice.paidMinor), invoice.currencyCode)} ${invoice.currencyCode} (fictifs).`,
        data: { invoiceId: invoice.id, organizationId: invoice.organizationId },
      });
    }
    return { summary: { checked: due.length, overdue: overdueIds.length, invoiceIds: overdueIds } };
  }

  // ───────────────────────────── Documents & exports ────────────────────────

  async document(auth: AuthContext, id: string) {
    const { invoice, access } = await this.loadFor(auth, id);
    const dto = toInvoiceDto(invoice, access);
    return printableDocument({
      kind: 'INVOICE',
      number: dto.number,
      status: dto.status,
      issuer: dto.issuer,
      customerName: dto.customerName,
      customerEmail: dto.customerEmail,
      currencyCode: dto.currencyCode,
      dates: [
        { label: 'Date d’émission / Issue date', value: invoice.issueDate },
        { label: 'Échéance / Due date', value: invoice.dueDate },
        { label: 'Payée le / Paid on', value: invoice.paidAt },
      ],
      lines: dto.lines,
      subtotal: dto.subtotal,
      tax: dto.tax,
      taxBps: dto.taxBps,
      total: dto.total,
      paid: dto.paid,
      balanceDue: dto.balanceDue,
      notes: dto.notes,
      reference: invoice.transaction?.reference ?? null,
    });
  }

  static readonly CSV_HEADER =
    'number,status,customer_name,customer_email,currency,issue_date,due_date,subtotal,tax,total,paid,balance_due,transaction_reference,quote_number,sent_at,paid_at,cancelled_at';

  /** CSV export of every invoice issued by the organisation (sandbox disclaimer on the first line). */
  async csv(auth: AuthContext, organizationId: string) {
    this.orgs.assertMember(auth, organizationId, Permission.TRANSACTION_READ);
    const invoices = await this.prisma.invoice.findMany({
      where: { organizationId },
      include: invoiceInclude,
      orderBy: { number: 'asc' },
    });
    const rows = invoices.map((inv) =>
      csvLine([
        inv.number,
        inv.status,
        inv.customerName,
        inv.customerEmail ?? '',
        inv.currencyCode,
        inv.issueDate.toISOString().slice(0, 10),
        inv.dueDate.toISOString().slice(0, 10),
        minorToDecimalString(inv.subtotalMinor, inv.currencyCode),
        minorToDecimalString(inv.taxMinor, inv.currencyCode),
        minorToDecimalString(inv.totalMinor, inv.currencyCode),
        minorToDecimalString(inv.paidMinor, inv.currencyCode),
        minorToDecimalString(clampNonNegative(inv.totalMinor - inv.paidMinor), inv.currencyCode),
        inv.transaction?.reference ?? '',
        inv.quote?.number ?? '',
        inv.sentAt?.toISOString() ?? '',
        inv.paidAt?.toISOString() ?? '',
        inv.cancelledAt?.toISOString() ?? '',
      ]),
    );
    return [
      `# Diaspora Trust — SANDBOX invoices. ${BUSINESS_DISCLAIMER_FR}`,
      InvoicesService.CSV_HEADER,
      ...rows,
    ].join('\n');
  }
}
