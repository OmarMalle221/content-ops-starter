import {
  Body,
  Controller,
  Get,
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
  cancelDocumentSchema,
  convertQuoteSchema,
  createQuoteSchema,
  listBusinessDocumentsQuerySchema,
  quoteDecisionSchema,
  updateQuoteSchema,
  type CancelDocumentInput,
  type ConvertQuoteInput,
  type CreateQuoteInput,
  type ListBusinessDocumentsQuery,
  type QuoteDecisionInput,
} from '@dfn/shared';
import type { z } from 'zod';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { QuotesService } from './quotes.service';

/** Diaspora Business — quotes. Same scoping rules as invoices. SANDBOX: fictitious amounts. */
@ApiTags('business')
@Controller('v1')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Post('quotes')
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createQuoteSchema)) body: CreateQuoteInput,
    @Req() req: Request,
  ) {
    return this.quotes.create(auth, body, req);
  }

  @Get('quotes')
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listBusinessDocumentsQuerySchema)) query: ListBusinessDocumentsQuery,
  ) {
    return this.quotes.list(auth, query);
  }

  @Get('quotes/:id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.get(auth, id);
  }

  @Get('quotes/:id/document')
  document(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.document(auth, id);
  }

  @Patch('quotes/:id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateQuoteSchema)) body: z.infer<typeof updateQuoteSchema>,
    @Req() req: Request,
  ) {
    return this.quotes.update(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('quotes/:id/send')
  send(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.quotes.send(auth, id, req);
  }

  @HttpCode(200)
  @Post('quotes/:id/accept')
  accept(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(quoteDecisionSchema)) body: QuoteDecisionInput,
    @Req() req: Request,
  ) {
    return this.quotes.accept(auth, id, body, req);
  }

  @HttpCode(200)
  @Post('quotes/:id/decline')
  decline(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelDocumentSchema)) body: CancelDocumentInput,
    @Req() req: Request,
  ) {
    return this.quotes.decline(auth, id, body, req);
  }

  @Post('quotes/:id/convert')
  convert(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(convertQuoteSchema)) body: ConvertQuoteInput,
    @Req() req: Request,
  ) {
    return this.quotes.convert(auth, id, body, req);
  }
}
