import type { OrgRole, Prisma } from '@dfn/database';
import { Permission, orgRoleHas } from '@dfn/shared';
import { isStaff, membershipFor, type AuthContext, type AuthMembership } from '../../common/auth-context';
import { moneyDto } from '../../common/serialize';
import { BUSINESS_DISCLAIMER_FR, clampNonNegative, deriveTaxBps } from './business.utils';

// ───────────────────────────── Prisma includes ──────────────────────────────

export const invoiceInclude = {
  lines: { orderBy: { position: 'asc' as const } },
  payments: {
    orderBy: { paidAt: 'asc' as const },
    include: { recordedBy: { select: { id: true, firstName: true, lastName: true } } },
  },
  counterparty: { select: { id: true, name: true, email: true, linkedOrganizationId: true } },
  organization: {
    select: { id: true, name: true, legalName: true, registrationNumber: true, country: true },
  },
  transaction: { select: { id: true, reference: true, title: true, status: true } },
  quote: { select: { id: true, number: true } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceWithRelations = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

export const quoteInclude = {
  lines: { orderBy: { position: 'asc' as const } },
  counterparty: { select: { id: true, name: true, email: true, linkedOrganizationId: true } },
  organization: {
    select: { id: true, name: true, legalName: true, registrationNumber: true, country: true },
  },
  invoice: { select: { id: true, number: true, status: true } },
} satisfies Prisma.QuoteInclude;
export type QuoteWithRelations = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;

// ───────────────────────────── Access ───────────────────────────────────────

/** ISSUER = member of the issuing organisation; CUSTOMER = member of the linked counterparty org. */
export type DocumentRole = 'ISSUER' | 'CUSTOMER' | 'STAFF';

export interface DocumentAccess {
  role: DocumentRole;
  membership?: AuthMembership;
}

/** Resolves how the caller relates to a document; null means it must not even be revealed (404). */
export function documentAccessFor(
  auth: AuthContext,
  doc: { organizationId: string; counterparty?: { linkedOrganizationId: string | null } | null },
): DocumentAccess | null {
  const issuer = membershipFor(auth, doc.organizationId);
  if (issuer) return { role: 'ISSUER', membership: issuer };
  const linked = doc.counterparty?.linkedOrganizationId ?? null;
  const customer = linked ? membershipFor(auth, linked) : undefined;
  if (customer) return { role: 'CUSTOMER', membership: customer };
  if (isStaff(auth)) return { role: 'STAFF' };
  return null;
}

const OPEN_INVOICE_STATES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;
export const OPEN_INVOICE_STATUSES: readonly string[] = OPEN_INVOICE_STATES;

function canManage(access: DocumentAccess): boolean {
  if (access.role === 'STAFF') return true;
  return (
    access.role === 'ISSUER' && orgRoleHas(access.membership!.role as OrgRole, Permission.INVOICE_MANAGE)
  );
}

export function invoiceNextActions(inv: InvoiceWithRelations, access: DocumentAccess): string[] {
  const actions: string[] = [];
  const open = OPEN_INVOICE_STATUSES.includes(inv.status);
  if (canManage(access)) {
    if (inv.status === 'DRAFT') actions.push('EDIT', 'SEND', 'CANCEL');
    if (open) actions.push('RECORD_PAYMENT', 'CANCEL');
  }
  if (
    access.role === 'CUSTOMER' &&
    open &&
    orgRoleHas(access.membership!.role as OrgRole, Permission.TRANSFER_CREATE)
  ) {
    actions.push('PAY_WALLET');
  }
  actions.push('VIEW_DOCUMENT');
  return actions;
}

export function quoteNextActions(quote: QuoteWithRelations, access: DocumentAccess): string[] {
  const actions: string[] = [];
  if (canManage(access)) {
    if (quote.status === 'DRAFT') actions.push('EDIT', 'SEND', 'DECLINE');
    if (quote.status === 'SENT') actions.push('ACCEPT', 'DECLINE');
    if (quote.status === 'ACCEPTED') actions.push('CONVERT_INVOICE');
  }
  actions.push('VIEW_DOCUMENT');
  return actions;
}

// ───────────────────────────── DTOs ─────────────────────────────────────────

function lineDto(
  line: {
    id: string;
    position: number;
    description: string;
    quantity: number;
    unitPriceMinor: bigint;
    totalMinor: bigint;
  },
  ccy: string,
) {
  return {
    id: line.id,
    position: line.position,
    description: line.description,
    quantity: line.quantity,
    unitPrice: moneyDto(line.unitPriceMinor, ccy),
    total: moneyDto(line.totalMinor, ccy),
  };
}

function issuerDto(org: InvoiceWithRelations['organization']) {
  return {
    id: org.id,
    name: org.name,
    legalName: org.legalName,
    registrationNumber: org.registrationNumber,
    country: org.country,
  };
}

export function toInvoiceDto(inv: InvoiceWithRelations, access: DocumentAccess) {
  const ccy = inv.currencyCode;
  const balanceDueMinor = clampNonNegative(inv.totalMinor - inv.paidMinor);
  return {
    id: inv.id,
    organizationId: inv.organizationId,
    number: inv.number,
    status: inv.status,
    customerName: inv.customerName,
    customerEmail: inv.customerEmail,
    counterparty: inv.counterparty,
    issuer: issuerDto(inv.organization),
    transaction: inv.transaction,
    transactionId: inv.transactionId,
    quote: inv.quote,
    quoteId: inv.quoteId,
    currencyCode: ccy,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: moneyDto(inv.subtotalMinor, ccy),
    tax: moneyDto(inv.taxMinor, ccy),
    taxBps: deriveTaxBps(inv.subtotalMinor, inv.taxMinor),
    total: moneyDto(inv.totalMinor, ccy),
    paid: moneyDto(inv.paidMinor, ccy),
    balanceDue: moneyDto(balanceDueMinor, ccy),
    notes: inv.notes,
    lines: inv.lines.map((l) => lineDto(l, ccy)),
    payments: inv.payments.map((p) => ({
      id: p.id,
      amount: moneyDto(p.amountMinor, ccy),
      method: p.method,
      reference: p.reference,
      ledgerTransactionId: p.ledgerTransactionId,
      paidAt: p.paidAt,
      recordedBy: p.recordedBy,
      createdAt: p.createdAt,
      simulated: true,
    })),
    myRole: access.role,
    nextActions: invoiceNextActions(inv, access),
    sentAt: inv.sentAt,
    paidAt: inv.paidAt,
    cancelledAt: inv.cancelledAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
    sandbox: true,
    disclaimer: BUSINESS_DISCLAIMER_FR,
  };
}

export function toQuoteDto(quote: QuoteWithRelations, access: DocumentAccess) {
  const ccy = quote.currencyCode;
  return {
    id: quote.id,
    organizationId: quote.organizationId,
    number: quote.number,
    status: quote.status,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    counterparty: quote.counterparty,
    issuer: issuerDto(quote.organization),
    invoice: quote.invoice,
    convertedTransactionId: quote.convertedTransactionId,
    currencyCode: ccy,
    validUntil: quote.validUntil,
    subtotal: moneyDto(quote.subtotalMinor, ccy),
    tax: moneyDto(quote.taxMinor, ccy),
    taxBps: deriveTaxBps(quote.subtotalMinor, quote.taxMinor),
    total: moneyDto(quote.totalMinor, ccy),
    notes: quote.notes,
    lines: quote.lines.map((l) => lineDto(l, ccy)),
    myRole: access.role,
    nextActions: quoteNextActions(quote, access),
    sentAt: quote.sentAt,
    acceptedAt: quote.acceptedAt,
    declinedAt: quote.declinedAt,
    createdAt: quote.createdAt,
    updatedAt: quote.updatedAt,
    sandbox: true,
    disclaimer: BUSINESS_DISCLAIMER_FR,
  };
}

/** Printable representation shared by invoices and quotes (JSON + plain text). */
export function printableDocument(input: {
  kind: 'INVOICE' | 'QUOTE';
  number: string;
  status: string;
  issuer: ReturnType<typeof issuerDto>;
  customerName: string;
  customerEmail: string | null;
  currencyCode: string;
  dates: Array<{ label: string; value: Date | null }>;
  lines: ReturnType<typeof lineDto>[];
  subtotal: ReturnType<typeof moneyDto>;
  tax: ReturnType<typeof moneyDto>;
  taxBps: number;
  total: ReturnType<typeof moneyDto>;
  paid?: ReturnType<typeof moneyDto>;
  balanceDue?: ReturnType<typeof moneyDto>;
  notes: string | null;
  reference?: string | null;
}) {
  const title = input.kind === 'INVOICE' ? 'FACTURE / INVOICE' : 'DEVIS / QUOTE';
  const lines: string[] = [
    `*** SANDBOX — ${BUSINESS_DISCLAIMER_FR} / Simulated data — No real funds ***`,
    '',
    `${title} ${input.number}`,
    `Statut / Status: ${input.status}`,
    '',
    `Émetteur / Issuer: ${input.issuer.legalName ?? input.issuer.name}${
      input.issuer.registrationNumber ? ` (${input.issuer.registrationNumber})` : ''
    } — ${input.issuer.country}`,
    `Client / Customer: ${input.customerName}${input.customerEmail ? ` <${input.customerEmail}>` : ''}`,
    ...input.dates.map((d) => `${d.label}: ${d.value ? d.value.toISOString().slice(0, 10) : '—'}`),
    ...(input.reference ? [`Référence Protect / Protect reference: ${input.reference}`] : []),
    '',
    'Lignes / Lines:',
    ...input.lines.map(
      (l) =>
        `  ${l.position}. ${l.description} — ${l.quantity} × ${l.unitPrice!.decimal} ${input.currencyCode} = ${l.total!.decimal} ${input.currencyCode}`,
    ),
    '',
    `Sous-total / Subtotal: ${input.subtotal!.decimal} ${input.currencyCode}`,
    `Taxes (${(input.taxBps / 100).toFixed(2)} %): ${input.tax!.decimal} ${input.currencyCode}`,
    `Total: ${input.total!.decimal} ${input.currencyCode}`,
    ...(input.paid ? [`Payé / Paid: ${input.paid.decimal} ${input.currencyCode}`] : []),
    ...(input.balanceDue
      ? [`Solde dû / Balance due: ${input.balanceDue.decimal} ${input.currencyCode}`]
      : []),
    ...(input.notes ? ['', `Notes: ${input.notes}`] : []),
    '',
    `*** ${BUSINESS_DISCLAIMER_FR} ***`,
  ];
  return {
    kind: input.kind,
    number: input.number,
    status: input.status,
    issuer: input.issuer,
    customer: { name: input.customerName, email: input.customerEmail },
    currencyCode: input.currencyCode,
    dates: input.dates.map((d) => ({ label: d.label, value: d.value })),
    lines: input.lines,
    totals: {
      subtotal: input.subtotal,
      tax: input.tax,
      taxBps: input.taxBps,
      total: input.total,
      paid: input.paid ?? null,
      balanceDue: input.balanceDue ?? null,
    },
    notes: input.notes,
    reference: input.reference ?? null,
    text: lines.join('\n'),
    sandbox: true,
    disclaimer: BUSINESS_DISCLAIMER_FR,
  };
}
