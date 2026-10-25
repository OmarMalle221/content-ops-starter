import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { SANDBOX_DISCLAIMER, SANDBOX_HEADER, SANDBOX_MODE } from '@dfn/shared';
import { buildAppModule } from './app.module';
import { env, type Env } from './config/env';
import { installBigIntJson } from './common/serialize';

/**
 * TRUST_PROXY → Express "trust proxy" value: "true"/"false", a hop count ("1"), or a list of
 * addresses / subnets / Express names ("loopback, uniquelocal").
 */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function createApp(envOverrides: Partial<Record<keyof Env, string>> = {}) {
  installBigIntJson();
  const AppModule = buildAppModule(envOverrides);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const cfg = env();
  app.useLogger(app.get(Logger));
  app.set('trust proxy', parseTrustProxy(cfg.TRUST_PROXY));
  app.use(
    helmet({
      contentSecurityPolicy: cfg.NODE_ENV === 'production' ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  // Tag every response — including guard rejections (401/403/429) that never reach interceptors —
  // so no client can mistake the sandbox for a live environment.
  app.use((_req: unknown, res: { setHeader(name: string, value: string): void }, next: () => void) => {
    res.setHeader(SANDBOX_HEADER, SANDBOX_MODE);
    res.setHeader('x-dfn-disclaimer', 'Simulated data - no real funds');
    next();
  });
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
