import {
  Body,
  Controller,
  Delete,
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
  createWebhookRequestSchema,
  listWebhooksQuerySchema,
  sendTestWebhookSchema,
  updateWebhookSchema,
  webhookDeliveriesQuerySchema,
  type CreateWebhookRequest,
  type ListWebhooksQuery,
  type SendTestWebhookInput,
  type UpdateWebhookInput,
  type WebhookDeliveriesQuery,
} from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { SkipIdempotency } from './skip-idempotency.decorator';
import { WebhooksService } from './webhooks.service';

/**
 * Signed outbound webhooks (sandbox events only). The signing secret is returned once at
 * creation and at each rotation; deliveries and retries are visible per subscription.
 */
@ApiTags('api-platform')
@Controller('v1/webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get()
  list(@CurrentUser() auth: AuthContext, @Query(zodBody(listWebhooksQuerySchema)) q: ListWebhooksQuery) {
    return this.webhooks.list(auth, q);
  }

  @Post()
  @HttpCode(201)
  @SkipIdempotency()
  create(
    @CurrentUser() auth: AuthContext,
    @Body(zodBody(createWebhookRequestSchema)) body: CreateWebhookRequest,
    @Req() req: Request,
  ) {
    return this.webhooks.create(auth, body, req);
  }

  @Get(':id')
  get(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.get(auth, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateWebhookSchema)) body: UpdateWebhookInput,
    @Req() req: Request,
  ) {
    return this.webhooks.update(auth, id, body, req);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.webhooks.remove(auth, id, req);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @SkipIdempotency()
  rotateSecret(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.webhooks.rotateSecret(auth, id, req);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(sendTestWebhookSchema)) body: SendTestWebhookInput,
    @Req() req: Request,
  ) {
    return this.webhooks.sendTest(auth, id, body, req);
  }

  @Get(':id/deliveries')
  deliveries(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(zodBody(webhookDeliveriesQuerySchema)) q: WebhookDeliveriesQuery,
  ) {
    return this.webhooks.deliveries(auth, id, q);
  }

  @Post(':id/deliveries/:deliveryId/retry')
  @HttpCode(200)
  retry(
    @CurrentUser() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Req() req: Request,
  ) {
    return this.webhooks.retryDelivery(auth, id, deliveryId, req);
  }
}
