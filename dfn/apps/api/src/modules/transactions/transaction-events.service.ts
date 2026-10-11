import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaTransactionClient } from '@dfn/database';
import type { TransactionEventType } from '@dfn/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TransactionEventsService {
  constructor(private readonly prisma: PrismaService) {}

  record(
    transactionId: string,
    type: TransactionEventType,
    actorUserId: string | null,
    payload?: Record<string, unknown>,
    db: PrismaTransactionClient | PrismaService = this.prisma,
  ) {
    return db.transactionEvent.create({
      data: {
        transactionId,
        type,
        actorUserId,
        payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  list(transactionId: string) {
    return this.prisma.transactionEvent.findMany({
      where: { transactionId },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
  }
}
