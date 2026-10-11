import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaTransactionClient } from '@dfn/database';
import type { TransactionEventType } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DomainEventsBus } from '../../common/events/domain-events';

@Injectable()
export class TransactionEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: DomainEventsBus,
  ) {}

  /**
   * Appends to the immutable transaction history and publishes the event on the in-process bus
   * (webhooks, invoices…). Publication is deferred so that consumers observe committed data when
   * `record` is called inside a database transaction.
   */
  async record(
    transactionId: string,
    type: TransactionEventType,
    actorUserId: string | null,
    payload?: Record<string, unknown>,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    const event = await db.transactionEvent.create({
      data: {
        transactionId,
        type,
        actorUserId,
        payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    setTimeout(() => {
      void this.prisma.transaction
        .findUnique({
          where: { id: transactionId },
          select: { buyerOrganizationId: true, sellerOrganizationId: true, reference: true, status: true },
        })
        .then((tx) => {
          if (!tx) return;
          this.bus.emit({
            type,
            organizationIds: [tx.buyerOrganizationId, tx.sellerOrganizationId].filter((x): x is string =>
              Boolean(x),
            ),
            entityType: 'Transaction',
            entityId: transactionId,
            payload: {
              transactionId,
              reference: tx.reference,
              status: tx.status,
              actorUserId,
              ...(payload ?? {}),
              eventId: event.id,
            },
          });
        })
        .catch(() => undefined);
    }, 50);
    return event;
  }

  list(transactionId: string) {
    return this.prisma.transactionEvent.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
  }
}
