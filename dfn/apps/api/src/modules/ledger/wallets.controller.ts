import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  conversionEstimateSchema,
  walletEntriesQuerySchema,
  type ConversionEstimateInput,
  type WalletEntriesQuery,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('v1/wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  /** Indicative FX estimate (sandbox rates). Read-only — nothing is persisted. */
  @Post('estimate')
  @HttpCode(200)
  estimate(@Body(zodBody(conversionEstimateSchema)) body: ConversionEstimateInput) {
    return this.wallets.estimate(body);
  }

  @Get(':organizationId')
  balances(@CurrentUser() auth: AuthContext, @Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.wallets.balances(auth, organizationId);
  }

  @Get(':organizationId/summary')
  summary(@CurrentUser() auth: AuthContext, @Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.wallets.summary(auth, organizationId);
  }

  @Get(':organizationId/:currency/entries')
  entries(
    @CurrentUser() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('currency') currency: string,
    @Query(zodBody(walletEntriesQuerySchema)) q: WalletEntriesQuery,
  ) {
    const { page, pageSize, ...filter } = q;
    return this.wallets.entries(auth, organizationId, currency.toUpperCase(), page, pageSize, filter);
  }

  @Get(':organizationId/:currency/statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement-sandbox.csv"')
  statement(
    @CurrentUser() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('currency') currency: string,
    @Query(zodBody(walletEntriesQuerySchema)) q: WalletEntriesQuery,
  ) {
    const { page: _page, pageSize: _pageSize, ...filter } = q;
    return this.wallets.statementCsv(auth, organizationId, currency.toUpperCase(), filter);
  }
}
