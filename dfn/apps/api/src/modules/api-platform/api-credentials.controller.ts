import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ALL_API_SCOPES,
  ALL_WEBHOOK_EVENTS,
  apiRequestLogsQuerySchema,
  createApiCredentialRequestSchema,
  listApiCredentialsQuerySchema,
  type ApiRequestLogsQuery,
  type CreateApiCredentialRequest,
  type ListApiCredentialsQuery,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { SkipIdempotency } from './skip-idempotency.decorator';
import { ApiCredentialsService } from './api-credentials.service';
import { SCOPE_DESCRIPTIONS } from './api-scopes';

/**
 * Sandbox API keys of an organisation. The clear key is returned exactly once (creation,
 * rotation); afterwards only the prefix is visible. Other tenants' keys → 404.
 */
@ApiTags('api-platform')
@Controller('v1/api-credentials')
export class ApiCredentialsController {
  constructor(private readonly credentials: ApiCredentialsService) {}

  /** Scope catalogue and event list for the developer console (sessions only, no tenant data). */
  @Get('catalog')
  catalog() {
    return {
      sandbox: true,
      keyPrefix: 'dfn_sk_',
      scopes: ALL_API_SCOPES.map((scope) => ({ scope, description: SCOPE_DESCRIPTIONS[scope] })),
      webhookEvents: ALL_WEBHOOK_EVENTS,
      docsPath: 'docs/api/PARTNERS.md',
    };
  }

  @Get()
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(listApiCredentialsQuerySchema)) q: ListApiCredentialsQuery,
  ) {
    return this.credentials.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  @SkipIdempotency()
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createApiCredentialRequestSchema)) body: CreateApiCredentialRequest,
    @Req() req: Request,
  ) {
    return this.credentials.create(auth, body, req);
  }

  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.credentials.get(auth, id);
  }

  @Post(':id/rotate')
  @HttpCode(201)
  @SkipIdempotency()
  rotate(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.credentials.rotate(auth, id, req);
  }

  @Delete(':id')
  @HttpCode(200)
  revoke(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.credentials.revoke(auth, id, req);
  }

  @Get(':id/logs')
  logs(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(apiRequestLogsQuerySchema)) q: ApiRequestLogsQuery,
  ) {
    return this.credentials.logs(auth, id, q);
  }
}
