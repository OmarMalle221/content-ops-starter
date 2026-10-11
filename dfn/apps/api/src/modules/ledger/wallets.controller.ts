import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { paginationSchema } from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { WalletsService } from './wallets.service';

@ApiTags('wallets')
@Controller('v1/wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get(':organizationId')
  balances(@CurrentUser() auth: AuthContext, @Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.wallets.balances(auth, organizationId);
  }

  @Get(':organizationId/:currency/entries')
  entries(
    @CurrentUser() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('currency') currency: string,
    @Query(zodBody(paginationSchema)) q: { page: number; pageSize: number },
  ) {
    return this.wallets.entries(auth, organizationId, currency.toUpperCase(), q.page, q.pageSize);
  }

  @Get(':organizationId/:currency/statement.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="statement-sandbox.csv"')
  statement(
    @CurrentUser() auth: AuthContext,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('currency') currency: string,
  ) {
    return this.wallets.statementCsv(auth, organizationId, currency.toUpperCase());
  }
}
