import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma, PrismaTransactionClient, QuoteStatus } from '@dfn/database';
import {
  Permission,
  QuoteStatus as QuoteStatusEnum,
  minorToDecimalString,
  quoteMachine,
  type CancelDocumentInput,
  type ConvertQuoteInput,
  type CreateQuoteInput,
  type LineItemInput,
  type ListBusinessDocumentsQuery,
  type QuoteDecisionInput,
} from '@dfn/shared';
import { isStaff, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrganizationsService } from '../organizations/organizations.service';
import {
  documentAccessFor,
  invoiceInclude,
  printableDocument,
  quoteInclude,
  toInvoiceDto,
  toQuoteDto,
  type DocumentAccess,
  type QuoteWithRelations,
} from './business.dto';
import {
  BUSINESS_DISCLAIMER_FR,
  addDays,
  allocateDocumentNumber,
  computeDocumentTotals,
  deriveTaxBps,
  parseDay,
  retryOnUniqueViolation,
  startOfUtcDay,
} from './business.utils';

const QUOTE_STATUSES = new Set<string>(Object.values(QuoteStatusEnum));
/** Quotes still awaiting a decision expire lazily once their validity date has passed. */
const EXPIRABLE: QuoteStatus[] = ['DRAFT', 'SENT', 'ACCEPTED'];

