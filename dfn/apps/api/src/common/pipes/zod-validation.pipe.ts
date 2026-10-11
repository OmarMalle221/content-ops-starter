import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ErrorCode } from '@dfn/shared';
import { DomainError } from '../domain-error';

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'Validation failed',
        HttpStatus.BAD_REQUEST,
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}

export const zodBody = <T>(schema: ZodSchema<T>) => new ZodValidationPipe(schema);
