import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Prisma } from '@dfn/database';
import { createKycProvider, createSanctionsProvider } from '@dfn/compliance';
import type { ReviewVerificationInput, SubmitIdentityVerificationInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { ENV, type Env } from '../../config/env';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class VerificationsService {
  private readonly kyc;
  private readonly sanctions;
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(ENV) env: Env,
  ) {
    this.kyc = createKycProvider(env.KYC_PROVIDER);
    this.sanctions = createSanctionsProvider(env.SANCTIONS_PROVIDER);
  }

  async listMine(auth: AuthContext) {
    return this.prisma.identityVerification.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submitIdentity(auth: AuthContext, input: SubmitIdentityVerificationInput, req: Request) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    const passed = await this.prisma.identityVerification.findFirst({
      where: { userId: user.id, status: 'SIMULATED_PASS' },
    });
    if (passed) throw DomainError.conflict('Identity verification already completed (simulated)');
    if (input.documentId) {
      const doc = await this.prisma.document.findFirst({
        where: { id: input.documentId, uploadedByUserId: user.id, deletedAt: null },
      });
      if (!doc) throw DomainError.notFound('Document');
    }
    const [result, screening] = await Promise.all([
      this.kyc.startIdentityCheck({
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        country: user.country ?? input.issuingCountry,
        documentType: input.documentType,
        issuingCountry: input.issuingCountry,
        dateOfBirth: input.dateOfBirth,
        documentId: input.documentId,
        sandboxOutcome: input.sandboxOutcome,
      }),
      this.sanctions.screen({
        fullName: `${user.firstName} ${user.lastName}`,
        country: user.country ?? undefined,
        dateOfBirth: input.dateOfBirth,
      }),
    ]);
    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.identityVerification.create({
        data: {
          userId: user.id,
          provider: result.provider,
          providerRef: result.providerRef,
          status: result.status,
          declaredData: {
            documentType: input.documentType,
            issuingCountry: input.issuingCountry,
            documentId: input.documentId ?? null,
          },
          providerResponse: { identity: result, sanctions: screening } as unknown as Prisma.InputJsonValue,
          expiresAt: result.status === 'SIMULATED_PASS' ? new Date(Date.now() + 365 * 86_400_000) : null,
        },
      });
      await this.audit.log(
        {
          actorUserId: user.id,
          action: 'verification.identity_submitted',
          entityType: 'IdentityVerification',
          entityId: created.id,
          metadata: { status: result.status, simulated: result.simulated, sanctions: screening.status },
          ...requestMeta(req),
        },
        tx,
      );
      if (screening.status === 'POTENTIAL_MATCH_SIMULATED' || screening.status === 'POTENTIAL_MATCH') {
        await tx.riskAlert.create({
          data: {
            userId: user.id,
            ruleCode: 'SANCTIONS_POTENTIAL_MATCH',
            severity: 'HIGH',
            score: 60,
            explanation: {
              summary: 'Potential sanctions list match (simulated screening)',
              factors: {
                matches: screening.matches.length,
                provider: screening.provider,
                simulated: screening.simulated,
              },
              recommendation: 'Manual compliance review before any funding.',
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return created;
    });
    await this.notifications.notify({
      userId: user.id,
      type: 'verification.result',
      title:
        result.status === 'SIMULATED_PASS' ? 'Vérification simulée réussie' : 'Vérification simulée échouée',
      body:
        result.status === 'SIMULATED_PASS'
          ? "Votre vérification d'identité (sandbox, simulée) est complétée."
          : 'La vérification simulée a échoué. Vous pouvez soumettre à nouveau.',
      data: { verificationId: record.id, status: result.status },
    });
    return { ...record, simulated: result.simulated };
  }

  async adminQueue(status?: string, page = 1, pageSize = 50) {
    const where = status ? { status: status as any } : {};
    const [items, total] = await Promise.all([
      this.prisma.identityVerification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, email: true, firstName: true, lastName: true, country: true } },
        },
      }),
      this.prisma.identityVerification.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async adminReview(auth: AuthContext, id: string, input: ReviewVerificationInput, req: Request) {
    const v = await this.prisma.identityVerification.findUnique({ where: { id } });
    if (!v) throw DomainError.notFound('Verification');
    const status = input.decision === 'APPROVE' ? 'SIMULATED_PASS' : 'REJECTED';
    const updated = await this.prisma.identityVerification.update({
      where: { id },
      data: { status, reviewedById: auth.userId, reviewNotes: input.notes, reviewedAt: new Date() },
    });
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'verification.reviewed',
      entityType: 'IdentityVerification',
      entityId: id,
      metadata: { decision: input.decision, from: v.status, to: status },
      ...requestMeta(req),
    });
    await this.notifications.notify({
      userId: v.userId,
      type: 'verification.reviewed',
      title: 'Décision de vérification',
      body: `Votre vérification a été ${input.decision === 'APPROVE' ? 'approuvée (sandbox)' : 'rejetée'}: ${input.notes}`,
      data: { verificationId: id, status },
    });
    return updated;
  }
}
