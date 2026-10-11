import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { reportQuerySchema, type ReportQuery } from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ReportsService } from './reports.service';

/** Organisation reports (ORG_VIEW_REPORTS). Every figure is fictitious — sandbox only. */
@ApiTags('business')
@Controller('v1/organizations/:id/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(reportQuerySchema)) query: ReportQuery,
  ) {
    return this.reports.summary(auth, id, query);
  }

  @Get('transactions.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="transactions-sandbox.csv"')
  transactionsCsv(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(reportQuerySchema)) query: ReportQuery,
  ) {
    return this.reports.transactionsCsv(auth, id, query);
  }

  @Get('invoices.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="invoices-sandbox.csv"')
  invoicesCsv(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.invoicesCsv(auth, id);
  }

  @Get('commissions')
  commissions(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(reportQuerySchema)) query: ReportQuery,
  ) {
    return this.reports.commissions(auth, id, query);
  }
}
