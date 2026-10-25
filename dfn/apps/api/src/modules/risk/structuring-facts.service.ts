import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@dfn/database';
import {
  structuringThresholdFor,
  STRUCTURING_EVENT_KINDS,
  STRUCTURING_FLOW_OF,
  structuringKindsOf,
  type RiskFacts,
  type StructuringFacts,
  type StructuringOperation,
  type StructuringOperationKind,
  type StructuringSubject,
} from '@dfn/compliance';
import { CURRENCIES } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';

type Db = Prisma.TransactionClient | PrismaService;
type Subject = Pick<StructuringSubject, 'type' | 'id'>;

/** Operation with every identifier the triggering event may refer to (ids, references). */
interface CollectedOperation extends StructuringOperation {
  ids: string[];
  transactionId?: string;
}

/** Per subject and operation kind, at most this many operations are read (most recent first). */
const MAX_OPERATIONS_PER_KIND = 200;

const sumAmounts = (entries: Array<{ amountMinor: bigint }>) =>
  entries.reduce((acc, e) => acc + e.amountMinor, 0n);

/**
 * Gathers, from the database, the operations aggregated by the STRUCTURING rule for the subject(s)
 * of an event: the organisation and the user, same currency, same direction, within
 * STRUCTURING_WINDOW_HOURS. How each operation kind is identified:
 *
 *  - SELF_DEPOSIT: POSTED `DEPOSIT` ledger transactions tagged `metadata.selfService = true` by the
 *    sandbox self-deposit endpoint (`reference` = organisation id, `metadata.by` = user id);
 *  - PROTECT_FUNDING: CONFIRMED funding requests of transactions bought by the organisation
 *    (`buyerOrganizationId`) or created by the user;
 *  - TRANSFER: transfers authorised in the window (`authorizedAt`), plus authorisation attempts held
 *    for compliance review (`REVIEW_REQUIRED`);
 *  - INVOICE_PAYMENT: POSTED wallet payments of invoices (`ADJUSTMENT` ledger transactions tagged
 *    `metadata.purpose = INVOICE_PAYMENT`, `payerOrganizationId`, `by`).
 *
 * The operation behind the event is flagged `current` (matched on `transactionId` or
 * `operationReference`); when it is not persisted yet (a transfer is evaluated before it is
 * authorised) it is added from the facts themselves.
 */
