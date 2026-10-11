import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { LedgerService, providerSettlementCode } from '@dfn/financial-ledger';
import {
  Permission,
  parseDecimalToMinor,
  sandboxDepositSchema,
  sandboxFundingConfirmationSchema,
  type SandboxFundingConfirmationInput,
} from '@dfn/shared';
import { isStaff, type AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { DomainError } from '../../common/domain-error';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestMeta } from '../../common/request-meta';
import { AuditService } from '../audit/audit.service';
import { LEDGER } from '../ledger/ledger.provider';
import { WalletsService } from '../ledger/wallets.service';
import { PaymentsService } from '../payments/payments.service';
import { TransactionAccessService } from '../transactions/transaction-access.service';

/**
 * Simulated licensed partner. These endpoints stand in for the partner's webhooks and
 * back-office. They exist only in sandbox mode (the API refuses to boot otherwise).
 */
@ApiTags('sandbox')
@Controller('v1/sandbox')
export class SandboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly wallets: WalletsService,
    private readonly access: TransactionAccessService,
    private readonly audit: AuditService,
    @Inject(LEDGER) private readonly ledger: LedgerService,
  ) {}

  /** The buyer (or staff) triggers the partner's "funds received" confirmation. */
  @HttpCode(200)
  @Post('partner/funding-events')
  async fundingEvent(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(sandboxFundingConfirmationSchema)) body: SandboxFundingConfirmationInput,
    @Req() req: Request,
  ) {
    const funding = await this.prisma.fundingRequest.findUnique({
      where: { reference: body.fundingReference },
    });
    if (!funding) throw DomainError.notFound('Funding request');
    const tx = await this.access.load(funding.transactionId);
    const role = this.access.roleFor(auth, tx);
    if (role !== 'BUYER' && !isStaff(auth)) throw DomainError.notFound('Funding request');
    const event = await this.payments.provider.simulateFundingEvent({
      fundingReference: body.fundingReference,
      outcome: body.outcome,
      externalRef: body.externalRef,
    });
    const result = await this.payments.handlePartnerEvent(event, auth.userId);
    await this.audit.log({
      actorUserId: auth.userId,
      action: 'sandbox.partner_funding_event',
      entityType: 'FundingRequest',
      entityId: funding.id,
      metadata: { outcome: body.outcome, ...result },
      ...requestMeta(req),
    });
    return { ...result, simulated: true };
  }

  /** Staff credits a simulated deposit to an organisation wallet (demo data only). */
  @RequirePermission(Permission.SANDBOX_PARTNER_SIMULATE)
  @HttpCode(200)
  @Post('wallets/deposit')
  async deposit(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(sandboxDepositSchema))
    body: { organizationId: string; currencyCode: string; amount: string; note?: string },
    @Req() req: Request,
  ) {
    const ccy = body.currencyCode.toUpperCase();
    const amountMinor = parseDecimalToMinor(body.amount, ccy);
    const wallet = await this.wallets.ensureWallet(body.organizationId, ccy);
    const posted = await this.ledger.post({
      idempotencyKey: `sandbox-deposit:${body.organizationId}:${ccy}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'DEPOSIT',
      description: `Sandbox deposit${body.note ? `: ${body.note}` : ''} (simulated)`,
      reference: body.organizationId,
      metadata: { simulated: true, by: auth.userId },
      entries: [
        {
          accountCode: providerSettlementCode(this.payments.provider.code, ccy),
          direction: 'DEBIT',
          amountMinor,
          currencyCode: ccy,
        },
        { accountId: wallet.ledgerAccountId, direction: 'CREDIT', amountMinor, currencyCode: ccy },
      ],
    });
    await this.audit.log({
      actorUserId: auth.userId,
      organizationId: body.organizationId,
      action: 'sandbox.wallet_deposit',
      entityType: 'Wallet',
      entityId: wallet.id,
      metadata: { amount: body.amount, currency: ccy, ledgerTransactionId: posted.id },
      ...requestMeta(req),
    });
    return { ledgerTransactionId: posted.id, simulated: true };
  }
}
