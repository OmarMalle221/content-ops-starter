import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '../auth-context';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest();
  return req.auth as AuthContext;
});
