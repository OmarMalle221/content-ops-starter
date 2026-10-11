import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { Milestone, Prisma, PrismaTransactionClient } from '@dfn/database';
import {
  LedgerService,
  escrowAccountCode,
  platformFeesCode,
  providerSettlementCode,
} from '@dfn/financial-ledger';
import { createPaymentProvider, type PartnerEvent, type PaymentProviderAdapter } from '@dfn/payment-adapters';
import {
  ErrorCode,
  TransactionEventType,
  fundingMachine,
  minorToDecimalString,
  transactionMachine,
  type FundingRequestInput,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { LEDGER } from '../ledger/ledger.provider';
import { WalletsService } from '../ledger/wallets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RiskService } from '../risk/risk.service';
import {
  TransactionAccessService,
  type TransactionWithRelations,
} from '../transactions/transaction-access.service';
import { TransactionEventsService } from '../transactions/transaction-events.service';

/**
 * Orchestrates the simulated licensed partner and the ledger:
 *  - funding instructions / confirmation (partner → escrow account)
 *  - milestone releases (escrow → seller wallet)
 *  - refunds (escrow → buyer wallet)
 * Every money movement is a balanced ledger posting with an idempotency key.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  readonly provider: PaymentProviderAdapter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly risk: RiskService,
    private readonly access: TransactionAccessService,
    private readonly events: TransactionEventsService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.provider = createPaymentProvider(env.PAYMENT_PROVIDER);
  }

  private async providerRecord(db: PrismaTransactionClient | PrismaService = this.prisma) {
    return db.paymentProvider.findUniqueOrThrow({ where: { code: this.provider.code } });
  }

  async ensureEscrowAccount(
    tx: { id: string; currencyCode: string; reference: string },
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    return this.ledger.ensureAccount(
      {
        code: escrowAccountCode(tx.id, tx.currencyCode),
        name: `Escrow ${tx.reference} (${tx.currencyCode})`,
        type: 'LIABILITY',
        normalBalance: 'CREDIT',
        currencyCode: tx.currencyCode,
        ownerType: 'TRANSACTION',
        ownerId: tx.id,
      },
      db,
    );
  }

  async escrowBalance(tx: { id: string; currencyCode: string }): Promise<bigint> {
    const account = await this.ledger.getAccountByCode(escrowAccountCode(tx.id, tx.currencyCode));
    if (!account) return 0n;
    return (await this.ledger.getBalance(account.id)).balanceMinor;
  }

  /** Buyer asks the (simulated) partner for funding instructions. */
  async createFundingRequest(
    auth: AuthContext,
    tx: TransactionWithRelations,
    input: FundingRequestInput,
    req: Request,
  ) {
    if (tx.contract?.status !== 'ACCEPTED') {
      throw DomainError.invalidTransition('Both parties must accept the contract before funding');
    }
    const pending = tx.fundingRequests.find((f) => f.status === 'PENDING' && f.expiresAt > new Date());
    if (pending)
      throw DomainError.conflict('A funding request is already pending', {
        fundingReference: pending.reference,
      });
    if (tx.status !== 'ACCEPTED' && tx.status !== 'AWAITING_FUNDING') {
      transactionMachine.assertTransition(tx.status, 'AWAITING_FUNDING');
    }
    const total = tx.amountMinor + tx.feeMinor;
    const instructions = await this.provider.createFundingInstructions({
      transactionId: tx.id,
      transactionReference: tx.reference,
      amountMinor: total,
      currencyCode: tx.currencyCode,
      payerName: `${auth.firstName} ${auth.lastName}`,
      method: input.method,
    });
    const provider = await this.providerRecord();
    const meta = requestMeta(req);
    const funding = await this.prisma.$transaction(async (db) => {
      const created = await db.fundingRequest.create({
        data: {
          transactionId: tx.id,
          providerId: provider.id,
          reference: instructions.reference,
          amountMinor: total,
          currencyCode: tx.currencyCode,
          instructions: instructions.instructions as unknown as Prisma.InputJsonValue,
          expiresAt: instructions.expiresAt,
        },
      });
      if (tx.status === 'ACCEPTED') {
        await db.transaction.update({ where: { id: tx.id }, data: { status: 'AWAITING_FUNDING' } });
      }
      await this.events.record(
        tx.id,
        TransactionEventType.FUNDING_REQUESTED,
        auth.userId,
        {
          fundingReference: created.reference,
          amount: minorToDecimalString(total, tx.currencyCode),
          currency: tx.currencyCode,
          method: input.method,
        },
        db,
      );
      await this.audit.log(
        {
          actorUserId: auth.userId,
          organizationId: tx.buyerOrganizationId,
          action: 'funding.requested',
          entityType: 'FundingRequest',
          entityId: created.id,
          metadata: { transactionId: tx.id },
          ...meta,
        },
        db,
      );
      return created;
    });
    const sellerIds = await this.access.partyUserIds(tx, 'SELLER');
    await this.notifications.notifyMany(sellerIds, {
      type: 'transaction.funding_requested',
      title: `Financement demandé — ${tx.reference}`,
      body: `L'acheteur a demandé les instructions de financement (sandbox) pour « ${tx.title} ».`,
      data: { transactionId: tx.id },
    });
    if (this.env.SANDBOX_AUTO_CONFIRM_FUNDING) {
      const event = await this.provider.simulateFundingEvent({
        fundingReference: funding.reference,
        outcome: 'CONFIRMED',
      });
      await this.handlePartnerEvent(event, null);
    }
    return funding;
  }

  /**
   * Entry point for simulated partner events. Idempotent on the event key: replaying the same
   * confirmation never double-funds the escrow.
   */
  async handlePartnerEvent(event: PartnerEvent, actorUserId: string | null) {
    const provider = await this.providerRecord();
    const existing = await this.prisma.providerEvent.findUnique({
      where: { idempotencyKey: event.idempotencyKey },
    });
    if (existing) return { providerEventId: existing.id, replayed: true, status: existing.status };

    const fundingReference = String(event.payload.fundingReference ?? '');
    const funding = await this.prisma.fundingRequest.findUnique({ where: { reference: fundingReference } });
    if (!funding) {
      const ignored = await this.prisma.providerEvent.create({
        data: {
          providerId: provider.id,
          type: event.type,
          externalRef: event.externalRef,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload as Prisma.InputJsonValue,
          status: 'IGNORED',
          error: 'Unknown funding reference',
          processedAt: new Date(),
        },
      });
      return { providerEventId: ignored.id, replayed: false, status: 'IGNORED' as const };
    }

    const result = await this.prisma.$transaction(async (db) => {
      const providerEvent = await db.providerEvent.create({
        data: {
          providerId: provider.id,
          transactionId: funding.transactionId,
          type: event.type,
          externalRef: event.externalRef,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
      // Lock the funding request row to serialise concurrent confirmations.
      const [locked] = await db.$queryRaw<
        Array<{ id: string; status: string }>
      >`SELECT id, status FROM "FundingRequest" WHERE id = ${funding.id}::uuid FOR UPDATE`;
      if (!locked) throw DomainError.notFound('FundingRequest');
      const tx = await this.access.load(funding.transactionId, db);

      if (event.type === 'funding.failed') {
        if (locked.status === 'PENDING') {
          await db.fundingRequest.update({ where: { id: funding.id }, data: { status: 'FAILED' } });
          await this.events.record(
            tx.id,
            TransactionEventType.FUNDING_REQUESTED,
            actorUserId,
            { fundingReference, outcome: 'FAILED' },
            db,
          );
        }
        await db.providerEvent.update({
          where: { id: providerEvent.id },
          data: { status: 'PROCESSED', processedAt: new Date() },
        });
        return {
          providerEventId: providerEvent.id,
          replayed: false,
          status: 'PROCESSED' as const,
          outcome: 'FAILED' as const,
          tx,
        };
      }

      if (locked.status !== 'PENDING') {
        await db.providerEvent.update({
          where: { id: providerEvent.id },
          data: { status: 'IGNORED', error: `Funding request is ${locked.status}`, processedAt: new Date() },
        });
        return {
          providerEventId: providerEvent.id,
          replayed: false,
          status: 'IGNORED' as const,
          outcome: 'IGNORED' as const,
          tx,
        };
      }
      fundingMachine.assertTransition('PENDING', 'CONFIRMED');
      transactionMachine.assertTransition(tx.status, 'FUNDED');

      const escrow = await this.ensureEscrowAccount(tx, db);
      const posted = await this.ledger.post(
        {
          idempotencyKey: `funding:${funding.id}`,
          kind: 'FUNDING',
          description: `Funding of ${tx.reference} confirmed by ${this.provider.code} (simulated)`,
          reference: tx.id,
          metadata: { fundingReference, providerEventId: providerEvent.id, simulated: true },
          entries: [
            {
              accountCode: providerSettlementCode(this.provider.code, tx.currencyCode),
              direction: 'DEBIT',
              amountMinor: tx.amountMinor + tx.feeMinor,
              currencyCode: tx.currencyCode,
            },
            {
              accountId: escrow.id,
              direction: 'CREDIT',
              amountMinor: tx.amountMinor,
              currencyCode: tx.currencyCode,
            },
            ...(tx.feeMinor > 0n
              ? [
                  {
                    accountCode: platformFeesCode(tx.currencyCode),
                    direction: 'CREDIT' as const,
                    amountMinor: tx.feeMinor,
                    currencyCode: tx.currencyCode,
                  },
                ]
              : []),
          ],
        },
        db,
      );
      await db.fundingRequest.update({
        where: { id: funding.id },
        data: { status: 'CONFIRMED', confirmedAt: new Date(), ledgerTransactionId: posted.id },
      });
      await db.transaction.update({ where: { id: tx.id }, data: { status: 'FUNDED', fundedAt: new Date() } });
      await this.events.record(
        tx.id,
        TransactionEventType.FUNDING_CONFIRMED,
        actorUserId,
        {
          fundingReference,
          ledgerTransactionId: posted.id,
          amount: minorToDecimalString(tx.amountMinor, tx.currencyCode),
          fee: minorToDecimalString(tx.feeMinor, tx.currencyCode),
          currency: tx.currencyCode,
          simulated: true,
        },
        db,
      );
      await db.providerEvent.update({
        where: { id: providerEvent.id },
        data: { status: 'PROCESSED', processedAt: new Date() },
      });
      await this.audit.log(
        {
          actorUserId,
          organizationId: tx.buyerOrganizationId,
          action: 'funding.confirmed',
          entityType: 'Transaction',
          entityId: tx.id,
          metadata: { fundingReference, ledgerTransactionId: posted.id, simulated: true },
        },
        db,
      );
      return {
        providerEventId: providerEvent.id,
        replayed: false,
        status: 'PROCESSED' as const,
        outcome: 'CONFIRMED' as const,
        tx,
      };
    });

    if (result.outcome === 'CONFIRMED') {
      const tx = result.tx;
      const [buyers, sellers] = await Promise.all([
        this.access.partyUserIds(tx, 'BUYER'),
        this.access.partyUserIds(tx, 'SELLER'),
      ]);
      await this.notifications.notifyMany([...buyers, ...sellers], {
        type: 'transaction.funded',
        title: `Fonds (fictifs) reçus — ${tx.reference}`,
        body: `Le partenaire simulé a confirmé la réception des fonds fictifs pour « ${tx.title} ». Le vendeur peut maintenant livrer et soumettre ses preuves.`,
        data: { transactionId: tx.id },
      });
      const facts = await this.risk.transactionFacts({
        userId: tx.createdByUserId,
        organizationId: tx.buyerOrganizationId,
        amountMinor: tx.amountMinor,
        currencyCode: tx.currencyCode,
        originCountry: tx.originCountry,
        destinationCountry: tx.destinationCountry,
        corridorSupported: true,
      });
      await this.risk.evaluateAndRecord({ ...facts, event: 'transaction.funded', transactionId: tx.id });
    }
    return {
      providerEventId: result.providerEventId,
      replayed: result.replayed,
      status: result.status,
      outcome: result.outcome,
    };
  }

  /** Called by the milestone approval flow. Must run inside the caller's transaction. */
  async releaseMilestone(
    tx: TransactionWithRelations,
    milestone: Milestone,
    actorUserId: string,
    db: PrismaTransactionClient,
  ) {
    if (tx.releaseFrozen || tx.status === 'DISPUTED') {
      throw new DomainError(
        ErrorCode.RELEASE_FROZEN,
        'Releases are frozen while a dispute is open',
        HttpStatus.CONFLICT,
      );
    }
    if (!tx.sellerOrganizationId) throw DomainError.invalidTransition('Seller organisation is missing');
    const escrow = await this.ensureEscrowAccount(tx, db);
    const sellerWallet = await this.wallets.ensureWallet(tx.sellerOrganizationId, tx.currencyCode, db);
    const execution = await this.provider.executeRelease({
      transactionId: tx.id,
      milestoneId: milestone.id,
      amountMinor: milestone.amountMinor,
      currencyCode: tx.currencyCode,
      beneficiaryOrganizationId: tx.sellerOrganizationId,
    });
    const posted = await this.ledger.post(
      {
        idempotencyKey: `release:${milestone.id}`,
        kind: 'RELEASE',
        description: `Release of milestone ${milestone.sequence} (${milestone.title}) for ${tx.reference} — simulated`,
        reference: tx.id,
        metadata: { milestoneId: milestone.id, externalRef: execution.externalRef, simulated: true },
        entries: [
          {
            accountId: escrow.id,
            direction: 'DEBIT',
            amountMinor: milestone.amountMinor,
            currencyCode: tx.currencyCode,
          },
          {
            accountId: sellerWallet.ledgerAccountId,
            direction: 'CREDIT',
            amountMinor: milestone.amountMinor,
            currencyCode: tx.currencyCode,
          },
        ],
      },
      db,
    );
    const provider = await this.providerRecord(db);
    await db.providerEvent.create({
      data: {
        providerId: provider.id,
        transactionId: tx.id,
        type: 'release.executed',
        externalRef: execution.externalRef,
        idempotencyKey: `release-exec:${milestone.id}`,
        payload: {
          milestoneId: milestone.id,
          amount: milestone.amountMinor.toString(),
          currency: tx.currencyCode,
          simulated: true,
        },
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });
    await db.milestone.update({
      where: { id: milestone.id },
      data: { status: 'RELEASED', releasedAt: new Date(), ledgerTransactionId: posted.id },
    });
    await this.events.record(
      tx.id,
      TransactionEventType.MILESTONE_RELEASED,
      actorUserId,
      {
        milestoneId: milestone.id,
        sequence: milestone.sequence,
        ledgerTransactionId: posted.id,
        amount: minorToDecimalString(milestone.amountMinor, tx.currencyCode),
        currency: tx.currencyCode,
        externalRef: execution.externalRef,
        simulated: true,
      },
      db,
    );
    return posted;
  }

  /** Refund (part of) the escrow to the buyer wallet. Must run inside the caller's transaction. */
  async refundToBuyer(
    tx: TransactionWithRelations,
    amountMinor: bigint,
    idempotencyKey: string,
    reason: string,
    actorUserId: string | null,
    db: PrismaTransactionClient,
  ) {
    if (amountMinor <= 0n) return null;
    const escrow = await this.ensureEscrowAccount(tx, db);
    const buyerWallet = await this.wallets.ensureWallet(tx.buyerOrganizationId, tx.currencyCode, db);
    const execution = await this.provider.executeRefund({
      transactionId: tx.id,
      amountMinor,
      currencyCode: tx.currencyCode,
      beneficiaryOrganizationId: tx.buyerOrganizationId,
      reason,
    });
    const posted = await this.ledger.post(
      {
        idempotencyKey,
        kind: 'REFUND',
        description: `Refund to buyer for ${tx.reference}: ${reason} — simulated`,
        reference: tx.id,
        metadata: { externalRef: execution.externalRef, simulated: true },
        entries: [
          { accountId: escrow.id, direction: 'DEBIT', amountMinor, currencyCode: tx.currencyCode },
          {
            accountId: buyerWallet.ledgerAccountId,
            direction: 'CREDIT',
            amountMinor,
            currencyCode: tx.currencyCode,
          },
        ],
      },
      db,
    );
    const provider = await this.providerRecord(db);
    await db.providerEvent.create({
      data: {
        providerId: provider.id,
        transactionId: tx.id,
        type: 'refund.executed',
        externalRef: execution.externalRef,
        idempotencyKey: `refund-exec:${idempotencyKey}`,
        payload: { amount: amountMinor.toString(), currency: tx.currencyCode, reason, simulated: true },
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });
    await this.events.record(
      tx.id,
      TransactionEventType.REFUNDED,
      actorUserId,
      {
        ledgerTransactionId: posted.id,
        amount: minorToDecimalString(amountMinor, tx.currencyCode),
        currency: tx.currencyCode,
        reason,
        simulated: true,
      },
      db,
    );
    return posted;
  }

  /** Release remaining escrow to the seller (dispute outcome). */
  async releaseRemainingToSeller(
    tx: TransactionWithRelations,
    amountMinor: bigint,
    idempotencyKey: string,
    reason: string,
    actorUserId: string | null,
    db: PrismaTransactionClient,
  ) {
    if (amountMinor <= 0n) return null;
    if (!tx.sellerOrganizationId) throw DomainError.invalidTransition('Seller organisation is missing');
    const escrow = await this.ensureEscrowAccount(tx, db);
    const sellerWallet = await this.wallets.ensureWallet(tx.sellerOrganizationId, tx.currencyCode, db);
    const posted = await this.ledger.post(
      {
        idempotencyKey,
        kind: 'RELEASE',
        description: `Dispute release to seller for ${tx.reference}: ${reason} — simulated`,
        reference: tx.id,
        metadata: { simulated: true },
        entries: [
          { accountId: escrow.id, direction: 'DEBIT', amountMinor, currencyCode: tx.currencyCode },
          {
            accountId: sellerWallet.ledgerAccountId,
            direction: 'CREDIT',
            amountMinor,
            currencyCode: tx.currencyCode,
          },
        ],
      },
      db,
    );
    await this.events.record(
      tx.id,
      TransactionEventType.MILESTONE_RELEASED,
      actorUserId,
      {
        ledgerTransactionId: posted.id,
        amount: minorToDecimalString(amountMinor, tx.currencyCode),
        currency: tx.currencyCode,
        reason,
        viaDispute: true,
        simulated: true,
      },
      db,
    );
    return posted;
  }

  /**
   * Settles the transaction when nothing is left in escrow and every milestone is terminal.
   * Must run inside the caller's transaction, after milestone updates.
   */
  async settleIfComplete(transactionId: string, actorUserId: string | null, db: PrismaTransactionClient) {
    const tx = await this.access.load(transactionId, db);
    if (!['FUNDED', 'IN_PROGRESS', 'DISPUTED'].includes(tx.status)) return tx.status;
    const terminal = tx.milestones.every((m) => ['RELEASED', 'REFUNDED', 'CANCELLED'].includes(m.status));
    if (!terminal) return tx.status;
    const escrow = await this.ledger.getAccountByCode(escrowAccountCode(tx.id, tx.currencyCode), db);
    const balance = escrow ? (await this.ledger.getBalance(escrow.id, db)).balanceMinor : 0n;
    if (balance !== 0n) return tx.status;
    const releases = await db.ledgerTransaction.count({ where: { reference: tx.id, kind: 'RELEASE' } });
    const anyReleased = releases > 0 || tx.milestones.some((m) => m.status === 'RELEASED');
    const target = anyReleased ? 'SETTLED' : 'REFUNDED';
    transactionMachine.assertTransition(tx.status, target);
    await db.transaction.update({
      where: { id: tx.id },
      data: { status: target, settledAt: new Date(), releaseFrozen: false },
    });
    await this.events.record(
      tx.id,
      target === 'SETTLED' ? TransactionEventType.SETTLED : TransactionEventType.REFUNDED,
      actorUserId,
      { finalStatus: target },
      db,
    );
    this.logger.log(`transaction ${tx.reference} → ${target}`);
    return target;
  }
}