/**
 * Diaspora Business — quotes (QUO-<year>-<0001>). Acceptance / decline are recorded by the issuer
 * on behalf of the customer; an accepted quote converts into a draft invoice copying its lines.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orgs: OrganizationsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ───────────────────────────── Loading & access ───────────────────────────

  async load(
    id: string,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ): Promise<QuoteWithRelations> {
    const quote = await db.quote.findUnique({ where: { id }, include: quoteInclude });
    if (!quote) throw DomainError.notFound('Quote');
    return quote;
  }

  /** Cross-tenant access yields 404; expired quotes are flagged on read (lazy expiry). */
  async loadFor(auth: AuthContext, id: string) {
    let quote = await this.load(id);
    const access = documentAccessFor(auth, quote);
    if (!access) throw DomainError.notFound('Quote');
    if (EXPIRABLE.includes(quote.status) && quote.validUntil < startOfUtcDay()) {
      await this.prisma.quote.updateMany({
        where: { id, status: { in: EXPIRABLE } },
        data: { status: 'EXPIRED' },
      });
      await this.audit.log({
        actorUserId: null,
        organizationId: quote.organizationId,
        action: 'quote.expired',
        entityType: 'Quote',
        entityId: id,
        metadata: { number: quote.number, from: quote.status, validUntil: quote.validUntil.toISOString() },
      });
      quote = await this.load(id);
    }
    return { quote, access };
  }

  private assertIssuerManage(auth: AuthContext, quote: QuoteWithRelations, access: DocumentAccess) {
    if (access.role === 'CUSTOMER') throw DomainError.forbidden('Only the issuing organisation can do this');
    return this.orgs.assertMember(auth, quote.organizationId, Permission.INVOICE_MANAGE);
  }

  private async assertCounterparty(organizationId: string, counterpartyId: string | undefined) {
    if (!counterpartyId) return null;
    const cp = await this.prisma.counterparty.findFirst({ where: { id: counterpartyId, organizationId } });
    if (!cp) throw DomainError.validation('Counterparty does not belong to this organisation');
    return cp;
  }

  private async customerUserId(email: string | null): Promise<string | null> {
    if (!email) return null;
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
    return user && user.status === 'ACTIVE' ? user.id : null;
  }

  // ───────────────────────────── CRUD ───────────────────────────────────────

  async create(auth: AuthContext, input: CreateQuoteInput, req: Request) {
    const membership = this.orgs.resolveActingOrganization(
      auth,
      input.organizationId,
      Permission.INVOICE_MANAGE,
    );
    const organizationId = membership.organizationId;
    await this.assertCounterparty(organizationId, input.counterpartyId);
    const totals = computeDocumentTotals(input.lines, input.taxBps, input.currencyCode);
    const validUntil = parseDay(input.validUntil, 'validUntil');
    if (validUntil < startOfUtcDay()) throw DomainError.validation('validUntil must be today or later');
    const meta = requestMeta(req);
    const created = await retryOnUniqueViolation(() =>
      this.prisma.$transaction(async (db) => {
        const number = await allocateDocumentNumber(db, 'quote', organizationId);
        const quote = await db.quote.create({
          data: {
            organizationId,
            createdByUserId: auth.userId,
            counterpartyId: input.counterpartyId ?? null,
            number,
            customerName: input.customerName,
            customerEmail: input.customerEmail ?? null,
            currencyCode: input.currencyCode,
            validUntil,
            subtotalMinor: totals.subtotalMinor,
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
            action: 'quote.created',
            entityType: 'Quote',
            entityId: quote.id,
            metadata: {
              number,
              total: minorToDecimalString(totals.totalMinor, input.currencyCode),
              currency: input.currencyCode,
            },
            ...meta,
          },
          db,
        );
        return quote;
      }),
    );
    return this.get(auth, created.id);
  }

  async get(auth: AuthContext, id: string) {
    const { quote, access } = await this.loadFor(auth, id);
    return toQuoteDto(quote, access);
  }

  private statusFilter(status: string | undefined): QuoteStatus[] | undefined {
    if (!status) return undefined;
    const values = status.split(',').map((s) => s.trim().toUpperCase());
    const invalid = values.filter((v) => !QUOTE_STATUSES.has(v));
    if (invalid.length) throw DomainError.validation(`Unknown quote status: ${invalid.join(', ')}`);
    return values as QuoteStatus[];
  }

  async list(auth: AuthContext, query: ListBusinessDocumentsQuery) {
    const scope: Prisma.QuoteWhereInput = {};
    if (query.organizationId) {
      this.orgs.assertMember(auth, query.organizationId, Permission.TRANSACTION_READ);
      if (query.scope === 'RECEIVED') scope.counterparty = { linkedOrganizationId: query.organizationId };
      else scope.organizationId = query.organizationId;
    } else if (!isStaff(auth)) {
      const orgIds = auth.memberships.map((m) => m.organizationId);
      if (query.scope === 'RECEIVED') scope.counterparty = { linkedOrganizationId: { in: orgIds } };
      else scope.organizationId = { in: orgIds };
    }
    // Lazy expiry for the listed scope, so pipelines never show stale "SENT" quotes.
    await this.prisma.quote.updateMany({
      where: { ...scope, status: { in: EXPIRABLE }, validUntil: { lt: startOfUtcDay() } },
      data: { status: 'EXPIRED' },
    });
    const statuses = this.statusFilter(query.status);
    const where: Prisma.QuoteWhereInput = {
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
      this.prisma.quote.findMany({
        where,
        include: quoteInclude,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.quote.count({ where }),
    ]);
    return {
      items: items.map((q) => toQuoteDto(q, documentAccessFor(auth, q) ?? { role: 'STAFF' })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      sandbox: true,
      disclaimer: BUSINESS_DISCLAIMER_FR,
    };
  }

  async update(auth: AuthContext, id: string, input: Partial<CreateQuoteInput>, req: Request) {
    const { quote, access } = await this.loadFor(auth, id);
    this.assertIssuerManage(auth, quote, access);
    if (quote.status !== 'DRAFT') {
      throw DomainError.invalidTransition(`Only draft quotes can be edited (current: ${quote.status})`);
    }
    if (input.counterpartyId !== undefined)
      await this.assertCounterparty(quote.organizationId, input.counterpartyId);
    const currencyCode = input.currencyCode ?? quote.currencyCode;
    const lines: LineItemInput[] =
      input.lines ??
      quote.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: minorToDecimalString(l.unitPriceMinor, quote.currencyCode),
      }));
    const taxBps = input.taxBps ?? deriveTaxBps(quote.subtotalMinor, quote.taxMinor);
    const totals = computeDocumentTotals(lines, taxBps, currencyCode);
    const validUntil = input.validUntil ? parseDay(input.validUntil, 'validUntil') : undefined;
    if (validUntil && validUntil < startOfUtcDay())
      throw DomainError.validation('validUntil must be today or later');
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.quoteLine.deleteMany({ where: { quoteId: id } });
      await db.quote.update({
        where: { id },
        data: {
          counterpartyId: input.counterpartyId !== undefined ? input.counterpartyId : undefined,
          customerName: input.customerName,
          customerEmail: input.customerEmail !== undefined ? input.customerEmail : undefined,
          currencyCode,
          validUntil,
          notes: input.notes !== undefined ? input.notes : undefined,
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          lines: { create: totals.lines },
        },
      });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: quote.organizationId,
          action: 'quote.updated',
          entityType: 'Quote',
          entityId: id,
          metadata: { fields: Object.keys(input) },
          ...meta,
        },
        db,
      );
    });
    return this.get(auth, id);
  }

  // ───────────────────────────── Lifecycle ──────────────────────────────────

  private async transition(
    auth: AuthContext,
    id: string,
    target: QuoteStatus,
    action: string,
    data: Prisma.QuoteUpdateInput,
    metadata: Record<string, unknown>,
    req: Request,
  ) {
    const { quote, access } = await this.loadFor(auth, id);
    this.assertIssuerManage(auth, quote, access);
    quoteMachine.assertTransition(quote.status, target);
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.quote.update({ where: { id }, data: { status: target, ...data } });
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: quote.organizationId,
          action,
          entityType: 'Quote',
          entityId: id,
          metadata: { number: quote.number, from: quote.status, ...metadata },
          ...meta,
        },
        db,
      );
    });
    return quote;
  }

  async send(auth: AuthContext, id: string, req: Request) {
    const quote = await this.transition(auth, id, 'SENT', 'quote.sent', { sentAt: new Date() }, {}, req);
    const customerId = await this.customerUserId(quote.customerEmail);
    if (customerId) {
      await this.notifications.notify({
        userId: customerId,
        type: 'quote.sent',
        title: `Devis ${quote.number} reçu (sandbox)`,
        body: `${quote.organization.name} vous a adressé le devis ${quote.number} de ${minorToDecimalString(quote.totalMinor, quote.currencyCode)} ${quote.currencyCode} (fictifs), valable jusqu’au ${quote.validUntil.toISOString().slice(0, 10)}. ${BUSINESS_DISCLAIMER_FR}.`,
        data: { quoteId: id, organizationId: quote.organizationId },
      });
    }
    return this.get(auth, id);
  }

  /** Recorded by the issuer on behalf of the customer (sandbox: no customer portal yet). */
  async accept(auth: AuthContext, id: string, input: QuoteDecisionInput, req: Request) {
    await this.transition(
      auth,
      id,
      'ACCEPTED',
      'quote.accepted',
      { acceptedAt: new Date() },
      { note: input.note ?? null },
      req,
    );
    return this.get(auth, id);
  }

  async decline(auth: AuthContext, id: string, input: CancelDocumentInput, req: Request) {
    await this.transition(
      auth,
      id,
      'DECLINED',
      'quote.declined',
      { declinedAt: new Date() },
      { reason: input.reason ?? null },
      req,
    );
    return this.get(auth, id);
  }

  /** ACCEPTED → CONVERTED: creates a DRAFT invoice copying the lines; Protect conversion is not available. */
  async convert(auth: AuthContext, id: string, input: ConvertQuoteInput, req: Request) {
    const { quote, access } = await this.loadFor(auth, id);
    this.assertIssuerManage(auth, quote, access);
    if (input.target === 'PROTECT_TRANSACTION') {
      throw new DomainError(
        'NOT_AVAILABLE',
        'Converting a quote into a Diaspora Protect transaction is not available yet: Protect transactions are buyer-initiated in this sandbox, and seller-initiated transactions require a schema change. Convert the quote into an invoice instead.',
        HttpStatus.BAD_REQUEST,
        { target: input.target },
      );
    }
    quoteMachine.assertTransition(quote.status, 'CONVERTED');
    const dueDate = input.dueDate ? parseDay(input.dueDate, 'dueDate') : addDays(startOfUtcDay(), 30);
    const meta = requestMeta(req);
    const invoiceId = await retryOnUniqueViolation(() =>
      this.prisma.$transaction(async (db) => {
        const number = await allocateDocumentNumber(db, 'invoice', quote.organizationId);
        const invoice = await db.invoice.create({
          data: {
            organizationId: quote.organizationId,
            createdByUserId: auth.userId,
            counterpartyId: quote.counterpartyId,
            quoteId: quote.id,
            number,
            customerName: quote.customerName,
            customerEmail: quote.customerEmail,
            currencyCode: quote.currencyCode,
            dueDate,
            subtotalMinor: quote.subtotalMinor,
            taxMinor: quote.taxMinor,
            totalMinor: quote.totalMinor,
            notes: quote.notes,
            lines: {
              create: quote.lines.map((l) => ({
                position: l.position,
                description: l.description,
                quantity: l.quantity,
                unitPriceMinor: l.unitPriceMinor,
                totalMinor: l.totalMinor,
              })),
            },
          },
        });
        await db.quote.update({ where: { id }, data: { status: 'CONVERTED' } });
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: quote.organizationId,
            action: 'quote.converted',
            entityType: 'Quote',
            entityId: id,
            metadata: {
              number: quote.number,
              target: 'INVOICE',
              invoiceId: invoice.id,
              invoiceNumber: number,
            },
            ...meta,
          },
          db,
        );
        await this.audit.log(
          {
            actorUserId: auth.userId,
            organizationId: quote.organizationId,
            action: 'invoice.created',
            entityType: 'Invoice',
            entityId: invoice.id,
            metadata: {
              number,
              fromQuoteId: id,
              total: minorToDecimalString(quote.totalMinor, quote.currencyCode),
              currency: quote.currencyCode,
            },
            ...meta,
          },
          db,
        );
        return invoice.id;
      }),
    );
    const invoice = await this.prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: invoiceInclude,
    });
    const quoteAfter = await this.load(id);
    return {
      quote: toQuoteDto(quoteAfter, access),
      invoice: toInvoiceDto(invoice, documentAccessFor(auth, invoice) ?? access),
    };
  }

  // ───────────────────────────── Documents ──────────────────────────────────

  async document(auth: AuthContext, id: string) {
    const { quote, access } = await this.loadFor(auth, id);
    const dto = toQuoteDto(quote, access);
    return printableDocument({
      kind: 'QUOTE',
      number: dto.number,
      status: dto.status,
      issuer: dto.issuer,
      customerName: dto.customerName,
      customerEmail: dto.customerEmail,
      currencyCode: dto.currencyCode,
      dates: [
        { label: 'Date / Date', value: quote.createdAt },
        { label: 'Valable jusqu’au / Valid until', value: quote.validUntil },
        { label: 'Accepté le / Accepted on', value: quote.acceptedAt },
      ],
      lines: dto.lines,
      subtotal: dto.subtotal,
      tax: dto.tax,
      taxBps: dto.taxBps,
      total: dto.total,
      notes: dto.notes,
    });
  }
}
