import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  RequestMethod,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, from, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { Prisma } from '@dfn/database';
import { ApiPlatformErrorCode, IDEMPOTENCY_HEADER, idempotencyKeySchema } from '@dfn/shared';
import type { AuthContext } from '../../common/auth-context';
import { sha256Hex } from '../../common/crypto';
import { DomainError } from '../../common/domain-error';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ENV, type Env } from '../../config/env';
import { SKIP_IDEMPOTENCY } from './skip-idempotency.decorator';

const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
/** Marker status of a record whose original request is still being processed. */
const IN_FLIGHT = 0;

/** Stable fingerprint of a request: method + path + canonical JSON body. */
export function requestFingerprint(method: string, path: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value ?? null), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Wire-level copy of a response body (Dates → ISO strings, BigInt → strings), as the client saw it. */
function toStoredBody(body: unknown): Prisma.InputJsonValue {
  if (body === undefined || body === null) return {};
  return JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Idempotency-Key support for state-changing requests (API keys and sessions alike).
 *
 * - same key + same request fingerprint → the stored 2xx response is replayed with `Idempotent-Replayed: true`;
 * - same key + different fingerprint → 422 IDEMPOTENCY_KEY_REUSED;
 * - same key while the first request is still running → 409 IDEMPOTENCY_IN_PROGRESS;
 * - only 2xx responses are stored, for IDEMPOTENCY_TTL_HOURS; expired rows are purged by WEBHOOK_RETRY.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { auth?: AuthContext }>();
    const res = http.getResponse<Response>();
    const rawKey = req.headers[IDEMPOTENCY_HEADER];
    if (rawKey === undefined || !IDEMPOTENT_METHODS.has(req.method)) return next.handle();
    // Handlers that return a one-time secret are never stored (nor replayed).
    if (this.reflector.get<boolean | undefined>(SKIP_IDEMPOTENCY, context.getHandler())) return next.handle();

    const parsed = idempotencyKeySchema.safeParse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
    if (!parsed.success) {
      return throwError(() =>
        DomainError.validation('Invalid Idempotency-Key header (8 to 128 characters expected)', [
          { path: IDEMPOTENCY_HEADER, message: parsed.error.issues[0]?.message ?? 'Invalid' },
        ]),
      );
    }
    const auth = req.auth;
    if (!auth) return next.handle();
    const scopeKey = auth.apiCredential?.id ?? auth.userId;
    const idempotencyKey = parsed.data;
    const path = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    const requestHash = requestFingerprint(req.method, path, req.body);
    const successStatus = this.successStatus(context, req.method);

    return from(this.begin(scopeKey, idempotencyKey, req.method, path, requestHash)).pipe(
      mergeMap((state) => {
        if (state.kind === 'replay') {
          res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
          return of(state.body);
        }
        return next.handle().pipe(
          mergeMap((body) =>
            from(this.complete(scopeKey, idempotencyKey, successStatus, body)).pipe(mergeMap(() => of(body))),
          ),
          catchError((err) =>
            from(this.release(scopeKey, idempotencyKey)).pipe(mergeMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  /** The status NestJS will apply to a successful response (HttpCode metadata or the method default). */
  private successStatus(context: ExecutionContext, method: string): number {
    const explicit = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (explicit) return explicit;
    return method.toUpperCase() === RequestMethod[RequestMethod.POST] ? HttpStatus.CREATED : HttpStatus.OK;
  }

  private async begin(
    scopeKey: string,
    idempotencyKey: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<{ kind: 'proceed' } | { kind: 'replay'; body: unknown }> {
    const where = { scopeKey_idempotencyKey: { scopeKey, idempotencyKey } };
    const existing = await this.prisma.idempotencyRecord.findUnique({ where });
    if (existing) {
      if (existing.expiresAt <= new Date() && existing.statusCode !== IN_FLIGHT) {
        await this.prisma.idempotencyRecord.deleteMany({ where: { id: existing.id } });
      } else {
        if (existing.requestHash !== requestHash) {
          throw new DomainError(
            ApiPlatformErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This Idempotency-Key was already used with a different request',
            HttpStatus.UNPROCESSABLE_ENTITY,
            { method: existing.method, path: existing.path },
          );
        }
        if (existing.statusCode === IN_FLIGHT) throw this.inProgress();
        return { kind: 'replay', body: existing.responseBody };
      }
    }
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scopeKey,
          idempotencyKey,
          method,
          path,
          requestHash,
          statusCode: IN_FLIGHT,
          responseBody: {},
          expiresAt: new Date(Date.now() + this.env.IDEMPOTENCY_TTL_HOURS * 3_600_000),
        },
      });
    } catch (err) {
      // Unique violation: a concurrent request with the same key won the race.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw this.inProgress();
      throw err;
    }
    return { kind: 'proceed' };
  }

  private async complete(scopeKey: string, idempotencyKey: string, statusCode: number, body: unknown) {
    const where = { scopeKey_idempotencyKey: { scopeKey, idempotencyKey } };
    if (statusCode >= 200 && statusCode < 300) {
      await this.prisma.idempotencyRecord
        .update({ where, data: { statusCode, responseBody: toStoredBody(body) } })
        .catch((err: unknown) =>
          this.logger.warn(
            `idempotency record not stored: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    } else {
      await this.release(scopeKey, idempotencyKey);
    }
  }

  private async release(scopeKey: string, idempotencyKey: string) {
    await this.prisma.idempotencyRecord
      .deleteMany({ where: { scopeKey, idempotencyKey, statusCode: IN_FLIGHT } })
      .catch(() => undefined);
  }

  private inProgress() {
    return new DomainError(
      ApiPlatformErrorCode.IDEMPOTENCY_IN_PROGRESS,
      'A request with this Idempotency-Key is already being processed',
      HttpStatus.CONFLICT,
    );
  }
}
