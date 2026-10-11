import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { globalRoleHas, type Permission } from '@dfn/shared';
import { DomainError } from '../domain-error';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import type { AuthContext } from '../auth-context';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const auth = context.switchToHttp().getRequest().auth as AuthContext | undefined;
    if (!auth) throw DomainError.forbidden();
    const ok = required.every((p) => globalRoleHas(auth.globalRole, p));
    if (!ok) throw DomainError.forbidden('Insufficient privileges');
    return true;
  }
}
