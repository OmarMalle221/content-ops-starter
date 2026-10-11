import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { OrganizationsModule } from '../organizations/organizations.module';
import { ApiAuthService } from './api-auth.service';
import { ApiCredentialsController } from './api-credentials.controller';
import { ApiCredentialsService } from './api-credentials.service';
import { ApiRequestLogInterceptor, ApiRequestLogService } from './api-request-log.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * ApiPlatformModule — Diaspora API: partner API keys ("clés sandbox"), scopes, per-key rate
 * limiting, request journal, Idempotency-Key support and signed outbound webhooks with retries.
 *
 * Global so that SessionAuthGuard (registered as APP_GUARD by AppModule) can inject
 * ApiAuthService and ApiRequestLogService. The two interceptors are registered as
 * APP_INTERCEPTOR from here: request journal first, then idempotency.
 */
@Global()
@Module({
  imports: [OrganizationsModule],
  controllers: [ApiCredentialsController, WebhooksController],
  providers: [
    ApiAuthService,
    ApiRequestLogService,
    ApiCredentialsService,
    WebhookDispatcherService,
    WebhooksService,
    { provide: APP_INTERCEPTOR, useClass: ApiRequestLogInterceptor },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [ApiAuthService, ApiRequestLogService, WebhookDispatcherService],
})
export class ApiPlatformModule {}
