import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { loadEnv, type Env } from './config/env';
import { EnvModule } from './config/env.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisConnectionService, RedisModule } from './common/redis';
import { RedisThrottlerStorage } from './common/throttler';
import { DomainEventsModule } from './common/events/domain-events';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { SessionAuthGuard } from './common/guards/session-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { OriginCheckMiddleware } from './common/middleware/origin-check.middleware';
import { SandboxHeaderInterceptor } from './common/interceptors/sandbox-header.interceptor';
import { AuditModule } from './modules/audit/audit.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RiskModule } from './modules/risk/risk.module';
import { ReferenceModule } from './modules/reference/reference.module';
import { ReferenceController } from './modules/reference/reference.controller';
import { HealthController } from './modules/health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { VerificationsModule } from './modules/verifications/verifications.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { AdminModule } from './modules/admin/admin.module';
import { SandboxModule } from './modules/sandbox/sandbox.module';
import { TransfersModule } from './modules/transfers/transfers.module';
import { BusinessModule } from './modules/business/business.module';
import { ApiPlatformModule } from './modules/api-platform/api-platform.module';
import { DdaModule } from './modules/dda/dda.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { GatesModule } from './modules/gates/gates.module';
import { KeysModule } from './modules/keys/keys.module';

export function buildAppModule(envOverrides: Partial<Record<keyof Env, string>> = {}) {
  const env = loadEnv(envOverrides);

  @Module({
    imports: [
      EnvModule.forRoot(env),
      LoggerModule.forRoot({
        pinoHttp: {
          level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
          transport:
            env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              '*.password',
              '*.passwordHash',
              '*.token',
              '*.secret',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: env.NODE_ENV !== 'test',
          genReqId: (req) => (req.headers['x-request-id'] as string) ?? crypto.randomUUID(),
        },
      }),
      ThrottlerModule.forRootAsync({
        imports: [RedisModule],
        inject: [RedisConnectionService],
        useFactory: (redis: RedisConnectionService) => ({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
          skipIf: () => env.NODE_ENV === 'test',
          // RATE_LIMIT_STORE=redis: the per-IP throttle is shared by every replica (keys dfn:rl:throttler:*);
          // memory (default): @nestjs/throttler's in-process storage.
          storage: env.RATE_LIMIT_STORE === 'redis' ? new RedisThrottlerStorage(redis) : undefined,
        }),
      }),
      PrismaModule,
      DomainEventsModule,
      AuditModule,
      NotificationsModule,
      RiskModule,
      ReferenceModule,
      AuthModule,
      UsersModule,
      OrganizationsModule,
      VerificationsModule,
      LedgerModule,
      PaymentsModule,
      TransactionsModule,
      DocumentsModule,
      DisputesModule,
      AdminModule,
      SandboxModule,
      TransfersModule,
      BusinessModule,
      ApiPlatformModule,
      DdaModule,
      JobsModule,
      GatesModule,
      KeysModule,
    ],
    controllers: [HealthController, ReferenceController],
    providers: [
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
      { provide: APP_INTERCEPTOR, useClass: SandboxHeaderInterceptor },
      { provide: APP_GUARD, useClass: ThrottlerGuard },
      { provide: APP_GUARD, useClass: SessionAuthGuard },
      { provide: APP_GUARD, useClass: PermissionsGuard },
    ],
  })
  class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(OriginCheckMiddleware).forRoutes('*path');
    }
  }
  return AppModule;
}