@Injectable()
export class StructuringFactsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get windowHours(): number {
    return this.env.STRUCTURING_WINDOW_HOURS;
  }

  /** Decimal threshold for one currency (STRUCTURING_THRESHOLD default or `CCC:value` entry). */
  thresholdFor(currencyCode: string): string | null {
    return structuringThresholdFor(this.env.STRUCTURING_THRESHOLD, currencyCode);
  }

  async collect(
    facts: RiskFacts,
    now = new Date(),
    db: Db = this.prisma,
  ): Promise<StructuringFacts | undefined> {
    const kind = STRUCTURING_EVENT_KINDS[facts.event];
    const currencyCode = facts.currencyCode;
    if (!kind || !currencyCode || !(currencyCode in CURRENCIES) || facts.amountMinor === undefined) {
      return undefined;
    }
    const threshold = this.thresholdFor(currencyCode);
    if (!threshold) return undefined;
    const subjects: Subject[] = [
      ...(facts.organizationId ? [{ type: 'ORGANIZATION' as const, id: facts.organizationId }] : []),
      ...(facts.userId ? [{ type: 'USER' as const, id: facts.userId }] : []),
    ];
    if (!subjects.length) return undefined;
    const flow = STRUCTURING_FLOW_OF[kind];
    const since = new Date(now.getTime() - this.windowHours * 3_600_000);
    const kinds = structuringKindsOf(flow);

    const collected: StructuringSubject[] = [];
    for (const subject of subjects) {
      const operations = (
        await Promise.all(kinds.map((k) => this.operationsOf(k, subject, currencyCode, since, db)))
      ).flat();
      const current = operations.find((op) => this.isCurrent(op, kind, facts));
      if (current) current.current = true;
      else {
        operations.push({
          kind,
          reference: facts.operationReference ?? 'current-operation',
          amountMinor: facts.amountMinor,
          occurredAt: now.toISOString(),
          current: true,
          ids: [],
        });
      }
      collected.push({
        type: subject.type,
        id: subject.id,
        operations: operations.map((op) => ({
          kind: op.kind,
          reference: op.reference,
          amountMinor: op.amountMinor,
          occurredAt: op.occurredAt,
          ...(op.current ? { current: true } : {}),
        })),
      });
    }
    return {
      currencyCode,
      flow,
      windowHours: this.windowHours,
      threshold,
      subjects: collected,
    };
  }

  private isCurrent(op: CollectedOperation, kind: StructuringOperationKind, facts: RiskFacts): boolean {
    if (op.kind !== kind) return false;
    if (kind === 'PROTECT_FUNDING' && facts.transactionId && op.transactionId === facts.transactionId) {
      return true;
    }
    const ref = facts.operationReference;
    return Boolean(ref) && (op.reference === ref || op.ids.includes(ref!));
  }

  private operationsOf(
    kind: StructuringOperationKind,
    subject: Subject,
    currencyCode: string,
    since: Date,
    db: Db,
  ): Promise<CollectedOperation[]> {
    switch (kind) {
      case 'SELF_DEPOSIT':
        return this.selfDeposits(subject, currencyCode, since, db);
      case 'PROTECT_FUNDING':
        return this.protectFundings(subject, currencyCode, since, db);
      case 'TRANSFER':
        return this.transfers(subject, currencyCode, since, db);
      case 'INVOICE_PAYMENT':
        return this.invoicePayments(subject, currencyCode, since, db);
    }
  }

  private async selfDeposits(subject: Subject, currencyCode: string, since: Date, db: Db) {
    const rows = await db.ledgerTransaction.findMany({
      where: {
        kind: 'DEPOSIT',
        status: 'POSTED',
        postedAt: { gte: since },
        ...(subject.type === 'ORGANIZATION' ? { reference: subject.id } : {}),
        AND: [
          { metadata: { path: ['selfService'], equals: true } },
          { metadata: { path: ['currencyCode'], equals: currencyCode } },
          ...(subject.type === 'USER' ? [{ metadata: { path: ['by'], equals: subject.id } }] : []),
        ],
      },
      select: {
        id: true,
        postedAt: true,
        entries: { where: { direction: 'CREDIT', currencyCode }, select: { amountMinor: true } },
      },
      orderBy: { postedAt: 'desc' },
      take: MAX_OPERATIONS_PER_KIND,
    });
    return rows.map<CollectedOperation>((r) => ({
      kind: 'SELF_DEPOSIT',
      reference: r.id,
      amountMinor: sumAmounts(r.entries),
      occurredAt: r.postedAt.toISOString(),
      ids: [r.id],
    }));
  }

  private async protectFundings(subject: Subject, currencyCode: string, since: Date, db: Db) {
    const rows = await db.fundingRequest.findMany({
      where: {
        status: 'CONFIRMED',
        currencyCode,
        confirmedAt: { gte: since },
        transaction:
          subject.type === 'ORGANIZATION'
            ? { buyerOrganizationId: subject.id }
            : { createdByUserId: subject.id },
      },
      select: {
        id: true,
        reference: true,
        amountMinor: true,
        confirmedAt: true,
        createdAt: true,
        transactionId: true,
        ledgerTransactionId: true,
      },
      orderBy: { confirmedAt: 'desc' },
      take: MAX_OPERATIONS_PER_KIND,
    });
    return rows.map<CollectedOperation>((r) => ({
      kind: 'PROTECT_FUNDING',
      reference: r.reference,
      amountMinor: r.amountMinor,
      occurredAt: (r.confirmedAt ?? r.createdAt).toISOString(),
      ids: [r.id, ...(r.ledgerTransactionId ? [r.ledgerTransactionId] : [])],
      transactionId: r.transactionId,
    }));
  }

  private async transfers(subject: Subject, currencyCode: string, since: Date, db: Db) {
    const rows = await db.transfer.findMany({
      where: {
        sourceCurrency: currencyCode,
        ...(subject.type === 'ORGANIZATION'
          ? { organizationId: subject.id }
          : {
              OR: [
                { createdByUserId: subject.id },
                { metadata: { path: ['authorizedByUserId'], equals: subject.id } },
                { metadata: { path: ['authorizationRequestedByUserId'], equals: subject.id } },
              ],
            }),
        AND: [
          {
            OR: [{ authorizedAt: { gte: since } }, { status: 'REVIEW_REQUIRED', updatedAt: { gte: since } }],
          },
        ],
      },
      select: { id: true, reference: true, sourceAmountMinor: true, authorizedAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_OPERATIONS_PER_KIND,
    });
    return rows.map<CollectedOperation>((r) => ({
      kind: 'TRANSFER',
      reference: r.reference,
      amountMinor: r.sourceAmountMinor,
      occurredAt: (r.authorizedAt ?? r.updatedAt).toISOString(),
      ids: [r.id],
    }));
  }

  private async invoicePayments(subject: Subject, currencyCode: string, since: Date, db: Db) {
    const rows = await db.ledgerTransaction.findMany({
      where: {
        kind: 'ADJUSTMENT',
        status: 'POSTED',
        postedAt: { gte: since },
        AND: [
          { metadata: { path: ['purpose'], equals: 'INVOICE_PAYMENT' } },
          {
            metadata: {
              path: [subject.type === 'ORGANIZATION' ? 'payerOrganizationId' : 'by'],
              equals: subject.id,
            },
          },
        ],
      },
      select: {
        id: true,
        postedAt: true,
        entries: { where: { direction: 'DEBIT', currencyCode }, select: { amountMinor: true } },
      },
      orderBy: { postedAt: 'desc' },
      take: MAX_OPERATIONS_PER_KIND,
    });
    const inCurrency = rows.filter((r) => r.entries.length > 0);
    if (!inCurrency.length) return [];
    const payments = await db.invoicePayment.findMany({
      where: { ledgerTransactionId: { in: inCurrency.map((r) => r.id) } },
      select: { id: true, ledgerTransactionId: true, invoice: { select: { number: true } } },
    });
    const byLedgerId = new Map(payments.map((p) => [p.ledgerTransactionId, p]));
    return inCurrency.map<CollectedOperation>((r) => {
      const payment = byLedgerId.get(r.id);
      return {
        kind: 'INVOICE_PAYMENT',
        // Several partial payments of one invoice are distinct operations: the reference stays unique.
        reference: payment ? `${payment.invoice.number}:${r.id.slice(0, 8)}` : r.id,
        amountMinor: sumAmounts(r.entries),
        occurredAt: r.postedAt.toISOString(),
        ids: [r.id, ...(payment ? [payment.id] : [])],
      };
    });
  }
}
