import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  authorizeTransferSchema,
  cancelTransferSchema,
  createFxQuoteSchema,
  createTransferSchema,
  listTransfersQuerySchema,
  transferReceiptQuerySchema,
  type AuthorizeTransferInput,
  type CreateFxQuoteInput,
  type CreateTransferInput,
  type ListTransfersQuery,
  type TransferReceiptQuery,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { FxQuotesService } from './fx-quotes.service';
import { TransfersService } from './transfers.service';

/** Diaspora Transfer — member-facing routes (organisation scope, 404 across tenants). */
@ApiTags('transfers')
@Controller('v1/transfers')
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly quotes: FxQuotesService,
  ) {}

  // Quotes are declared first so that `quotes` is never captured by the `:id` routes.
  @Post('quotes')
  createQuote(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createFxQuoteSchema)) body: CreateFxQuoteInput,
    @Req() req: Request,
  ) {
    return this.quotes.create(auth, body, req);
  }

  @Get('quotes/:id')
  getQuote(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotes.get(auth, id);
  }

  @Post()
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createTransferSchema)) body: CreateTransferInput,
    @Req() req: Request,
  ) {
    return this.transfers.create(auth, body, req);
  }

  @Get()
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listTransfersQuerySchema)) query: ListTransfersQuery,
  ) {
    return this.transfers.list(auth, query);
  }

  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(auth, id);
  }

  @Get(':id/receipt')
  @Header('x-dfn-disclaimer', 'Simulated receipt - no real funds')
  async receipt(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(transferReceiptQuerySchema)) query: TransferReceiptQuery,
    @Res({ passthrough: true }) res: Response,
  ) {
    const receipt = await this.transfers.receipt(auth, id, query.format);
    if (query.format === 'txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transfer-${id}-SANDBOX.txt"`);
    }
    return receipt;
  }

  @HttpCode(200)
  @Post(':id/authorize')
  authorize(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(authorizeTransferSchema)) body: AuthorizeTransferInput,
    @Req() req: Request,
  ) {
    return this.transfers.authorize(auth, id, body, req);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(cancelTransferSchema)) body: { reason: string },
    @Req() req: Request,
  ) {
    return this.transfers.cancel(auth, id, body.reason, req);
  }
}
