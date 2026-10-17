import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '@dfn/database';
import {
  DISPUTABLE_TRANSACTION_STATES,
  DisputeOutcome,
  ErrorCode,
  Permission,
  TransactionEventType,
  disputeMachine,
  minorToDecimalString,
  parseDecimalToMinor,
  transactionMachine,
  type DisputeDecisionInput,
  type DisputeMessageInput,
  type OpenDisputeInput,
} from '@dfn/shared';
import { isStaff, type AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { staffUserWhere } from '../../common/staff-recipients';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { RiskService } from '../risk/risk.service';
import {
  TransactionAccessService,
  type TransactionWithRelations,
} from '../transactions/transaction-access.service';
import { TransactionEventsService } from '../transactions/transaction-events.service';
import { linkedDocumentDto } from '../../common/serialize';

const APPEAL_WINDOW_DAYS = 7;

const disputeInclude = {
  transaction: {
    select: {
      id: true,
      reference: true,
      title: true,
      status: true,
      currencyCode: true,
      amountMinor: true,
      buyerOrganizationId: true,
      sellerOrganizationId: true,
      releaseFrozen: true,
    },
  },
  openedBy: { select: { id: true, role: true, organizationId: true, userId: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  messages: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      author: { select: { id: true, firstName: true, lastName: true, globalRole: true } },
      document: {
        select: {
          id: true,
          title: true,
          kind: true,
          fileName: true,
          scanStatus: true,
          scanEngine: true,
          scannedAt: true,
        },
      },
    },
  },
  decisions: {
    orderBy: { createdAt: 'asc' as const },
    include: { decidedBy: { select: { id: true, firstName: true, lastName: true } } },
  },
  evidences: {
    include: {
      document: {
        select: {
          id: true,
          title: true,
          kind: true,
          fileName: true,
          scanStatus: true,
          scanEngine: true,
          scannedAt: true,
        },
      },
    },
  },
} satisfies Prisma.DisputeInclude;

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly risk: RiskService,
    private readonly access: TransactionAccessService,
    private readonly events: TransactionEventsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private toDto(d: Prisma.DisputeGetPayload<{ include: typeof disputeInclude }>, viewerIsStaff: boolean) {
    const ccy = d.transaction.currencyCode;
    return {
      id: d.id,
      status: d.status,
      reason: d.reason,
      description: d.description,
      openedAt: d.openedAt,
      closedAt: d.closedAt,
      appealDeadline: d.appealDeadline,
      openedByRole: d.openedBy.role,
      assignedTo: d.assignedTo,
      transaction: {
        ...d.transaction,
        amount: {
          minor: d.transaction.amountMinor.toString(),
          decimal: minorToDecimalString(d.transaction.amountMinor, ccy),
          currency: ccy,
        },
      },
      messages: d.messages
        .filter((m) => viewerIsStaff || !m.internal)
        .map((m) => ({
          id: m.id,
          body: m.body,
          internal: m.internal,
          createdAt: m.createdAt,
          author: {
            id: m.author.id,
            name: `${m.author.firstName} ${m.author.lastName}`,
            staff: m.author.globalRole !== 'USER',
          },
          document: m.document ? linkedDocumentDto(m.document) : null,
        })),
      decisions: d.decisions.map((x) => ({
        id: x.id,
        outcome: x.outcome,
        rationale: x.rationale,
        isFinal: x.isFinal,
        executedAt: x.executedAt,
        createdAt: x.createdAt,
        sellerAmount: { decimal: minorToDecimalString(x.sellerAmountMinor, ccy), currency: ccy },
        buyerAmount: { decimal: minorToDecimalString(x.buyerAmountMinor, ccy), currency: ccy },
        decidedBy: `${x.decidedBy.firstName} ${x.decidedBy.lastName}`,
      })),
      evidences: d.evidences.map((e) => ({
        id: e.id,
        note: e.note,
        createdAt: e.createdAt,
        document: linkedDocumentDto(e.document),
      })),
      nextStates: disputeMachine.nextStates(d.status),
    };
  }

  private async loadDispute(auth: AuthContext, id: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: disputeInclude });
    if (!d) throw DomainError.notFound('Dispute');
    const tx = await this.access.load(d.transactionId);
    const role = this.access.roleFor(auth, tx);
    if (!role) throw DomainError.notFound('Dispute');
    return { d, tx, role };
  }

  /** Opening a dispute freezes every release until a decision is executed. */
  async open(
    auth: AuthContext,
    transactionId: string,
    input: OpenDisputeInput,
    req: Request,
    kind: 'DISPUTE' | 'REFUND_REQUEST' = 'DISPUTE',
  ) {
    const { tx, role } = await this.access.loadFor(auth, transactionId);
    // Opening a dispute freezes releases: the organisation role must grant DISPUTE_OPEN (not VIEWER).
    this.access.assertPartyPermission(auth, tx, role, Permission.DISPUTE_OPEN, 'BUYER', 'SELLER');
    if (kind === 'REFUND_REQUEST') this.access.assertRole(role, 'BUYER');
    if (!DISPUTABLE_TRANSACTION_STATES.includes(tx.status)) {
      throw DomainError.invalidTransition(
        `A dispute can only be opened while funds are held (current status ${tx.status})`,
      );
    }
    const existing = tx.disputes.find((d) => d.status !== 'CLOSED');
    if (existing)
      throw DomainError.conflict('A dispute is already open on this transaction', { disputeId: existing.id });
    const party = tx.parties.find((p) => p.role === role)!;
    if (input.documentIds.length) {
      const count = await this.prisma.document.count({
        where: { id: { in: input.documentIds }, transactionId, deletedAt: null },
      });
      if (count !== input.documentIds.length)
        throw DomainError.validation('Evidence documents must belong to this transaction');
    }
    transactionMachine.assertTransition(tx.status, 'DISPUTED');
    const meta = requestMeta(req);
    const dispute = await this.prisma.$transaction(async (db) => {
      const created = await db.dispute.create({
        data: {
          transactionId,
          openedByPartyId: party.id,
          reason: input.reason,
          description:
            kind === 'REFUND_REQUEST' ? `[DEMANDE DE REMBOURSEMENT] ${input.description}` : input.description,
          evidences: {
            create: input.documentIds.map((documentId) => ({ documentId, submittedByUserId: auth.userId })),
          },
        },
      });
      await db.transaction.update({
        where: { id: transactionId },
        data: {
          status: 'DISPUTED',
          releaseFrozen: true,
          metadata: { ...((tx.metadata as object) ?? {}), statusBeforeDispute: tx.status },
        },
      });
      await this.events.record(
        transactionId,
        kind === 'REFUND_REQUEST'
          ? TransactionEventType.REFUND_REQUESTED
          : TransactionEventType.DISPUTE_OPENED,
        auth.userId,
        { disputeId: created.id, reason: input.reason, by: role },
        db,
      );
      await this.events.record(
        transactionId,
        TransactionEventType.RELEASE_FROZEN,
        auth.userId,
        { disputeId: created.id },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: role === 'BUYER' ? tx.buyerOrganizationId : tx.sellerOrganizationId,
          action: 'dispute.opened',
          entityType: 'Dispute',
          entityId: created.id,
          metadata: { transactionId, reason: input.reason, kind },
          ...meta,
        },
        db,
      );
      return created;
    });
    const other = role === 'BUYER' ? 'SELLER' : 'BUYER';
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, other), {
      type: 'dispute.opened',
      title: `${kind === 'REFUND_REQUEST' ? 'Demande de remboursement' : 'Contestation ouverte'} — ${tx.reference}`,
      body: `Une ${kind === 'REFUND_REQUEST' ? 'demande de remboursement' : 'contestation'} a été ouverte sur « ${tx.title} ». Les libérations sont gelées jusqu'à la décision.`,
      data: { transactionId, disputeId: dispute.id },
    });
    const staff = await this.prisma.user.findMany({
      where: staffUserWhere(this.env),
      select: { id: true },
    });
    await this.notifications.notifyMany(
      staff.map((s) => s.id),
      {
        type: 'dispute.queue',
        title: `Nouvelle contestation — ${tx.reference}`,
        body: `À examiner : ${input.reason}`,
        data: { disputeId: dispute.id, transactionId },
      },
    );
    const disputesTotal = await this.prisma.dispute.count({
      where: { transaction: { parties: { some: { userId: auth.userId } } } },
    });
    await this.risk.evaluateAndRecord({
      event: 'dispute.opened',
      userId: auth.userId,
      transactionId,
      disputesAsPartyTotal: disputesTotal,
    });
    return this.get(auth, dispute.id);
  }

  async get(auth: AuthContext, id: string) {
    const { d } = await this.loadDispute(auth, id);
    return this.toDto(d, isStaff(auth));
  }

  async listMine(auth: AuthContext, status?: string) {
    const orgIds = auth.memberships.map((m) => m.organizationId);
    const where: Prisma.DisputeWhereInput = {
      ...(status ? { status: status as any } : {}),
      ...(isStaff(auth)
        ? {}
        : {
            transaction: {
              OR: [
                { buyerOrganizationId: { in: orgIds } },
                { sellerOrganizationId: { in: orgIds } },
                { parties: { some: { userId: auth.userId } } },
              ],
            },
          }),
    };
    const items = await this.prisma.dispute.findMany({
      where,
      include: disputeInclude,
      orderBy: { openedAt: 'desc' },
      take: 100,
    });
    return items.map((d) => this.toDto(d, isStaff(auth)));
  }

  async addMessage(auth: AuthContext, id: string, input: DisputeMessageInput, req: Request) {
    const { d, tx, role } = await this.loadDispute(auth, id);
    if (d.status === 'CLOSED') throw DomainError.invalidTransition('Dispute is closed');
    if (input.internal && role !== 'STAFF')
      throw DomainError.forbidden('Only staff can write internal notes');
    if (role !== 'STAFF') {
      this.access.assertPartyPermission(auth, tx, role, Permission.DISPUTE_OPEN, 'BUYER', 'SELLER');
    }
    if (input.documentId) {
      const doc = await this.prisma.document.findFirst({
        where: { id: input.documentId, transactionId: tx.id, deletedAt: null },
      });
      if (!doc) throw DomainError.validation('Document must belong to this transaction');
    }
    await this.prisma.$transaction(async (db) => {
      await db.disputeMessage.create({
        data: {
          disputeId: id,
          authorUserId: auth.userId,
          body: input.body,
          documentId: input.documentId ?? null,
          internal: input.internal,
        },
      });
      if (input.documentId && !input.internal) {
        await db.evidence.create({
          data: {
            disputeId: id,
            documentId: input.documentId,
            submittedByUserId: auth.userId,
            note: input.body.slice(0, 200),
          },
        });
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'dispute.message',
          entityType: 'Dispute',
          entityId: id,
          metadata: { internal: input.internal },
          ...requestMeta(req),
        },
        db,
      );
    });
    if (!input.internal) {
      const recipients = new Set<string>([
        ...(await this.access.partyUserIds(tx, 'BUYER')),
        ...(await this.access.partyUserIds(tx, 'SELLER')),
      ]);
      recipients.delete(auth.userId);
      await this.notifications.notifyMany([...recipients], {
        type: 'dispute.message',
        title: `Nouveau message — ${tx.reference}`,
        body: input.body.slice(0, 140),
        data: { disputeId: id, transactionId: tx.id },
      });
    }
    return this.get(auth, id);
  }

  async startReview(auth: AuthContext, id: string, req: Request) {
    const { d } = await this.loadDispute(auth, id);
    disputeMachine.assertTransition(d.status, 'UNDER_REVIEW');
    await this.prisma.$transaction(async (db) => {
      await db.dispute.update({
        where: { id },
        data: { status: 'UNDER_REVIEW', assignedToUserId: auth.userId },
      });
      await this.events.record(
        d.transactionId,
        TransactionEventType.DISPUTE_UNDER_REVIEW,
        auth.userId,
        { disputeId: id },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'dispute.review_started',
          entityType: 'Dispute',
          entityId: id,
          ...requestMeta(req),
        },
        db,
      );
    });
    return this.get(auth, id);
  }

  /**
   * Reasoned decision. A non-final decision opens an appeal window; a final decision
   * (or a decision on an appeal) is executed immediately: funds move and the dispute closes.
   */
  async decide(auth: AuthContext, id: string, input: DisputeDecisionInput, req: Request) {
    const { d, tx } = await this.loadDispute(auth, id);
    disputeMachine.assertTransition(d.status, 'DECIDED');
    const remaining = await this.payments.escrowBalance(tx);
    const ccy = tx.currencyCode;
    let sellerMinor = 0n;
    let buyerMinor = 0n;
    switch (input.outcome) {
      case DisputeOutcome.RELEASE_TO_SELLER:
        sellerMinor = remaining;
        break;
      case DisputeOutcome.REFUND_TO_BUYER:
        buyerMinor = remaining;
        break;
      case DisputeOutcome.SPLIT:
        sellerMinor = parseDecimalToMinor(input.sellerAmount!, ccy);
        buyerMinor = parseDecimalToMinor(input.buyerAmount!, ccy);
        if (sellerMinor + buyerMinor !== remaining) {
          throw DomainError.validation('SPLIT amounts must equal the remaining escrow balance', {
            remaining: minorToDecimalString(remaining, ccy),
          });
        }
        break;
      case DisputeOutcome.DISMISSED:
        break;
    }
    const isFinal = input.isFinal || d.status === 'APPEALED';
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      const decision = await db.disputeDecision.create({
        data: {
          disputeId: id,
          decidedByUserId: auth.userId,
          outcome: input.outcome,
          rationale: input.rationale,
          sellerAmountMinor: sellerMinor,
          buyerAmountMinor: buyerMinor,
          isFinal,
        },
      });
      await db.dispute.update({
        where: { id },
        data: {
          status: 'DECIDED',
          appealDeadline: isFinal ? null : new Date(Date.now() + APPEAL_WINDOW_DAYS * 86_400_000),
        },
      });
      await this.events.record(
        tx.id,
        TransactionEventType.DISPUTE_DECIDED,
        auth.userId,
        {
          disputeId: id,
          decisionId: decision.id,
          outcome: input.outcome,
          isFinal,
          sellerAmount: minorToDecimalString(sellerMinor, ccy),
          buyerAmount: minorToDecimalString(buyerMinor, ccy),
          currency: ccy,
        },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'dispute.decided',
          entityType: 'DisputeDecision',
          entityId: decision.id,
          metadata: { disputeId: id, outcome: input.outcome, isFinal },
          ...meta,
        },
        db,
      );
      if (isFinal) await this.executeDecision(tx, id, decision.id, auth.userId, db);
    });
    const recipients = [
      ...(await this.access.partyUserIds(tx, 'BUYER')),
      ...(await this.access.partyUserIds(tx, 'SELLER')),
    ];
    await this.notifications.notifyMany(recipients, {
      type: 'dispute.decided',
      title: `Décision — ${tx.reference}`,
      body: `Décision : ${input.outcome}. ${isFinal ? 'Décision finale exécutée (fonds fictifs).' : `Vous pouvez demander une révision sous ${APPEAL_WINDOW_DAYS} jours.`} Motif : ${input.rationale.slice(0, 200)}`,
      data: { disputeId: id, transactionId: tx.id },
    });
    return this.get(auth, id);
  }

  private async executeDecision(
    txSnapshot: TransactionWithRelations,
    disputeId: string,
    decisionId: string,
    actorUserId: string,
    db: Prisma.TransactionClient,
  ) {
    const decision = await db.disputeDecision.findUniqueOrThrow({ where: { id: decisionId } });
    if (decision.executedAt) return;
    const tx = await this.access.load(txSnapshot.id, db);
    const reason = `dispute ${disputeId} — ${decision.outcome}`;
    if (decision.sellerAmountMinor > 0n) {
      await this.payments.releaseRemainingToSeller(
        tx,
        decision.sellerAmountMinor,
        `dispute-release:${decisionId}`,
        reason,
        actorUserId,
        db,
      );
    }
    if (decision.buyerAmountMinor > 0n) {
      await this.payments.refundToBuyer(
        tx,
        decision.buyerAmountMinor,
        `dispute-refund:${decisionId}`,
        reason,
        actorUserId,
        db,
      );
    }
    if (decision.outcome !== 'DISMISSED') {
      // Non-released milestones are closed according to the outcome.
      const open = tx.milestones.filter((m) => !['RELEASED', 'REFUNDED', 'CANCELLED'].includes(m.status));
      const targetStatus =
        decision.outcome === 'REFUND_TO_BUYER'
          ? 'REFUNDED'
          : decision.outcome === 'RELEASE_TO_SELLER'
            ? 'RELEASED'
            : 'REFUNDED';
      for (const m of open) {
        await db.milestone.update({
          where: { id: m.id },
          data: { status: targetStatus, releasedAt: targetStatus === 'RELEASED' ? new Date() : null },
        });
      }
    }
    await db.disputeDecision.update({ where: { id: decisionId }, data: { executedAt: new Date() } });
    await db.dispute.update({ where: { id: disputeId }, data: { status: 'CLOSED', closedAt: new Date() } });
    const previous = ((tx.metadata as any)?.statusBeforeDispute as string | undefined) ?? 'IN_PROGRESS';
    const resume = previous === 'FUNDED' ? 'FUNDED' : 'IN_PROGRESS';
    transactionMachine.assertTransition('DISPUTED', resume);
    await db.transaction.update({ where: { id: tx.id }, data: { status: resume, releaseFrozen: false } });
    await this.events.record(tx.id, TransactionEventType.RELEASE_UNFROZEN, actorUserId, { disputeId }, db);
    await this.events.record(
      tx.id,
      TransactionEventType.DISPUTE_CLOSED,
      actorUserId,
      { disputeId, decisionId, outcome: decision.outcome },
      db,
    );
    await this.payments.settleIfComplete(tx.id, actorUserId, db);
  }

  async appeal(auth: AuthContext, id: string, grounds: string, req: Request) {
    const { d, tx, role } = await this.loadDispute(auth, id);
    this.access.assertPartyPermission(auth, tx, role, Permission.DISPUTE_OPEN, 'BUYER', 'SELLER');
    disputeMachine.assertTransition(d.status, 'APPEALED');
    if (d.appealDeadline && d.appealDeadline < new Date())
      throw new DomainError(ErrorCode.INVALID_TRANSITION, 'Appeal window has passed', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (db) => {
      await db.dispute.update({ where: { id }, data: { status: 'APPEALED' } });
      await db.disputeMessage.create({
        data: { disputeId: id, authorUserId: auth.userId, body: `[DEMANDE DE RÉVISION] ${grounds}` },
      });
      await this.events.record(
        tx.id,
        TransactionEventType.DISPUTE_APPEALED,
        auth.userId,
        { disputeId: id, by: role },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'dispute.appealed',
          entityType: 'Dispute',
          entityId: id,
          ...requestMeta(req),
        },
        db,
      );
    });
    return this.get(auth, id);
  }

  /** Staff closes a DECIDED dispute once the appeal window has passed (executes the decision). */
  async close(auth: AuthContext, id: string, note: string, req: Request) {
    const { d, tx } = await this.loadDispute(auth, id);
    if (d.status !== 'DECIDED') disputeMachine.assertTransition(d.status, 'CLOSED');
    const latest = d.decisions[d.decisions.length - 1];
    await this.prisma.$transaction(async (db) => {
      if (latest && !latest.executedAt) {
        await this.executeDecision(tx, id, latest.id, auth.userId, db);
      } else {
        await db.dispute.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date() } });
        await db.transaction.update({
          where: { id: tx.id },
          data: { releaseFrozen: false, status: tx.status === 'DISPUTED' ? 'IN_PROGRESS' : tx.status },
        });
        await this.events.record(
          tx.id,
          TransactionEventType.DISPUTE_CLOSED,
          auth.userId,
          { disputeId: id, note },
          db,
        );
      }
      await this.audit.log(
        {
          actorUserId: auth.userId,
          action: 'dispute.closed',
          entityType: 'Dispute',
          entityId: id,
          metadata: { note },
          ...requestMeta(req),
        },
        db,
      );
    });
    return this.get(auth, id);
  }
}
