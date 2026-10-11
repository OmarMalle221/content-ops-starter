import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  createCounterpartySchema,
  decideCounterpartyLinkSchema,
  listLinkRequestsQuerySchema,
  requestCounterpartyLinkSchema,
  revokeCounterpartyLinkSchema,
  type CreateCounterpartyInput,
  type DecideCounterpartyLinkInput,
  type ListLinkRequestsQuery,
  type RequestCounterpartyLinkInput,
  type RevokeCounterpartyLinkInput,
} from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { CounterpartiesService } from './counterparties.service';

/**
 * Client records (counterparties) and link consent. Requester side: /counterparties/…; target side:
 * /link-requests/…. SANDBOX: a link only enables fictitious wallet payments of invoices.
 */
@ApiTags('organizations')
@Controller('v1/organizations')
export class CounterpartiesController {
  constructor(private readonly counterparties: CounterpartiesService) {}

  @Get(':id/counterparties')
  list(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.counterparties.list(auth, id);
  }

  @Post(':id/counterparties')
  create(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(createCounterpartySchema)) body: CreateCounterpartyInput,
    @Req() req: Request,
  ) {
    return this.counterparties.create(auth, id, body, req);
  }

  @HttpCode(200)
  @Post(':id/counterparties/:counterpartyId/link/request')
  requestLink(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @Body(zodBody(requestCounterpartyLinkSchema)) body: RequestCounterpartyLinkInput,
    @Req() req: Request,
  ) {
    return this.counterparties.requestLink(auth, id, counterpartyId, body, req);
  }

  @HttpCode(200)
  @Post(':id/counterparties/:counterpartyId/link/revoke')
  revokeLink(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @Body(zodBody(revokeCounterpartyLinkSchema)) body: RevokeCounterpartyLinkInput,
    @Req() req: Request,
  ) {
    return this.counterparties.revokeLink(auth, id, counterpartyId, body, req);
  }

  @Get(':id/link-requests')
  linkRequests(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(listLinkRequestsQuerySchema)) query: ListLinkRequestsQuery,
  ) {
    return this.counterparties.listRequests(auth, id, query);
  }

  @HttpCode(200)
  @Post(':id/link-requests/:counterpartyId/accept')
  accept(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @Body(zodBody(decideCounterpartyLinkSchema)) body: DecideCounterpartyLinkInput,
    @Req() req: Request,
  ) {
    return this.counterparties.accept(auth, id, counterpartyId, body, req);
  }

  @HttpCode(200)
  @Post(':id/link-requests/:counterpartyId/decline')
  decline(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @Body(zodBody(decideCounterpartyLinkSchema)) body: DecideCounterpartyLinkInput,
    @Req() req: Request,
  ) {
    return this.counterparties.decline(auth, id, counterpartyId, body, req);
  }
}
