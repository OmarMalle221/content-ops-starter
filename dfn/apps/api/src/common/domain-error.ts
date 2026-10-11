import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@dfn/shared';

/** Business rule violation carrying a stable code and HTTP status. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  static notFound(what = 'Resource') {
    return new DomainError(ErrorCode.NOT_FOUND, `${what} not found`, HttpStatus.NOT_FOUND);
  }
  static forbidden(message = 'You are not allowed to perform this action') {
    return new DomainError(ErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN);
  }
  static conflict(message: string, details?: unknown) {
    return new DomainError(ErrorCode.CONFLICT, message, HttpStatus.CONFLICT, details);
  }
  static invalidTransition(message: string, details?: unknown) {
    return new DomainError(ErrorCode.INVALID_TRANSITION, message, HttpStatus.CONFLICT, details);
  }
  static validation(message: string, details?: unknown) {
    return new DomainError(ErrorCode.VALIDATION_FAILED, message, HttpStatus.BAD_REQUEST, details);
  }
}
