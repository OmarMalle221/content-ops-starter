import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  acceptInvitationSchema,
  acceptTermsSchema,
  approveMilestoneSchema,
  cancelTransactionSchema,
  createTransactionSchema,
  fundingRequestSchema,
  listTransactionsQuerySchema,
  requestChangesSchema,
  submitMilestoneSchema,
  type CreateTransactionInput,
  type FundingRequestInput,
  type ListTransactionsQuery,
  type SubmitMilestoneInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { MilestonesService } from './milestones.service';
import { TransactionsService } from './transactions.service';

@ApiTags('transactions')
@Controller('v1')
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly milestones: MilestonesService,
  ) {}

  @Post('transactions')
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createTransactionSchema)) body: CreateTransactionInput,
    @Req() req: Request,
  ) {
    return this.transactions.create(auth, body, req);
  }

  @Get('transactions')
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listTransactionsQuerySchema)) query: ListTransactionsQuery,
  ) {
    return this.transactions.list(auth, query);
  }

  @Get('transactions/:id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transactions.get(auth, id);
  }

  @Get('transactions/:id/events')
  events(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transactions.events_(auth, id);
  }

  @HttpCode(200)
  @Post('transactions/:id/invitation/resend')
  resend(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.transactions.resendInvitation(auth, id, req);
  }

  @Public()
  @Get('invitations/:token')
  invitation(@Param('token') token: string) {
    return this.transactions.getInvitation(token);
  }

  @HttpCode(200)
  @Post('invitations/accept')
  accept(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(acceptInvitationSchema)) body: { token: string; organizationId?: string },
    @Req() req: Request,
  ) {
    return this.transactions.acceptInvitation(body.token, auth, req, body.organizationId);
  }

  @HttpCode(200)
  @Post('invitations/decline')
  decline(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(acceptInvitationSchema)) body: { token: string },
    @Req() req: Request,
  ) {
    return this.transactions.declineInvitation(body.token, auth, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/accept-terms')
  acceptTerms(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(acceptTermsSchema)) body: { contractVersionId: string },
    @Req() req: Request,
  ) {
    return this.transactions.acceptTerms(auth, id, body.contractVersionId, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/cancel')
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelTransactionSchema)) body: { reason: string },
    @Req() req: Request,
  ) {
    return this.transactions.cancel(auth, id, body.reason, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/funding/request')
  requestFunding(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(fundingRequestSchema)) body: FundingRequestInput,
    @Req() req: Request,
  ) {
    return this.transactions.requestFunding(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/milestones/:milestoneId/submit')
  submit(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body(zodBody(submitMilestoneSchema)) body: SubmitMilestoneInput,
    @Req() req: Request,
  ) {
    return this.milestones.submit(auth, id, milestoneId, body, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/milestones/:milestoneId/approve')
  approve(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body(zodBody(approveMilestoneSchema)) body: { note?: string },
    @Req() req: Request,
  ) {
    return this.milestones.approve(auth, id, milestoneId, body.note, req);
  }

  @HttpCode(200)
  @Post('transactions/:id/milestones/:milestoneId/request-changes')
  requestChanges(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('milestoneId', ParseUUIDPipe) milestoneId: string,
    @Body(zodBody(requestChangesSchema)) body: { note: string },
    @Req() req: Request,
  ) {
    return this.milestones.requestChanges(auth, id, milestoneId, body.note, req);
  }
}
