import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  ErrorCode,
  TransactionEventType,
  milestoneMachine,
  transactionMachine,
  type SubmitMilestoneInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { RiskService } from '../risk/risk.service';
import { TransactionAccessService } from './transaction-access.service';
import { TransactionEventsService } from './transaction-events.service';
import { TransactionsService } from './transactions.service';

@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly payments: PaymentsService,
    private readonly risk: RiskService,
    private readonly access: TransactionAccessService,
    private readonly events: TransactionEventsService,
    private readonly transactions: TransactionsService,
  ) {}

  /** Seller uploads the contractual proofs for a milestone. */
  async submit(
    auth: AuthContext,
    transactionId: string,
    milestoneId: string,
    input: SubmitMilestoneInput,
    req: Request,
  ) {
    const { tx, role } = await this.access.loadFor(auth, transactionId);
    this.access.assertPartyCan(auth, tx, role, 'SELLER');
    if (!['FUNDED', 'IN_PROGRESS', 'DISPUTED'].includes(tx.status)) {
      throw DomainError.invalidTransition(
        `Milestones can be submitted once the transaction is funded (current: ${tx.status})`,
      );
    }
    const milestone = tx.milestones.find((m) => m.id === milestoneId);
    if (!milestone) throw DomainError.notFound('Milestone');
    milestoneMachine.assertTransition(milestone.status, 'SUBMITTED');
    const docs = await this.prisma.document.findMany({
      where: { id: { in: input.documentIds }, transactionId, deletedAt: null },
    });
    if (docs.length !== input.documentIds.length)
      throw DomainError.validation('Every evidence document must belong to this transaction');
    const providedKinds = new Set(docs.map((d) => d.kind));
    const missing = milestone.requiredEvidence.filter((k) => !providedKinds.has(k as any));
    if (missing.length) throw DomainError.validation('Required evidence is missing', { missing });
    const meta = requestMeta(req);
    await this.prisma.$transaction(async (db) => {
      await db.milestone.update({
        where: { id: milestoneId },
        data: { status: 'SUBMITTED', submittedAt: new Date(), rejectionNote: null },
      });
      await db.evidence.createMany({
        data: input.documentIds.map((documentId) => ({
          milestoneId,
          documentId,
          submittedByUserId: auth.userId,
          note: input.note ?? null,
        })),
      });
      if (tx.status === 'FUNDED') {
        transactionMachine.assertTransition('FUNDED', 'IN_PROGRESS');
        await db.transaction.update({ where: { id: transactionId }, data: { status: 'IN_PROGRESS' } });
      }
      await this.events.record(
        transactionId,
        TransactionEventType.MILESTONE_SUBMITTED,
        auth.userId,
        { milestoneId, sequence: milestone.sequence, documentIds: input.documentIds, note: input.note },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: tx.sellerOrganizationId,
          action: 'milestone.submitted',
          entityType: 'Milestone',
          entityId: milestoneId,
          metadata: { transactionId },
          ...meta,
        },
        db,
      );
    });
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, 'BUYER'), {
      type: 'milestone.submitted',
      title: `Jalon à valider — ${tx.reference}`,
      body: `Le vendeur a soumis les preuves du jalon « ${milestone.title} ». Vérifiez-les puis validez la libération (fictive).`,
      data: { transactionId, milestoneId },
    });
    return this.transactions.get(auth, transactionId);
  }

  /** Buyer asks for additional or corrected evidence. */
  async requestChanges(
    auth: AuthContext,
    transactionId: string,
    milestoneId: string,
    note: string,
    req: Request,
  ) {
    const { tx, role } = await this.access.loadFor(auth, transactionId);
    this.access.assertPartyCan(auth, tx, role, 'BUYER');
    const milestone = tx.milestones.find((m) => m.id === milestoneId);
    if (!milestone) throw DomainError.notFound('Milestone');
    milestoneMachine.assertTransition(milestone.status, 'CHANGES_REQUESTED');
    await this.prisma.$transaction(async (db) => {
      await db.milestone.update({
        where: { id: milestoneId },
        data: { status: 'CHANGES_REQUESTED', rejectionNote: note },
      });
      await this.events.record(
        transactionId,
        TransactionEventType.MILESTONE_CHANGES_REQUESTED,
        auth.userId,
        { milestoneId, note },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: tx.buyerOrganizationId,
          action: 'milestone.changes_requested',
          entityType: 'Milestone',
          entityId: milestoneId,
          metadata: { transactionId },
          ...requestMeta(req),
        },
        db,
      );
    });
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, 'SELLER'), {
      type: 'milestone.changes_requested',
      title: `Compléments demandés — ${tx.reference}`,
      body: `L'acheteur demande des compléments pour le jalon « ${milestone.title} » : ${note}`,
      data: { transactionId, milestoneId },
    });
    return this.transactions.get(auth, transactionId);
  }

  /**
   * Buyer approves the milestone. Approval and the simulated release are one atomic unit:
   * either the milestone is RELEASED with a balanced ledger posting, or nothing changes.
   */
  async approve(
    auth: AuthContext,
    transactionId: string,
    milestoneId: string,
    note: string | undefined,
    req: Request,
  ) {
    const { tx, role } = await this.access.loadFor(auth, transactionId);
    this.access.assertPartyCan(auth, tx, role, 'BUYER');
    const milestone = tx.milestones.find((m) => m.id === milestoneId);
    if (!milestone) throw DomainError.notFound('Milestone');
    milestoneMachine.assertTransition(milestone.status, 'APPROVED');
    if (tx.releaseFrozen || tx.status === 'DISPUTED') {
      throw new DomainError(
        ErrorCode.RELEASE_FROZEN,
        'A dispute is open: releases are frozen until it is resolved',
        HttpStatus.CONFLICT,
      );
    }
    const meta = requestMeta(req);
    let finalStatus: string = tx.status;
    await this.prisma.$transaction(async (db) => {
      // Re-read inside the transaction to guard against a dispute opened concurrently.
      const fresh = await db.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { releaseFrozen: true, status: true },
      });
      if (fresh.releaseFrozen || fresh.status === 'DISPUTED') {
        throw new DomainError(
          ErrorCode.RELEASE_FROZEN,
          'A dispute is open: releases are frozen',
          HttpStatus.CONFLICT,
        );
      }
      await db.milestone.update({
        where: { id: milestoneId },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });
      await this.events.record(
        transactionId,
        TransactionEventType.MILESTONE_APPROVED,
        auth.userId,
        { milestoneId, sequence: milestone.sequence, note },
        db,
      );
      await this.payments.releaseMilestone(tx, milestone, auth.userId, db);
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: tx.buyerOrganizationId,
          action: 'milestone.approved',
          entityType: 'Milestone',
          entityId: milestoneId,
          metadata: { transactionId, released: true },
          ...meta,
        },
        db,
      );
      finalStatus = await this.payments.settleIfComplete(transactionId, auth.userId, db);
    });
    await this.notifications.notifyMany(await this.access.partyUserIds(tx, 'SELLER'), {
      type: 'milestone.released',
      title: `Jalon libéré (fictif) — ${tx.reference}`,
      body: `L'acheteur a validé le jalon « ${milestone.title} ». Le montant fictif a été crédité sur votre portefeuille sandbox.${finalStatus === 'SETTLED' ? ' La transaction est clôturée.' : ''}`,
      data: { transactionId, milestoneId },
    });
    await this.risk.evaluateAndRecord({
      event: 'milestone.approved',
      userId: auth.userId,
      organizationId: tx.buyerOrganizationId,
      transactionId,
      amountMinor: milestone.amountMinor,
      currencyCode: tx.currencyCode,
    });
    return this.transactions.get(auth, transactionId);
  }
}
