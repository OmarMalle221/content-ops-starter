import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  Permission,
  appealDisputeSchema,
  disputeDecisionSchema,
  disputeMessageSchema,
  openDisputeSchema,
  requestRefundSchema,
  type DisputeDecisionInput,
  type DisputeMessageInput,
  type OpenDisputeInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DisputesService } from './disputes.service';

@ApiTags('disputes')
@Controller('v1')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post('transactions/:id/disputes')
  open(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(openDisputeSchema)) body: OpenDisputeInput,
    @Req() req: Request,
  ) {
    return this.disputes.open(auth, id, body, req);
  }

  @Post('transactions/:id/refund-request')
  refund(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(requestRefundSchema)) body: { reason: string },
    @Req() req: Request,
  ) {
    return this.disputes.open(
      auth,
      id,
      { reason: 'PAYMENT_ISSUE', description: body.reason, documentIds: [] },
      req,
      'REFUND_REQUEST',
    );
  }

  @Get('disputes')
  list(@CurrentUser() auth: AuthContext, @Query('status') status?: string) {
    return this.disputes.listMine(auth, status || undefined);
  }

  @Get('disputes/:id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.get(auth, id);
  }

  @Post('disputes/:id/messages')
  message(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(disputeMessageSchema)) body: DisputeMessageInput,
    @Req() req: Request,
  ) {
    return this.disputes.addMessage(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('disputes/:id/appeal')
  appeal(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(appealDisputeSchema)) body: { grounds: string },
    @Req() req: Request,
  ) {
    return this.disputes.appeal(auth, id, body.grounds, req);
  }

  @RequirePermission(Permission.ADMIN_DISPUTES)
  @HttpCode(200)
  @Post('disputes/:id/review')
  review(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.disputes.startReview(auth, id, req);
  }

  @RequirePermission(Permission.ADMIN_DISPUTES)
  @HttpCode(200)
  @Post('disputes/:id/decide')
  decide(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(disputeDecisionSchema)) body: DisputeDecisionInput,
    @Req() req: Request,
  ) {
    return this.disputes.decide(auth, id, body, req);
  }

  @RequirePermission(Permission.ADMIN_DISPUTES)
  @HttpCode(200)
  @Post('disputes/:id/close')
  close(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(z.object({ note: z.string().trim().min(3).max(1000) }))) body: { note: string },
    @Req() req: Request,
  ) {
    return this.disputes.close(auth, id, body.note, req);
  }
}
