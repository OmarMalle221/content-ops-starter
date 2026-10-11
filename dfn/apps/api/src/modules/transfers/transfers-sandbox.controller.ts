import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { sandboxTransferEventSchema, type SandboxTransferEventInput } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DomainError } from '../../common/domain-error';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { toTransferDto } from './transfer.dto';
import { TransfersService } from './transfers.service';

/**
 * Simulated partner webhook for transfers. Stands in for the licensed partner's settlement /
 * rejection callbacks; only members of the transfer's organisation (or staff) may trigger it.
 */
@ApiTags('sandbox')
@Controller('v1/sandbox/partner')
export class TransfersSandboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transfers: TransfersService,
    private readonly audit: AuditService,
  ) {}

  @HttpCode(200)
  @Post('transfer-events')
  async transferEvent(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(sandboxTransferEventSchema)) body: SandboxTransferEventInput,
    @Req() req: Request,
  ) {
    const transfer = await this.prisma.transfer.findUnique({ where: { reference: body.transferReference } });
    if (!transfer) throw DomainError.notFound('Transfer');
    this.transfers.assertPartnerSimulationAllowed(auth, transfer);
    const result = await this.transfers.handlePartnerOutcome(transfer.id, body.outcome, {
      actorUserId: auth.userId,
      failureReason: body.failureReason,
      externalRef: body.externalRef,
      triggeredBy: `sandbox:${auth.userId}`,
    });
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: transfer.organizationId,
      action: 'sandbox.partner_transfer_event',
      entityType: 'Transfer',
      entityId: transfer.id,
      metadata: {
        outcome: body.outcome,
        providerEventId: result.providerEventId,
        replayed: result.replayed,
        status: result.status,
      },
      ...requestMeta(req),
    });
    return {
      providerEventId: result.providerEventId,
      replayed: result.replayed,
      status: result.status,
      outcome: result.outcome,
      transfer: toTransferDto(result.transfer, this.transfers.viewerFor(auth, result.transfer)),
      simulated: true,
    };
  }
}
