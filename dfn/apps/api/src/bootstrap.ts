import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { SANDBOX_DISCLAIMER } from '@dfn/shared';
import { buildAppModule } from './app.module';
import { env, type Env } from './config/env';
import { installBigIntJson } from './common/serialize';

export async function createApp(envOverrides: Partial<Record<keyof Env, string>> = {}) {
  installBigIntJson();
  const AppModule = buildAppModule(envOverrides);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const cfg = env();
  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: cfg.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: cfg.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['x-dfn-mode', 'x-dfn-disclaimer'],
  });
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Diaspora Financial Network API — SANDBOX')
      .setDescription(
        `${SANDBOX_DISCLAIMER.fr} / ${SANDBOX_DISCLAIMER.en}.\n\nREST API of Diaspora Trust. Every amount is a fictitious amount handled by a simulated partner. ` +
          'Authentication: session cookie (httpOnly) obtained via /v1/auth/login. Errors follow { statusCode, code, message, details }.',
      )
      .setVersion('0.1.0-sandbox')
      .addCookieAuth(cfg.SESSION_COOKIE_NAME)
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { customSiteTitle: 'DFN API (sandbox)' });
  return { app, document };
}
