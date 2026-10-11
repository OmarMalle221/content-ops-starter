import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaTransactionClient } from '@dfn/database';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface AuditInput {
  actorUserId?: string | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes an append-only audit record. Never includes secrets or document contents. */
  async log(input: AuditInput, db: PrismaTransactionClient | PrismaService = this.prisma) {
    return db.auditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        organizationId: input.organizationId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async list(params: {
    entityType?: string;
    entityId?: string;
    actorUserId?: string;
    organizationId?: string;
    page: number;
    pageSize: number;
  }) {
    const where = {
      entityType: params.entityType,
      entityId: params.entityId,
      actorUserId: params.actorUserId,
      organizationId: params.organizationId,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { actor: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: params.page, pageSize: params.pageSize };
  }
}
