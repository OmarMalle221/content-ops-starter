import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode, InvalidTransitionError, type ApiErrorBody } from '@dfn/shared';
import { LedgerError } from '@dfn/financial-ledger';
import { Prisma } from '@dfn/database';
import { DomainError } from '../domain-error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const body = this.toBody(exception);
    body.requestId = (req as any).id ?? req.headers['x-request-id']?.toString();
    if (body.statusCode >= 500) {
      this.logger.error(`${req.method} ${req.url} → ${body.statusCode}`, (exception as Error)?.stack);
    }
    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof DomainError) {
      return {
        statusCode: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof InvalidTransitionError) {
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ErrorCode.INVALID_TRANSITION,
        message: exception.message,
        details: { entity: exception.entity, from: exception.from, to: exception.to },
      };
    }
    if (exception instanceof LedgerError) {
      const status =
        exception.code === 'INSUFFICIENT_FUNDS' || exception.code === 'LEDGER_UNBALANCED'
          ? HttpStatus.CONFLICT
          : HttpStatus.UNPROCESSABLE_ENTITY;
      return {
        statusCode: status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse() as any;
      const message = typeof response === 'string' ? response : (response?.message ?? exception.message);
      const code =
        typeof response === 'object' && response?.code
          ? response.code
          : status === 401
            ? ErrorCode.UNAUTHENTICATED
            : status === 403
              ? ErrorCode.FORBIDDEN
              : status === 404
                ? ErrorCode.NOT_FOUND
                : status === 429
                  ? ErrorCode.RATE_LIMITED
                  : status === 400
                    ? ErrorCode.VALIDATION_FAILED
                    : 'HTTP_ERROR';
      return {
        statusCode: status,
        code,
        message: Array.isArray(message) ? message.join('; ') : String(message),
        details: typeof response === 'object' ? response?.details : undefined,
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          statusCode: HttpStatus.CONFLICT,
          code: ErrorCode.CONFLICT,
          message: 'Resource already exists',
        };
      }
      if (exception.code === 'P2025') {
        return { statusCode: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, message: 'Resource not found' };
      }
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }
}
