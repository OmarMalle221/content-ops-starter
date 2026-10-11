import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  businessOrganizationQuerySchema,
  cancelDocumentSchema,
  createInvoiceSchema,
  listBusinessDocumentsQuerySchema,
  recordInvoicePaymentSchema,
  updateInvoiceSchema,
  type BusinessOrganizationQuery,
  type CancelDocumentInput,
  type CreateInvoiceInput,
  type ListBusinessDocumentsQuery,
  type RecordInvoicePaymentInput,
} from '@dfn/shared';
import type { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { InvoicesService } from './invoices.service';

/**
 * Diaspora Business — invoices. Organisation scope comes from `organizationId` (body or query);
 * INVOICE_MANAGE is required for writes, TRANSACTION_READ for reads. SANDBOX: fictitious amounts.
 */
@ApiTags('business')
@Controller('v1')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('invoices')
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createInvoiceSchema)) body: CreateInvoiceInput,
    @Req() req: Request,
  ) {
    return this.invoices.create(auth, body, req);
  }

  @Get('invoices')
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listBusinessDocumentsQuerySchema)) query: ListBusinessDocumentsQuery,
  ) {
    return this.invoices.list(auth, query);
  }

  @Get('invoices.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="invoices-sandbox.csv"')
  csv(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(businessOrganizationQuerySchema)) query: BusinessOrganizationQuery,
  ) {
    return this.invoices.csv(auth, query.organizationId);
  }

  @Get('invoices/:id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(auth, id);
  }

  @Get('invoices/:id/document')
  document(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.document(auth, id);
  }

  @Patch('invoices/:id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateInvoiceSchema)) body: z.infer<typeof updateInvoiceSchema>,
    @Req() req: Request,
  ) {
    return this.invoices.update(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('invoices/:id/send')
  send(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.invoices.send(auth, id, req);
  }

  @Post('invoices/:id/payments')
  recordPayment(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(recordInvoicePaymentSchema)) body: RecordInvoicePaymentInput,
    @Req() req: Request,
  ) {
    return this.invoices.recordPayment(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('invoices/:id/cancel')
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelDocumentSchema)) body: CancelDocumentInput,
    @Req() req: Request,
  ) {
    return this.invoices.cancel(auth, id, body, req);
  }
}
